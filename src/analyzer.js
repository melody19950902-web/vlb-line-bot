'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getSopSettings, getTaskTimeRules, getDayTypeRules } = require('./sheets');

// ============================================================
// 有效工作類型清單
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

// 計算與午休 12:00–13:00 的重疊分鐘數（修正四）
function lunchOverlapMinutes(startMin, endMin) {
  return Math.max(0, Math.min(endMin, 780) - Math.max(startMin, 720));
}

// ============================================================
// 限動數量偵測
// ============================================================
function extractLimitedStoryCount(entries) {
  let total = 0;
  for (const entry of entries) {
    const m = entry.task.match(/限[動時][動態]?\s*(\d+)\s*則/);
    if (m) total += parseInt(m[1]);
  }
  return total;
}

// ============================================================
// 批量剪輯：從任務描述中抓支數（修正五）
// 例：「剪片 3 支」「剪輯 2 支」「短影音剪 4 支」
// ============================================================
function parseBatchCount(task) {
  const m = task.match(/(?:剪[片輯了編]|短影音剪)\s*(\d+)\s*支/);
  return m ? parseInt(m[1]) : null;
}

// ============================================================
// 發布工時解析（修正一）
// 支援新格式：已發布｜IG｜薇安職場女人說
// 支援舊格式：第一更 IG、Threads、FB 發布完成
//            《薇安的職場女人說》第一更 IG Threads FB 發布完成
//            多次發布至 IG、Threads、FB、LinkedIn 各平台
// 每平台 9 分鐘
// ============================================================
const PLATFORM_KEYWORDS = ['IG', 'Instagram', 'Threads', 'FB', 'Facebook', 'LinkedIn', 'YouTube', 'YT', 'TikTok'];

function countPlatforms(text) {
  const found = new Set();
  for (const p of PLATFORM_KEYWORDS) {
    if (text.includes(p)) {
      const key = p === 'Instagram' ? 'IG' : p === 'Facebook' ? 'FB' : p;
      found.add(key);
    }
  }
  return found.size;
}

function parsePublishMinutes(timeLogRaw) {
  let totalPlatforms = 0;
  for (const line of timeLogRaw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^\d{1,2}[：:]\d{2}\s*[-–—]/.test(t)) continue; // 跳過時間段行
    if (/發布|已發布/.test(t)) {
      totalPlatforms += countPlatforms(t);
    }
  }
  return totalPlatforms * 9;
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
    const rawDuration = durationMinutes(startTime, endTime);
    if (rawDuration <= 0) continue;

    const startMin = timeToMinutes(startTime);
    const endMin   = timeToMinutes(endTime);
    // 修正四：每個時間段自動扣除與午休的重疊
    const effectiveMins = rawDuration - lunchOverlapMinutes(startMin, endMin);
    // 修正五：批量剪輯支數
    const batchCount = parseBatchCount(task);

    timeEntries.push({ startTime, endTime, task, duration: rawDuration, effectiveMins, batchCount });
  }

  if (timeEntries.length === 0) {
    return { error: '時間記錄格式有誤，請使用「09:00-10:30 任務名稱」格式，每條記錄佔一行' };
  }

  // --- 備註（選填）---
  const notesMatch = normalized.match(/備註:\s*(.+)/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  // --- 修正一：發布工時（非時間段行）---
  const publishMinutes = parsePublishMinutes(timeLogRaw);

  // --- 有效總工時（扣午休 + 加上發布工時）---
  const effectiveTotalMinutes = timeEntries.reduce((sum, e) => sum + e.effectiveMins, 0) + publishMinutes;
  const effectiveTotalHours   = Math.round(effectiveTotalMinutes / 6) / 10;

  // --- 原始總工時（含午休，供參考）---
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

  // --- 限動數量 ---
  const limitedStoryCount = extractLimitedStoryCount(timeEntries);

  return {
    dayType, videoCount, timeEntries, timeLogRaw,
    totalMinutes, totalHours,
    effectiveTotalMinutes, effectiveTotalHours,
    publishMinutes,
    gaps, notes, limitedStoryCount,
  };
}

// ============================================================
// 特殊工作日簡短格式
// ============================================================

