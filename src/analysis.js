'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getSopSettings, getTaskTimeRules, getDayTypeRules } = require('./sheets');
const { COURSE_DAY_TYPES, isNonEditingTask, minVideosFromAvailableTime } = require('./parser');

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
      if (!anomalies.some(a => a.startsWith(entry.task) && a.includes('耗時'))) {
        anomalies.push(desc);
      }
      if (status === 'normal') status = 'warning';
    } else {
      anomalies = anomalies.filter(a => !(a.startsWith(entry.task) && a.includes('耗時')));
    }
  }

  return { ...result, anomalies, status };
}

// ============================================================
// Claude 系統提示（模組層級快取，同一程序只讀一次 Sheets）
// ============================================================

let _cachedSystemPrompt = null;

async function getSystemPrompt() {
  if (!_cachedSystemPrompt) {
    _cachedSystemPrompt = await buildSystemPrompt();
  }
  return _cachedSystemPrompt;
}

async function buildSystemPrompt() {
  const [sopSettings, taskTimeRules, dayTypeRules] = await Promise.all([
    getSopSettings(),
    getTaskTimeRules(),
    getDayTypeRules(),
  ]);

  const minHours = sopSettings['最低工時_小時'] || '6';

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

【課程日特別說明】
課程日：
- 影片數量 0 支為完全正常，不標記異常
- 主要任務是課程拍攝與現場記錄，不需常規剪輯或輪播產出
- 不得因影片數量為 0 或無輪播記錄而標記

【拍攝日特別說明】
拍攝日：
- 當天主力為拍攝，影片由後製日產出
- 最低影片數 1 支即達標，不得因影片數量低而標記異常

【Podcast日特別說明】
Podcast日：
- 當天主力為 Podcast 錄製、上稿、修圖、撰寫文案
- 最低影片數 1 支即達標
- Podcast 相關任務（錄製、上稿、設備架設、修照片、撰寫文案）不算可剪輯時間

【發布任務不需在工作日誌中出現（重要）】
- 發布是獨立的回報方式（已發布｜平台｜帳號），不需在時間記錄中重複列出
- 只要工作日誌有剪輯、直播、限動製作、拍攝、輪播等相關工作，絕對不標記「缺少發布記錄」
- 只有當日誌完全沒有任何內容產出相關任務時，才考慮標記

【批量剪輯計算（確保一致性）】
若某時間段任務包含「剪 N 支」，per_video_mins = 時段工時 ÷ N
per_video_mins > 120 分鐘 → 標記異常
per_video_mins ≤ 120 分鐘 → 正常，不標記

【突發與彈性工作】
只要時間記錄中有任務描述，該任務視為合法工作項目，不標記異常。
非 SOP 範圍的工作（臨時協助拍攝、處理突發需求、整理課程器材、協助其他部門、研究新工具）
只要有記錄，都是合理的工作內容。

【通報門檻（只在以下情況才通報）】
- 正常日，影片數量為 0，且備註無任何說明 → alert
- 工作記錄加總低於 6 小時且無合理原因 → warning
- 批量剪輯 per_video_mins > 120 → warning

以下不通報：
- 任務時間超過 SOP 建議範圍
- 影片數量比標準少但有其他任務記錄
- 格式不標準或工作內容超出 SOP
- 單一任務超過建議時間（3 小時內皆可接受）

【異常描述格式（重要）】
時數不足：輸出「時數未達標準」，不顯示具體小時數

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
    const systemPrompt = await getSystemPrompt();
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
// 本地備援分析
// ============================================================

async function localFallbackAnalysis(parsedLog) {
  const [sopSettings] = await Promise.all([
    getSopSettings(),
  ]);

  const minHours = parseFloat(sopSettings['最低工時_小時'] || '6');

  if (COURSE_DAY_TYPES.has(parsedLog.dayType)) {
    return {
      status: 'normal', video_count_ok: true, time_log_ok: true,
      total_hours: parsedLog.effectiveTotalHours, anomalies: [],
      summary: '課程日記錄正常',
    };
  }

  const batchAnomalies = [];
  for (const entry of parsedLog.timeEntries) {
    if (entry.batchCount && entry.batchCount > 0) {
      const perVideoMins = Math.round(entry.effectiveMins / entry.batchCount);
      if (perVideoMins > 120) {
        batchAnomalies.push(overtimeDescription(entry.task, perVideoMins, 120));
      }
    }
  }

  const videoAnomaly = (parsedLog.dayType === '正常日' && parsedLog.videoCount === 0 && !parsedLog.notes);
  const videoOk = !videoAnomaly;

  const hasTimeLog = parsedLog.timeEntries.length > 0;
  const hoursOk = !hasTimeLog || parsedLog.effectiveTotalHours >= minHours || !!parsedLog.notes;

  const anomalies = [...batchAnomalies];
  if (!videoOk) anomalies.push('正常日影片數量為 0，請補充說明');
  if (!hoursOk) anomalies.push('時數未達標準');

  const status = !videoOk ? 'alert' : anomalies.length > 0 ? 'warning' : 'normal';

  return {
    status,
    video_count_ok: videoOk,
    time_log_ok:    hoursOk,
    total_hours:    parsedLog.effectiveTotalHours,
    anomalies,
    summary: status === 'normal' ? '工作記錄正常' : `發現 ${anomalies.length} 項異常`,
  };
}

module.exports = { analyzeWorkLog, applyDeterministicBatchCheck, localFallbackAnalysis };
