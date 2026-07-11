'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getSopSettings, getTaskTimeRules, getDayTypeRules } = require('./sheets');
const { isCourseDay, isNonEditingTask, minVideosFromAvailableTime } = require('./parser');

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
// 影片數不足確定性檢查（Claude / 本地備援分析後套用）
// 規則：
//   videoShort = 當天影片數 < 該工作類型最低影片數（讀「工作類型標準」）
//   taskPadded = 任一「非剪輯任務」時段實際耗時 > 該任務「異常上限_分」
//                （剪輯合理性交由 applyDeterministicBatchCheck 處理，避免重複）
//   lowEffort  = 沒有時間記錄，或有效總工時 < 最低工時_小時
//   通報：videoShort && (taskPadded || lowEffort)
//   免通報：videoShort && !taskPadded && !lowEffort
//   status：通報時至少 warning；若原本 alert 則保留 alert；免通報且清單空才回 normal
// ============================================================
// 判斷是否為「影片數不足」相關異常（含自家 taskPadded 訊息）
// 自家訊息都以「影片數 x/y 未達標」開頭；Claude 舊格式含「影片數」但無「耗時」
// batch 異常以任務名開頭、不含「影片數」，不會被誤刪
function isVideoShortAnomaly(a) {
  return /影片數\s*\d+\/\d+\s*未達標/.test(a)
      || (/影片數/.test(a) && !/耗時/.test(a));
}

async function applyVideoShortCheck(result, parsedLog) {
  const [dayTypeRules, taskTimeRules, sopSettings] = await Promise.all([
    getDayTypeRules(),
    getTaskTimeRules(),
    getSopSettings(),
  ]);

  let { anomalies = [], status } = result;
  anomalies = [...anomalies];

  // 課程日一律最低 0 支，跳過檢查
  if (isCourseDay(parsedLog.dayType)) {
    return { ...result, anomalies, status };
  }

  const rule = dayTypeRules.find(r => r.工作類型 === parsedLog.dayType);
  if (!rule) return { ...result, anomalies, status };

  const minVideos = rule.最低影片數;
  const videoShort = parsedLog.videoCount < minVideos;

  // 掃時間記錄，僅檢查「非剪輯任務」是否超過異常上限_分
  // 對每個時段取「關鍵字最長」的規則以避免子字串撞名（例如「撰寫修改輪播貼文」不應被「輪播」誤判）
  // 剪輯類交給 applyDeterministicBatchCheck，避免用整段分鐘數誤判批量剪輯
  const paddedTasks = [];
  for (const entry of parsedLog.timeEntries) {
    if (!isNonEditingTask(entry.task)) continue;
    let best = null;
    for (const taskRule of taskTimeRules) {
      if (!taskRule.任務關鍵字 || !taskRule.異常上限_分) continue;
      if (entry.task.includes(taskRule.任務關鍵字)
          && (!best || taskRule.任務關鍵字.length > best.任務關鍵字.length)) {
        best = taskRule;
      }
    }
    if (best && entry.effectiveMins > best.異常上限_分) {
      paddedTasks.push({
        task:  entry.task,
        mins:  entry.effectiveMins,
        limit: best.異常上限_分,
      });
    }
  }
  const taskPadded = paddedTasks.length > 0;

  const minHours = parseFloat(sopSettings['最低工時_小時'] || '6');
  const hasTimeLog = parsedLog.timeEntries.length > 0;
  const lowEffort = !hasTimeLog || parsedLog.effectiveTotalHours < minHours;

  // 先移除舊的「影片數不足」類異常（含自家 taskPadded 訊息，確保重跑冪等）
  const hadVideoShort = anomalies.some(isVideoShortAnomaly);
  anomalies = anomalies.filter(a => !isVideoShortAnomaly(a));

  const shouldReport = videoShort && (taskPadded || lowEffort);

  if (shouldReport) {
    let msg;
    if (taskPadded) {
      const partsText = paddedTasks
        .map(p => `「${p.task}」耗時 ${p.mins} 分，超過異常上限 ${p.limit} 分`)
        .join('；');
      msg = `影片數 ${parsedLog.videoCount}/${minVideos} 未達標，且${partsText}（疑似灌水）`;
    } else if (hasTimeLog) {
      msg = `影片數 ${parsedLog.videoCount}/${minVideos} 未達標，且當日有效工時 ${parsedLog.effectiveTotalHours} 小時，低於標準 ${minHours} 小時`;
    } else {
      msg = `影片數 ${parsedLog.videoCount}/${minVideos} 未達標，且當日無工作記錄可佐證`;
    }
    anomalies.push(msg);
    // 嚴重度分級：0 支產出 + (無時間記錄 或 有效工時 < 最低工時一半) → alert
    // 有產出（≥1 支）或工時未嚴重不足 → warning
    const severe = parsedLog.videoCount === 0
      && (!hasTimeLog || parsedLog.effectiveTotalHours < minHours / 2);
    if (severe) {
      status = 'alert';
    } else if (status !== 'alert') {
      status = 'warning';
    }
  } else if (hadVideoShort && anomalies.length === 0
             && (status === 'warning' || status === 'alert')) {
    // 原本只因影片數不足升級，現在條件不成立且無其他異常 → 恢復 normal
    status = 'normal';
  }

  return {
    ...result,
    anomalies,
    status,
    video_count_ok: !(videoShort && shouldReport),
  };
}

