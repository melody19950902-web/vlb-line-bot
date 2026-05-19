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
  '課程日（拍攝組）',
  '課程日（拍照組）',
  '課程日（限動組）',
  '課程日（行政支援）',
];

// 課程日類型（影片數量 0 支為正常）
const COURSE_DAY_TYPES = new Set([
  '課程日（拍攝組）', '課程日（拍照組）',
  '課程日（限動組）', '課程日（行政支援）',
]);

// ============================================================
// 時間工具
// ============================================================

function timeToMinutes(str) {
  const normalized = str.replace('：', ':');
  const parts = normalized.split(':');
  let h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  // 單位數小時（無補零）在工作日誌中視為下午時段：1→13, 2→14 ... 9→21
  if (parts[0].length === 1 && h >= 1 && h <= 9) h += 12;
  return h * 60 + m;
}

function durationMinutes(start, end) {
  return timeToMinutes(end) - timeToMinutes(start);
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
// 非剪輯任務判斷（用於計算可剪輯時間）
// ============================================================
function isNonEditingTask(task) {
  const editing = /剪[片輯了編]|短影音剪|後製|剪接/;
  const nonEditing = /拍攝|拍照|直播|課程|會議|溝通|協調|設備|架設|外拍|外出|準備|整理|字幕排程|行政|現場|採購|場勘|巡場|簡報|討論/;
  return nonEditing.test(task) && !editing.test(task);
}

// 依可剪輯時間計算最低影片數標準
function minVideosFromAvailableTime(availableMins) {
  if (availableMins >= 240) return 3;   // 4 小時以上 → 3 支
  if (availableMins >= 150) return 2;   // 2.5–4 小時 → 2 支
  if (availableMins >= 60)  return 1;   // 1–2.5 小時 → 1 支
  return 0;                             // 1 小時以下 → 0–1 支
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

  // --- 時間記錄（選填）---
  // 有時間 → 用時間輔助計算；沒有或格式不標準 → 忽略時間，不拒絕日誌
  const timeLogMatch = normalized.match(/時間記錄:\s*\n([\s\S]+?)(?=備註:|$)/);
  const timeLogRaw = timeLogMatch ? timeLogMatch[1].trim() : '';

  const timeEntries = [];
  if (timeLogRaw) {
    const linePattern = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s+(.+)/g;
    let m;
    while ((m = linePattern.exec(timeLogRaw)) !== null) {
      const startTime = m[1];
      const endTime   = m[2];
      const task      = m[3].trim();
      const rawDuration = durationMinutes(startTime, endTime);
      if (rawDuration <= 0) continue;

      const effectiveMins = rawDuration;
      let batchCount = parseBatchCount(task);
      if (!batchCount && /剪[片輯了編]|短影音剪/.test(task) && videoCount > 0) {
        batchCount = videoCount;
      }

      timeEntries.push({ startTime, endTime, task, duration: rawDuration, effectiveMins, batchCount });
    }
  }

  // --- 備註（選填）---
  const notesMatch = normalized.match(/備註:\s*(.+)/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  // --- 修正一：發布工時（非時間段行）---
  const publishMinutes = parsePublishMinutes(timeLogRaw);

  // --- 有效總工時（任務時段直接加總 + 發布工時）---
  const effectiveTotalMinutes = timeEntries.reduce((sum, e) => sum + e.effectiveMins, 0) + publishMinutes;
  const effectiveTotalHours   = Math.round(effectiveTotalMinutes / 6) / 10;

  // --- 原始總工時（任務時段加總，不含發布工時）---
  const totalMinutes = timeEntries.reduce((sum, e) => sum + e.duration, 0);
  const totalHours   = Math.round(totalMinutes / 6) / 10;

  // --- 空白時段（所有空白皆記錄，超過 120 分鐘才標記異常）---
  const gaps = [];
  for (let i = 1; i < timeEntries.length; i++) {
    const prevEndMin   = timeToMinutes(timeEntries[i - 1].endTime);
    const currStartMin = timeToMinutes(timeEntries[i].startTime);
    const gapMin = currStartMin - prevEndMin;
    if (gapMin <= 0) continue;
    gaps.push({ from: timeEntries[i - 1].endTime, to: timeEntries[i].startTime, minutes: gapMin });
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
  const maxGap   = sopSettings['空白時段上限_分'] || '120';

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

【重要前提：時間記錄是選填的】
- 有時間記錄 → 用時間輔助計算
- 沒有時間記錄 → 依影片數量和任務內容判斷合理性
- 時間格式不標準 → 系統已盡量解析，解析不了的已忽略
- 格式問題永遠不是拒絕或標記異常的理由

【前置處理說明（已由系統計算完畢）】
- effective_total_hours = 所有有任務記錄的時段直接加總（不扣除任何固定午休）
- 批量剪輯時，per_video_mins = 該時間段工時 ÷ 支數（已在明細中提供）
- available_editing_mins = 總工時 - 非剪輯任務時間（已計算，見明細）

【判斷順序（產出優先）】
步驟一：影片數量是否合理（依可剪輯時間階梯標準，見下方）
        批量剪輯時，per_video_mins ≤ 120 分鐘才算達標
步驟二：任務內容是否合理（無明顯異常即可）
步驟三：若有時間記錄，有效總工時是否達到 ${minHours} 小時

【影片數量合理性——依可剪輯時間的階梯標準（最重要）】
可剪輯時間 = 總工時 - 非剪輯任務時間（拍攝/直播/課程/會議/協調/設備架設等）

可剪輯時間 ≥ 4 小時    → 3 支為正常標準
可剪輯時間 2.5–4 小時  → 2 支即達標
可剪輯時間 1–2.5 小時  → 1 支即達標
可剪輯時間 < 1 小時    → 0 支可接受

沒有時間記錄時，以工作類型預設標準判斷：
${dayTypeText}

【課程日（各角色）特別說明】
課程日（拍攝組）、課程日（拍照組）、課程日（限動組）、課程日（行政支援）：
- 影片數量 0 支為完全正常，不標記異常
- 主要任務是課程拍攝與現場記錄，不需常規剪輯或輪播產出
- 不得因影片數量為 0 或無輪播記錄而標記

【大型活動日特別說明】
- 大型活動日（限動組）：查核限動數量，活動日須有 3–5 則限時動態
- 大型活動日（拍照修片組）：查核照片產出，基本要求：大合照 1 張、現場照+老師照合計 3–5 張

【發布任務不需在工作日誌中出現（重要）】
- 發布是獨立的回報方式（已發布｜平台｜帳號），不需在時間記錄中重複列出
- 只要工作日誌有剪輯、直播、限動製作、拍攝、輪播等相關工作，絕對不標記「缺少發布記錄」
- 只有當日誌完全沒有任何內容產出相關任務時，才考慮標記

【批量剪輯計算（確保一致性）】
若某時間段任務包含「剪 N 支」，per_video_mins = 時段工時 ÷ N
per_video_mins > 120 分鐘 → 標記異常
per_video_mins ≤ 120 分鐘 → 正常，不標記

【各任務合理時間範圍（僅在有時間記錄且其他項目異常時才檢查）】
${taskTimeText}

【空白時段規則】
- 所有空白時段均視為可能的午休或彈性緩衝，不標記異常
- 只有當空白時段超過 ${maxGap} 分鐘時，才標記為異常

【異常描述格式（重要）】
任務超時：依程度描述（不顯示具體分鐘數）
- 超過上限 110–130%：「[任務名稱] 耗時稍長」
- 超過上限 130% 以上：「[任務名稱] 耗時明顯較長，建議確認」
時數不足：輸出「時數未達標準」，不顯示具體小時數
空白過長：輸出「有較長空白時段，建議確認」，不顯示具體分鐘數

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
// 批量剪輯確定性覆蓋（無論 Claude 怎麼判斷，此結果優先）
// per_video_mins > 120 → 確保異常被記錄
// per_video_mins ≤ 120 → 移除 Claude 誤加的批量超時標記
// ============================================================
function applyDeterministicBatchCheck(result, parsedLog) {
  let { anomalies = [], status } = result;
  anomalies = [...anomalies];

  for (const entry of parsedLog.timeEntries) {
    if (!entry.batchCount || entry.batchCount <= 0) continue;
    const perVideoMins = Math.round(entry.effectiveMins / entry.batchCount);

    if (perVideoMins > 120) {
      const desc = overtimeDescription(entry.task, perVideoMins, 120);
      // 若 Claude 未標記此異常，強制加入
      if (!anomalies.some(a => a.startsWith(entry.task) && a.includes('耗時'))) {
        anomalies.push(desc);
      }
      if (status === 'normal') status = 'warning';
    } else {
      // 移除 Claude 對此任務誤判的超時標記
      anomalies = anomalies.filter(a => !(a.startsWith(entry.task) && a.includes('耗時')));
    }
  }

  return { ...result, anomalies, status };
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
    (() => {
      if (parsedLog.timeEntries.length === 0) return '（無時間記錄，依影片數量和任務內容判斷）';
      const nonEditingMins = parsedLog.timeEntries
        .filter(e => isNonEditingTask(e.task))
        .reduce((sum, e) => sum + e.effectiveMins, 0);
      const availableMins = Math.max(0, parsedLog.effectiveTotalMinutes - nonEditingMins);
      const adjustedMin = minVideosFromAvailableTime(availableMins);
      return `  └ 非剪輯任務：${nonEditingMins} 分鐘，可剪輯時間：${availableMins} 分鐘 → 標準最低 ${adjustedMin} 支`;
    })(),
    ``,
    `時間記錄明細：`,
    ...(parsedLog.timeEntries.length > 0 ? parsedLog.timeEntries.map(e => {
      const batchNote = e.batchCount
        ? `（${e.batchCount} 支，per_video_mins=${Math.round(e.effectiveMins / e.batchCount)}）`
        : '';
      return `  ${e.startTime}–${e.endTime}（有效 ${e.effectiveMins} 分鐘）：${e.task}${batchNote}`;
    }) : ['  （無）']),
    ``,
    `空白時段：`,
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
    return applyDeterministicBatchCheck(JSON.parse(jsonMatch[0]), parsedLog);
  } catch (err) {
    console.error('Claude 分析失敗，改用本地備援分析：', err.message);
    return await localFallbackAnalysis(parsedLog);
  }
}

// ============================================================
// 超時描述輔助（不顯示分鐘數）
// 110–130% → 耗時稍長；>130% → 耗時明顯較長
// ============================================================
function overtimeDescription(taskName, actualMins, limitMins) {
  const ratio = actualMins / limitMins;
  if (ratio >= 1.3) return `${taskName} 耗時明顯較長，建議確認`;
  return `${taskName} 耗時稍長`;
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
  const maxGapMin = parseInt(sopSettings['空白時段上限_分'] || '120');

  // 課程日：影片 0 支完全正常，直接回傳 normal
  if (COURSE_DAY_TYPES.has(parsedLog.dayType)) {
    return {
      status: 'normal', video_count_ok: true, time_log_ok: true,
      total_hours: parsedLog.effectiveTotalHours, anomalies: [],
      summary: '課程日記錄正常',
    };
  }

  // 步驟一：影片數量（依可剪輯時間階梯標準）
  let minVideos;
  if (parsedLog.timeEntries.length > 0) {
    // 有時間記錄 → 計算可剪輯時間
    const nonEditingMins = parsedLog.timeEntries
      .filter(e => isNonEditingTask(e.task))
      .reduce((sum, e) => sum + e.effectiveMins, 0);
    const availableMins = Math.max(0, parsedLog.effectiveTotalMinutes - nonEditingMins);
    minVideos = minVideosFromAvailableTime(availableMins);
  } else {
    // 無時間記錄 → 用工作類型預設標準
    const dayRule = dayTypeRules.find(r => r.工作類型 === parsedLog.dayType);
    minVideos = dayRule ? dayRule.最低影片數 : 3;
  }
  const videoOk = parsedLog.videoCount >= minVideos;

  // 批量剪輯每支平均時間（確定性檢查，不受早期回傳跳過）
  const batchAnomalies = [];
  for (const entry of parsedLog.timeEntries) {
    if (entry.batchCount && entry.batchCount > 0) {
      const perVideoMins = Math.round(entry.effectiveMins / entry.batchCount);
      if (perVideoMins > 120) {
        batchAnomalies.push(overtimeDescription(entry.task, perVideoMins, 120));
      }
    }
  }

  // 步驟三：有效總工時（無時間記錄時略過）
  const hasTimeLog = parsedLog.timeEntries.length > 0;
  const hoursOk = !hasTimeLog || parsedLog.effectiveTotalHours >= minHours;

  // 三步皆達標 → 正常
  if (videoOk && hoursOk && batchAnomalies.length === 0) {
    return {
      status: 'normal', video_count_ok: true, time_log_ok: true,
      total_hours: parsedLog.effectiveTotalHours, anomalies: [],
      summary: '工作記錄正常',
    };
  }

  const anomalies = [...batchAnomalies];

  if (!videoOk) {
    anomalies.push(`影片數量 ${parsedLog.videoCount} 支，低於當日標準（${minVideos} 支）`);
  }
  if (!hoursOk) {
    anomalies.push('時數未達標準');
  }

  for (const entry of parsedLog.timeEntries) {
    if (entry.batchCount && entry.batchCount > 0) continue;
    const rule = taskTimeRules.find(r => entry.task.includes(r.任務關鍵字));
    if (!rule) continue;
    const anomalyLimit = rule.任務關鍵字 === '輪播' ? 150 : rule.異常上限_分;
    if (entry.effectiveMins > anomalyLimit) {
      anomalies.push(overtimeDescription(entry.task, entry.effectiveMins, anomalyLimit));
    }
  }

  for (const gap of parsedLog.gaps) {
    if (gap.minutes > maxGapMin) {
      anomalies.push('有較長空白時段，建議確認');
      break;
    }
  }

  const timeOk = !anomalies.some(a => a.includes('空白') || a.includes('耗時') || a.includes('時數'));
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
