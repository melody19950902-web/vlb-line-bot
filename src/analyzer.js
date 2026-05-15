'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getSopSettings, getTaskTimeRules, getDayTypeRules } = require('./sheets');

// ============================================================
// 有效工作類型清單（用於全格式日誌驗證）
// ============================================================
const VALID_DAY_TYPES = [
  '正常日', '外拍日', '直播日',
  '外拍半天', '外拍一天',
  '大型活動日（短影音組）',
  '大型活動日（限動組）',
  '大型活動日（拍照修片組）',
];

// ============================================================
// 時間工具
// ============================================================

function timeToMinutes(str) {
  const normalized = str.replace('：', ':');
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

function durationMinutes(start, end) {
  return timeToMinutes(end) - timeToMinutes(start);
}

// ============================================================
// 從時間記錄條目的任務描述中偵測限動數量
// 例：「直播相關限動 2 則」→ 2
// ============================================================
function extractLimitedStoryCount(entries) {
  let total = 0;
  for (const entry of entries) {
    // 匹配「限動 X 則」或「限時動態 X 則」或「限動X則」等格式
    const m = entry.task.match(/限[動時][動態]?\s*(\d+)\s*則/);
    if (m) total += parseInt(m[1]);
  }
  return total;
}

// ============================================================
// 解析完整工作日誌格式
// ============================================================
function parseWorkLog(text) {
  if (!text || typeof text !== 'string') {
    return { error: '訊息內容為空' };
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/：/g, ':').trim();

  // --- 今日類型 ---
  const typeMatch = normalized.match(/今日類型:\s*(.+)/);
  if (!typeMatch) return { error: '缺少「今日類型」欄位' };
  const dayType = typeMatch[1].trim();

  if (!VALID_DAY_TYPES.includes(dayType)) {
    return {
      error: `「今日類型」填寫有誤（填入：${dayType}）\n` +
             `可填：正常日、外拍日、直播日、外拍半天、外拍一天、\n` +
             `大型活動日（短影音組）、大型活動日（限動組）、大型活動日（拍照修片組）`,
    };
  }

  // --- 影片數量 ---
  const videoMatch = normalized.match(/影片數量:\s*(\d+)/);
  if (!videoMatch) return { error: '缺少「影片數量」欄位，或數量非數字' };
  const videoCount = parseInt(videoMatch[1]);

  // --- 時間記錄 ---
  const timeLogMatch = normalized.match(/時間記錄:\s*\n([\s\S]+?)(?=備註:|$)/);
  if (!timeLogMatch) return { error: '缺少「時間記錄」欄位' };
  const timeLogRaw = timeLogMatch[1].trim();

  const timeEntries = [];
  const linePattern = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s+(.+)/g;
  let m;
  while ((m = linePattern.exec(timeLogRaw)) !== null) {
    const startTime = m[1];
    const endTime   = m[2];
    const task      = m[3].trim();
    const duration  = durationMinutes(startTime, endTime);
    if (duration > 0) {
      timeEntries.push({ startTime, endTime, task, duration });
    }
  }

  if (timeEntries.length === 0) {
    return { error: '時間記錄格式有誤，請使用「09:00-10:30 任務名稱」格式，每條記錄佔一行' };
  }

  // --- 備註（選填）---
  const notesMatch = normalized.match(/備註:\s*(.+)/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  // --- 計算總工時 ---
  const totalMinutes = timeEntries.reduce((sum, e) => sum + e.duration, 0);
  const totalHours   = Math.round(totalMinutes / 6) / 10;

  // --- 空白時段（排除午休 12:00–13:00）---
  const gaps = [];
  for (let i = 1; i < timeEntries.length; i++) {
    const prevEndMin   = timeToMinutes(timeEntries[i - 1].endTime);
    const currStartMin = timeToMinutes(timeEntries[i].startTime);
    const gapMin = currStartMin - prevEndMin;
    if (gapMin <= 0) continue;
    const isLunchBreak = prevEndMin >= 720 && currStartMin <= 780;
    if (!isLunchBreak) {
      gaps.push({ from: timeEntries[i - 1].endTime, to: timeEntries[i].startTime, minutes: gapMin });
    }
  }

  // --- 從時間記錄自動偵測限動數量 ---
  const limitedStoryCount = extractLimitedStoryCount(timeEntries);

  return { dayType, videoCount, timeEntries, timeLogRaw, totalMinutes, totalHours, gaps, notes, limitedStoryCount };
}

// ============================================================
// 特殊工作日簡短格式（無時間記錄，直接存為正常狀態）
// 格式例：外拍半天、活動外拍｜限動組、課程拍攝 3 小時
// ============================================================

// 判斷是否為特殊工作日格式
function detectSpecialDayType(text) {
  if (!text) return null;
  const t = text.trim();

  // 外拍半天 / 外拍一天
  if (t === '外拍半天') return { dayType: '外拍半天', hours: null };
  if (t === '外拍一天') return { dayType: '外拍一天', hours: null };

  // 課程拍攝 X 小時（選填時間區間）
  const courseMatch = t.match(/^課程拍攝\s*(\d+)\s*小時/);
  if (courseMatch) return { dayType: `課程拍攝 ${courseMatch[1]} 小時`, hours: parseInt(courseMatch[1]) };

  // 直播 X 小時（選填時間區間）
  const liveMatch = t.match(/^直播\s*(\d+)\s*小時/);
  if (liveMatch) return { dayType: `直播 ${liveMatch[1]} 小時`, hours: parseInt(liveMatch[1]) };

  // 活動外拍｜XXX組 / 課程拍攝｜XXX組
  const eventMatch = t.match(/^(活動外拍|課程拍攝)｜(.+)/);
  if (eventMatch) return { dayType: `${eventMatch[1]}｜${eventMatch[2]}`, hours: null };

  return null;
}

// ============================================================
// Claude 系統提示
// ============================================================

async function buildSystemPrompt() {
  const [sopSettings, taskTimeRules, dayTypeRules] = await Promise.all([
    getSopSettings(),
    getTaskTimeRules(),
    getDayTypeRules(),
  ]);

  const minHours = sopSettings['最低工時_小時'] || '6';
  const maxGap   = sopSettings['空白時段上限_分'] || '60';

  const dayTypeText = dayTypeRules
    .map(r => `- ${r.工作類型}：最低 ${r.最低影片數} 支影片`)
    .join('\n');

  const taskTimeText = taskTimeRules
    .map(r =>
      `- 含「${r.任務關鍵字}」的任務：正常範圍 ${r.最短時間_分}–${r.合理最長_分} 分鐘，超過 ${r.異常上限_分} 分鐘為異常`
    )
    .join('\n');

  return `你是 VLB/漢芳療 設計部的工作查核助理，負責分析社群小編每日工作日誌。
請依照以下規則判斷，只回傳 JSON，不要有任何其他文字或 markdown。

【查核基準】
- 正常日最低工時：${minHours} 小時
- 空白時段上限：${maxGap} 分鐘（中午 12:00–13:00 的空白不算）
- 彈性工時規則：Bot 不判斷幾點開始上班，只計算時間記錄的總工時是否達到標準

【各工作類型最低影片數】
${dayTypeText}
- 大型活動日（限動組）：查核限動數量，活動日須有 3–5 則限時動態
- 大型活動日（拍照修片組）：查核照片產出，基本要求：大合照 1 張、現場照+老師照合計 3–5 張

【各任務合理時間範圍（依任務名稱中的關鍵字判斷）】
${taskTimeText}

【判斷邏輯】
- status 為 "alert"：影片數量低於該日標準，或任何任務超過異常時間上限
- status 為 "warning"：總工時不足，或空白時段過長，但影片數量達標
- status 為 "normal"：所有項目均符合標準

【回傳格式（嚴格 JSON，不含 markdown）】
{
  "status": "normal 或 warning 或 alert",
  "video_count_ok": true 或 false,
  "time_log_ok": true 或 false,
  "total_hours": 數字,
  "anomalies": ["繁體中文異常說明1", "繁體中文異常說明2"],
  "summary": "一句話整體評估（繁體中文）"
}`;
}

// ============================================================
// Claude 分析
// ============================================================

async function analyzeWorkLog(parsedLog, memberName) {
  const logText = [
    `小編姓名：${memberName}`,
    `今日類型：${parsedLog.dayType}`,
    `影片數量：${parsedLog.videoCount} 支`,
    `限時動態數量：${parsedLog.limitedStoryCount || 0} 則`,
    `總工時：${parsedLog.totalHours} 小時（${parsedLog.totalMinutes} 分鐘）`,
    ``,
    `時間記錄明細：`,
    ...parsedLog.timeEntries.map(e =>
      `  ${e.startTime}–${e.endTime}（${e.duration} 分鐘）：${e.task}`
    ),
    ``,
    `空白時段（非午休）：`,
    parsedLog.gaps.length === 0
      ? '  無'
      : parsedLog.gaps.map(g => `  ${g.from}–${g.to}（${g.minutes} 分鐘）`).join('\n'),
    ``,
    `備註：${parsedLog.notes || '（無）'}`,
  ].join('\n');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const systemPrompt = await buildSystemPrompt();
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: logText }],
    });
    const raw = message.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude 未回傳有效 JSON');
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Claude 分析失敗，改用本地備援分析：', err.message);
    return await localFallbackAnalysis(parsedLog);
  }
}