// ============================================================
// 補休半天調整：最低工時扣掉補休時數；工時達標則移除時數不足；影片產出從寬（移除影片數不足）
// ============================================================
function applyCompLeaveAdjustment(result, parsedLog, { compHours, minHours }) {
  let anomalies = [...(result.anomalies || [])];
  const adjustedMinHours = Math.max(0, minHours - compHours);
  // 工時達到調整後標準 → 移除時數不足類
  if (parsedLog.effectiveTotalHours >= adjustedMinHours) {
    anomalies = anomalies.filter(a => !a.includes('時數未達標準'));
  }
  // 半天不苛求產出 → 移除影片數不足類（含自家 taskPadded / lowEffort 訊息）
  anomalies = anomalies.filter(a => !isVideoShortAnomaly(a));
  let status = result.status;
  if (anomalies.length === 0) status = 'normal';
  else if (status === 'alert') status = 'warning'; // 補休日的 alert 僅來自影片產出，已放寬 → 降為 warning
  return { ...result, anomalies, status, video_count_ok: true, adjustedMinHours };
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

let _cachedSystemPrompt = { text: null, at: 0 };
const PROMPT_TTL_MS = 10 * 60 * 1000;

async function getSystemPrompt() {
  const now = Date.now();
  if (!_cachedSystemPrompt.text || now - _cachedSystemPrompt.at > PROMPT_TTL_MS) {
    _cachedSystemPrompt = { text: await buildSystemPrompt(), at: now };
  }
  return _cachedSystemPrompt.text;
}

async function buildSystemPrompt() {
  const [sopSettings, dayTypeRules] = await Promise.all([
    getSopSettings(),
    getDayTypeRules(),
  ]);

  const minHours = sopSettings['最低工時_小時'] || '6';

  const dayTypeText = dayTypeRules
    .map(r => `- ${r.工作類型}：最低 ${r.最低影片數} 支影片`)
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
課程日系列（「課程日」、「課程日（拍攝組）」、「課程日（拍照組）」、「課程日（限動組）」、「課程日（行政支援）」，以及任何以「課程日」開頭的類型）：
- 不強制填寫角色分組，有無括號都合法
- 影片數量 0 支為完全正常，不標記異常
- 主要任務是現場拍攝、記錄、拍照、限動或行政支援，不需常規剪輯或輪播產出
- 不得因影片數量為 0 或無輪播記錄而標記任何異常

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

【通報門檻（Claude 只處理以下項目）】
- 若有時間記錄且有效總工時低於 ${minHours} 小時 → warning，anomalies 列「時數未達標準」
- 批量剪輯 per_video_mins > 120 → warning
- 課程日、拍攝日、Podcast日 等特殊類型的影片數規則，維持各自「特別說明」段落
- 其餘一律不由 Claude 對單一任務時間下異常

【影片數不足由系統事後判定，Claude 不介入】
- 影片數是否達標、以及是否因「其他任務時間灌水或工時不足」而通報，一律由系統的確定性規則在事後判定
- Claude 不需自行對影片數升級或降級通報，也不需依「備註是否有說明」判斷影片數異常
- 只需如實描述當日產出與其他面向；video_count_ok 可先填 true，系統會覆寫

以下不通報：
- 任務時間超過 SOP 建議範圍（單一任務超時交由系統判斷）
- 影片數量比標準少（是否通報由系統依工時與任務灌水情況決定）
- 格式不標準或工作內容超出 SOP

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
    const withBatch = applyDeterministicBatchCheck(JSON.parse(jsonMatch[0]), parsedLog);
    return await applyVideoShortCheck(withBatch, parsedLog);
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

  // 課程日（含任意角色分組）：影片數量 0 支視為正常
  if (isCourseDay(parsedLog.dayType)) {
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

  const hasTimeLog = parsedLog.timeEntries.length > 0;
  const hoursOk = !hasTimeLog || parsedLog.effectiveTotalHours >= minHours;

  const anomalies = [...batchAnomalies];
  if (!hoursOk) anomalies.push('時數未達標準');

  const status = anomalies.length > 0 ? 'warning' : 'normal';

  const preliminary = {
    status,
    video_count_ok: true,
    time_log_ok:    hoursOk,
    total_hours:    parsedLog.effectiveTotalHours,
    anomalies,
    summary: status === 'normal' ? '工作記錄正常' : `發現 ${anomalies.length} 項異常`,
  };

  const finalResult = await applyVideoShortCheck(preliminary, parsedLog);
  finalResult.summary = finalResult.status === 'normal'
    ? '工作記錄正常'
    : `發現 ${finalResult.anomalies.length} 項異常`;
  return finalResult;
}

module.exports = { analyzeWorkLog, applyDeterministicBatchCheck, applyVideoShortCheck, applyCompLeaveAdjustment, localFallbackAnalysis };