function detectSpecialDayType(text) {
  if (!text) return null;
  const t = text.trim();

  if (t === '外拍半天') return { dayType: '外拍半天', hours: null };
  if (t === '外拍一天') return { dayType: '外拍一天', hours: null };

  const courseMatch = t.match(/^課程拍攝\s*(\d+)\s*小時/);
  if (courseMatch) return { dayType: `課程拍攝 ${courseMatch[1]} 小時`, hours: parseInt(courseMatch[1]) };

  const liveMatch = t.match(/^直播\s*(\d+)\s*小時/);
  if (liveMatch) return { dayType: `直播 ${liveMatch[1]} 小時`, hours: parseInt(liveMatch[1]) };

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
    .map(r => {
      if (r.任務關鍵字 === '輪播') {
        return `- 含「輪播」的任務：正常範圍 30–90 分鐘，120 分鐘以內不標記異常，超過 150 分鐘為異常`;
      }
      return `- 含「${r.任務關鍵字}」的任務：正常範圍 ${r.最短時間_分}–${r.合理最長_分} 分鐘，超過 ${r.異常上限_分} 分鐘為異常`;
    })
    .join('\n');

  return `你是 VLB/漢芳療 設計部的工作查核助理，負責分析社群小編每日工作日誌。
請依照以下規則判斷，只回傳 JSON，不要有任何其他文字或 markdown。

【前置處理說明（已由系統計算完畢）】
- effective_total_hours = 各時間段工時扣除 12:00–13:00 午休重疊 + 發布工時（每平台 9 分鐘）
- 批量剪輯時，per_video_mins = 該時間段有效工時 ÷ 支數（已在明細中提供）

【判斷順序（產出優先，修正二）】
步驟一：影片數量是否達標（依各工作類型最低影片數）
        批量剪輯時，per_video_mins ≤ 120 分鐘 → 剪輯速度正常
步驟二：是否有輪播、發布、限動等其他任務的記錄
步驟三：有效總工時是否達到 ${minHours} 小時

三項皆達標 → status 設為 "normal"，anomalies 陣列留空，不標記任何異常
有任何一項未達標 → 才進行個別任務時間詳細檢查

【各工作類型最低影片數】
${dayTypeText}
- 大型活動日（限動組）：查核限動數量，活動日須有 3–5 則限時動態
- 大型活動日（拍照修片組）：查核照片產出，基本要求：大合照 1 張、現場照+老師照合計 3–5 張

【各任務合理時間範圍】
${taskTimeText}

【空白時段】
- 連續空白超過 ${maxGap} 分鐘（非午休）才標記異常

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
    `有效總工時：${parsedLog.effectiveTotalHours} 小時（${parsedLog.effectiveTotalMinutes} 分鐘）`,
    `  └ 其中發布工時：${parsedLog.publishMinutes} 分鐘（從非時間段行的發布記錄計算）`,
    ``,
    `時間記錄明細：`,
    ...parsedLog.timeEntries.map(e => {
      const batchNote = e.batchCount
        ? `（${e.batchCount} 支，per_video_mins=${Math.round(e.effectiveMins / e.batchCount)}）`
        : '';
      return `  ${e.startTime}–${e.endTime}（有效 ${e.effectiveMins} 分鐘）：${e.task}${batchNote}`;
    }),
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

  const minHours  = parseFloat(sopSettings['最低工時_小時'] || '6');
  const maxGapMin = parseInt(sopSettings['空白時段上限_分'] || '60');

  // 步驟一：影片數量
  const dayRule   = dayTypeRules.find(r => r.工作類型 === parsedLog.dayType);
  const minVideos = dayRule ? dayRule.最低影片數 : 3;
  const videoOk   = parsedLog.videoCount >= minVideos;

  // 步驟三：有效總工時（修正四）
  const hoursOk = parsedLog.effectiveTotalHours >= minHours;

  // 修正二：三步皆達標 → 直接回傳正常，不做個別檢查
  if (videoOk && hoursOk) {
    return {
      status:         'normal',
      video_count_ok: true,
      time_log_ok:    true,
      total_hours:    parsedLog.effectiveTotalHours,
      anomalies:      [],
      summary:        '工作記錄正常',
    };
  }

  // 有任何未達標 → 進入詳細檢查
  const anomalies = [];

  if (!videoOk) {
    anomalies.push(`影片數量 ${parsedLog.videoCount} 支，低於 ${parsedLog.dayType} 標準（${minVideos} 支）`);
  }
  if (!hoursOk) {
    anomalies.push(`有效總工時 ${parsedLog.effectiveTotalHours} 小時，低於標準 ${minHours} 小時`);
  }

  for (const entry of parsedLog.timeEntries) {
    // 修正五：批量剪輯用每支平均時間判斷
    if (entry.batchCount && entry.batchCount > 0) {
      const perVideoMins = Math.round(entry.effectiveMins / entry.batchCount);
      if (perVideoMins > 120) {
        anomalies.push(`批量剪輯「${entry.task}」每支平均 ${perVideoMins} 分鐘，超過上限（120 分鐘）`);
      }
      continue;
    }

    const rule = taskTimeRules.find(r => entry.task.includes(r.任務關鍵字));
    if (!rule) continue;
    // 修正三：輪播異常上限 150 分鐘
    const anomalyLimit = rule.任務關鍵字 === '輪播' ? 150 : rule.異常上限_分;
    if (entry.effectiveMins > anomalyLimit) {
      anomalies.push(`「${entry.task}」記錄 ${entry.effectiveMins} 分鐘，超過異常上限（${anomalyLimit} 分鐘）`);
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
    total_hours:    parsedLog.effectiveTotalHours,
    anomalies,
    summary: status === 'normal' ? '工作記錄正常' : `發現 ${anomalies.length} 項異常`,
  };
}

module.exports = { parseWorkLog, analyzeWorkLog, detectSpecialDayType, VALID_DAY_TYPES };