// ============================================================
// 本地備援分析
// ============================================================

async function localFallbackAnalysis(parsedLog) {
  const [sopSettings, taskTimeRules, dayTypeRules] = await Promise.all([
    getSopSettings(),
    getTaskTimeRules(),
    getDayTypeRules(),
  ]);

  const anomalies = [];
  const minHours  = parseFloat(sopSettings['最低工時_小時'] || '6');
  const maxGapMin = parseInt(sopSettings['空白時段上限_分'] || '60');

  if (parsedLog.totalHours < minHours) {
    anomalies.push(`總工時 ${parsedLog.totalHours} 小時，低於標準 ${minHours} 小時`);
  }

  const dayRule   = dayTypeRules.find(r => r.工作類型 === parsedLog.dayType);
  const minVideos = dayRule ? dayRule.最低影片數 : 3;
  const videoOk   = parsedLog.videoCount >= minVideos;
  if (!videoOk) {
    anomalies.push(`影片數量 ${parsedLog.videoCount} 支，低於 ${parsedLog.dayType} 標準（${minVideos} 支）`);
  }

  for (const entry of parsedLog.timeEntries) {
    const rule = taskTimeRules.find(r => entry.task.includes(r.任務關鍵字));
    if (rule && entry.duration > rule.異常上限_分) {
      anomalies.push(`「${entry.task}」記錄 ${entry.duration} 分鐘，超過異常上限（${rule.異常上限_分} 分鐘）`);
    }
  }

  for (const gap of parsedLog.gaps) {
    if (gap.minutes > maxGapMin) {
      anomalies.push(`${gap.from}–${gap.to} 有 ${gap.minutes} 分鐘空白，超過上限（${maxGapMin} 分鐘）`);
    }
  }

  const timeOk = !anomalies.some(a => a.includes('空白') || a.includes('超過異常') || a.includes('工時'));
  const status = !videoOk ? 'alert' : (anomalies.length > 0 ? 'warning' : 'normal');

  return {
    status,
    video_count_ok: videoOk,
    time_log_ok:    timeOk,
    total_hours:    parsedLog.totalHours,
    anomalies,
    summary: status === 'normal' ? '工作記錄正常' : `發現 ${anomalies.length} 項異常`,
  };
}

module.exports = { parseWorkLog, analyzeWorkLog, detectSpecialDayType, VALID_DAY_TYPES };
