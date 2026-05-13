'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getSopSettings, getTaskTimeRules, getDayTypeRules } = require('./sheets');

// ============================================================
// 工作日誌解析
// ============================================================

// 將時間字串（HH:MM 或 HH：MM）轉為從午夜起算的分鐘數
function timeToMinutes(str) {
  const normalized = str.replace('：', ':');
  const [h, m] = normalized.split(':').map(Number);
  return h * 60 + m;
}

// 計算兩個時間點的分鐘差
function durationMinutes(start, end) {
  return timeToMinutes(end) - timeToMinutes(start);
}

// 解析小編傳來的工作日誌文字，回傳結構化物件
// 成功：回傳 { dayType, videoCount, timeEntries, timeLogRaw, totalMinutes, totalHours, gaps, notes }
// 失敗：回傳 { error: '錯誤說明' }
function parseWorkLog(text) {
  if (!text || typeof text !== 'string') {
    return { error: '訊息內容為空' };
  }

  // 正規化全形冒號與換行
  const normalized = text.replace(/\r\n/g, '\n').replace(/：/g, ':').trim();

  // --- 今日類型 ---
  const typeMatch = normalized.match(/今日類型:\s*(.+)/);
  if (!typeMatch) return { error: '缺少「今日類型」欄位' };
  const dayType = typeMatch[1].trim();

  const validTypes = ['正常日', '外拍日', '直播日',
    '大型活動日（拍照組）', '大型活動日（限動組）', '大型活動日（剪輯組）'];
  if (!validTypes.includes(dayType)) {
    return {
      error: `「今日類型」填寫有誤（填入：${dayType}）\n` +
             `可填選項：正常日、外拍日、直播日、大型活動日（拍照組）、大型活動日（限動組）、大型活動日（剪輯組）`,
    };
  }

  // --- 影片數量 ---
  const videoMatch = normalized.match(/影片數量:\s*(\d+)/);
  if (!videoMatch) return { error: '缺少「影片數量」欄位，或數量非數字' };
  const videoCount = parseInt(videoMatch[1]);

  // --- 時間記錄 ---
  // 擷取「時間記錄:」之後、「備註:」之前（或結尾）的區塊
  const timeLogMatch = normalized.match(/時間記錄:\s*\n([\s\S]+?)(?=備註:|$)/);
  if (!timeLogMatch) return { error: '缺少「時間記錄」欄位' };
  const timeLogRaw = timeLogMatch[1].trim();

  // 解析每條時間記錄（支援 09:00-10:30 與 09:00–10:30 格式）
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
  const totalHours   = Math.round(totalMinutes / 6) / 10; // 四捨五入到小數點第一位

  // --- 偵測空白時段（連續記錄之間的間隔，排除午休 12:00–13:00）---
  const gaps = [];
  for (let i = 1; i < timeEntries.length; i++) {
    const prevEndMin   = timeToMinutes(timeEntries[i - 1].endTime);
    const currStartMin = timeToMinutes(timeEntries[i].startTime);
    const gapMin = currStartMin - prevEndMin;
    if (gapMin <= 0) continue;

    // 午休判定：前一條結束 >= 12:00 且下一條開始 <= 13:00
    const isLunchBreak = prevEndMin >= 720 && currStartMin <= 780;
    if (!isLunchBreak) {
      gaps.push({
        from:    timeEntries[i - 1].endTime,
        to:      timeEntries[i].startTime,
        minutes: gapMin,
      });
    }
  }

  return { dayType, videoCount, timeEntries, timeLogRaw, totalMinutes, totalHours, gaps, notes };
}

// ============================================================
// Claude 分析
// ============================================================

// 動態建立 Claude 系統提示（加入從 Sheets 讀取的即時規則）
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

  return `你是 VLB/漢芳療 設計部的工作查核助理。
負責分析台灣美業社群小編的每日工作日誌。
請依照以下規則判斷，只回傳 JSON，不要有任何其他文字或 markdown。

【查核基準】
- 正常日最低工時：${minHours} 小時
- 空白時段上限：${maxGap} 分鐘（中午 12:00–13:00 的空白不算）

【各工作類型最低影片數】
${dayTypeText}

【各任務合理時間範圍（依任務名稱中的關鍵字判斷）】
${taskTimeText}

【判斷邏輯】
- status 為 "alert"：影片數量低於該日標準，或任何任務超過異常時間上限
- status 為 "warning"：總工時不足、空白時段過長，但影片數量達標
- status 為 "normal"：所有項目均符合標準

【回傳格式（嚴格 JSON，不含 markdown）】
{
  "status": "normal 或 warning 或 alert",
  "video_count_ok": true 或 false,
  "time_log_ok": true 或 false,
  "total_hours": 數字（計算所有時間記錄的總工時）,
  "anomalies": ["繁體中文異常說明1", "繁體中文異常說明2"],
  "summary": "一句話整體評估（繁體中文）"
}`;
}

// 呼叫 Claude API 分析工作日誌
async function analyzeWorkLog(parsedLog, memberName) {
  // 組裝傳給 Claude 的結構化日誌說明
  const logText = [
    `小編姓名：${memberName}`,
    `今日類型：${parsedLog.dayType}`,
    `影片數量：${parsedLog.videoCount} 支`,
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

    // 擷取 JSON（防止 Claude 意外加了說明文字）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude 未回傳有效 JSON');

    return JSON.parse(jsonMatch[0]);

  } catch (err) {
    console.error('Claude 分析失敗，改用本地備援分析：', err.message);
    return await localFallbackAnalysis(parsedLog);
  }
}

// ============================================================
// 本地備援分析（Claude API 不可用時）
// ============================================================
async function localFallbackAnalysis(parsedLog) {
  const [sopSettings, taskTimeRules, dayTypeRules] = await Promise.all([
    getSopSettings(),
    getTaskTimeRules(),
    getDayTypeRules(),
  ]);

  const anomalies  = [];
  const minHours   = parseFloat(sopSettings['最低工時_小時'] || '6');
  const maxGapMin  = parseInt(sopSettings['空白時段上限_分'] || '60');

  // 檢查總工時
  if (parsedLog.totalHours < minHours) {
    anomalies.push(`總工時 ${parsedLog.totalHours} 小時，低於標準 ${minHours} 小時`);
  }

  // 檢查影片數量
  const dayRule   = dayTypeRules.find(r => r.工作類型 === parsedLog.dayType);
  const minVideos = dayRule ? dayRule.最低影片數 : 3;
  const videoOk   = parsedLog.videoCount >= minVideos;
  if (!videoOk) {
    anomalies.push(`影片數量 ${parsedLog.videoCount} 支，低於 ${parsedLog.dayType} 標準（${minVideos} 支）`);
  }

  // 檢查任務時間（用關鍵字比對）
  for (const entry of parsedLog.timeEntries) {
    const rule = taskTimeRules.find(r => entry.task.includes(r.任務關鍵字));
    if (rule && entry.duration > rule.異常上限_分) {
      anomalies.push(
        `「${entry.task}」記錄 ${entry.duration} 分鐘，超過異常上限（${rule.異常上限_分} 分鐘）`
      );
    }
  }

  // 檢查空白時段
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

module.exports = { parseWorkLog, analyzeWorkLog };
