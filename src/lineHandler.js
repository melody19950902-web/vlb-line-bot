'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { parseWorkLog, detectSpecialDayType } = require('./analyzer');
const { saveWorkLog, savePublishReport, saveLeaveRecord, saveEditProgress, getMemberName,
        getLeaveRecordForUserOnDate, deleteLeaveRecordForUserOnDate,
        getTaiwanDateString, getTaiwanTimeString }           = require('./sheets');

const { handleCommand }                                      = require('./commands');

// ============================================================
// 格式錯誤提示
// ============================================================
const FORMAT_ERROR_HINT = `
請依以下格式重新傳送：

今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 剪輯短影音
10:30-11:00 發布各平台
備註：（選填）

工作類型可填:
正常日、跟拍日、課程日、大型活動日（拍照組／限動組／剪輯組）
Podcast日、直播日、外拍半天、外拍一天`.trim();

// ============================================================
// 訊息類型偵測
// ============================================================

// 完整工作日誌（今日類型 + 影片數量即可，時間記錄為選填）
function isWorkLog(text) {
  return !!(text
    && text.includes('今日類型')
    && text.includes('影片數量'));
}

// 發布回報（新格式：已發布｜平台｜帳號；舊格式：含「發布完成」字樣）
function isPublishReport(text) {
  if (!text) return false;
  const t = text.trim();
  return /^已發布[｜|]/.test(t) || t.includes('發布完成');
}

// 剪輯進度上傳（格式：剪輯進度｜影片標題｜狀態）
function isEditProgress(text) {
  if (!text) return false;
  return /^剪輯進度[｜|]/.test(text.trim());
}

// 中文數字對照（1~10）
const CN_NUM = { 一:1, 兩:2, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };

// ============================================================
// 日期解析（自然說法 → 台灣日期字串 YYYY/MM/DD）
// 支援：今日/今天、明天/明日、後天、下?週[一~日]、M/D、M月D日
// 限制：結果須在 今天 ~ +30 天內，否則視為無效回傳 null
// ============================================================
function resolveLeaveDate(token) {
  if (!token) return null;
  const t = token.trim();
  const todayStr = getTaiwanDateString();
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30);
  const maxStr = getTaiwanDateString(maxDate);
  const inRange = (s) => s && s >= todayStr && s <= maxStr;

  let candidate = null;
  if (t === '今日' || t === '今天') candidate = new Date();
  else if (t === '明天' || t === '明日') { candidate = new Date(); candidate.setDate(candidate.getDate() + 1); }
  else if (t === '後天') { candidate = new Date(); candidate.setDate(candidate.getDate() + 2); }
  else {
    const wdMatch = t.match(/^(下)?週([一二三四五六日])$/);
    if (wdMatch) {
      const dayNames = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
      const target = dayNames[wdMatch[2]];
      const taiwanNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const taiwanDow = taiwanNow.getDay();
      // 一律取「下一個該星期」（若今天就是該星期則 +7）
      // 「下週X」與「週X」語意上都是下一個 upcoming 該星期
      let diff = target - taiwanDow;
      if (diff <= 0) diff += 7;
      candidate = new Date(); candidate.setDate(candidate.getDate() + diff);
    } else {
      const dm = t.match(/^(\d{1,2})[\/月](\d{1,2})日?$/);
      if (dm) {
        const m = parseInt(dm[1]);
        const d = parseInt(dm[2]);
        if (m < 1 || m > 12 || d < 1 || d > 31) return null;
        const [ty] = todayStr.split('/').map(Number);
        const yestDate = new Date(); yestDate.setDate(yestDate.getDate() - 1);
        const yestStr = getTaiwanDateString(yestDate);
        let year = ty;
        let candStr = `${year}/${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}`;
        if (candStr < yestStr) {
          year++;
          candStr = `${year}/${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}`;
        }
        return inRange(candStr) ? candStr : null;
      }
    }
  }
  if (!candidate) return null;
  const candStr = getTaiwanDateString(candidate);
  return inRange(candStr) ? candStr : null;
}

// dayLabel 顯示：今日/明日/M/D
function formatDayLabel(dateStr) {
  const today = getTaiwanDateString();
  const tmr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return getTaiwanDateString(d); })();
  if (dateStr === today) return '今日';
  if (dateStr === tmr)   return '明日';
  const [, m, d] = dateStr.split('/');
  return `${parseInt(m)}/${parseInt(d)}`;
}

// ============================================================
// 第一層放寬：容忍填充詞、任意順序抓「日期 / 假別 / 時數」
// 前置：長度>30 或 workLog/publishReport/editProgress 或無假別關鍵字 → null
// ============================================================
function parseLeaveFlexible(text) {
  if (!text || text.length > 30) return null;
  if (isWorkLog(text) || isPublishReport(text) || isEditProgress(text)) return null;
  if (!/(特休|補休|休假|病假|事假|請假)/.test(text)) return null;
  const t = text.trim();

  // 假別（優先具體類型；只剩「請假」→ vague）
  let leaveType = null, vague = false;
  if      (/特休/.test(t)) leaveType = '特休';
  else if (/補休/.test(t)) leaveType = '補休';
  else if (/病假/.test(t)) leaveType = '病假';
  else if (/事假/.test(t)) leaveType = '事假';
  else if (/休假/.test(t)) leaveType = '休假';
  else if (/請假/.test(t)) vague = true;

  // 時段（早上/下午）
  let session = null;
  if (/早上/.test(t)) session = '早上';
  else if (/下午/.test(t)) session = '下午';

  // 時數（含中文數字；半天視為 4）
  let hours = null;
  const hm = t.match(/([\d.]+|[一兩二三四五六七八九十])\s*小時/);
  if (hm) {
    hours = CN_NUM[hm[1]] != null ? CN_NUM[hm[1]] : parseFloat(hm[1]);
  }
  if (/半天/.test(t)) hours = 4;

  // 日期 token（先試較長 pattern）
  let dateStr = null;
  const patterns = [
    /(下週[一二三四五六日])/,
    /(週[一二三四五六日])/,
    /(今日|今天|明天|明日|後天)/,
    /(\d{1,2}[\/月]\d{1,2}日?)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) { dateStr = resolveLeaveDate(m[1]); if (dateStr) break; }
  }

  return { leaveType, hours, session, dateStr, vague };
}

// ============================================================
// 第二層：Claude 意圖判讀（僅在 flex 無法產出完整結果時呼叫）
// ============================================================
const AI_SYSTEM = `你是 VLB 團隊 LINE Bot 的請假意圖判讀助手。判斷用戶訊息「本人是否正在提出請假/補休申請」並抽出關鍵資訊。

規則：
- is_leave_request=true 需要同時滿足：(a) 訊息在描述本人自己 (b) 是正在「提出/宣告」請假意圖 (c) 涉及請假/補休/休假之一。
- 對過去回憶、談論他人請假、閒聊提到假別 → 一律 false。
- leave_type 只能是：病假、事假、特休、休假、補休、或 null。
- date_text 是原文中出現的日期描述（如「明天」「後天」「8/5」「下週一」）。若有明顯錯字（例：眀天 → 明天），請輸出正確的日期描述；沒明說日期輸出 null。
- hours 是明確的小時數（如「補休 2 小時」→ 2）；中文數字換算（如「兩小時」→ 2）；「半天」→ 4；沒明說輸出 null。

回傳嚴格 JSON（不加 markdown、不加解釋），格式：
{"is_leave_request": true|false, "leave_type": "病假"|"事假"|"特休"|"休假"|"補休"|null, "date_text": string|null, "hours": number|null}`;

async function parseLeaveByAI(text) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      temperature: 0,
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    const raw = message.content[0].text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: true };
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('parseLeaveByAI 失敗：', err.message);
    return { error: true };
  }
}

// 請假 / 補休（記錄後回覆確認；重複則提醒已記錄）
// 當天僅 病假／事假；明日 事假／特休／休假／補休
// 「明天／明日」「今日／今天」四種講法皆等價；通用「請假」回傳 vague，由 processLeaveRequest 反問假別
function parseLeaveRequest(text) {
  if (!text) return null;
  // 開頭統一正規化：明日→明天、今天→今日
  const t = text.trim().replace(/^明日/, '明天').replace(/^今天/, '今日');
  // 當天：病假、臨時事假、當日補休
  if (t === '今日病假') return { leaveType: '病假', isToday: true };
  if (t === '今日事假') return { leaveType: '事假', isToday: true };
  if (t === '今日請假') return { vague: true, isToday: true };
  if (t === '今日補休' || t === '今日補休一天') return { leaveType: '補休', isToday: true };
  if (t === '今日補休半天') return { leaveType: '補休', hours: 4, isToday: true };
  if (t === '今日早上補休半天') return { leaveType: '補休', hours: 4, session: '早上', isToday: true };
  if (t === '今日下午補休半天') return { leaveType: '補休', hours: 4, session: '下午', isToday: true };
  // 明日（前一天預告）
  if (t === '明天事假') return { leaveType: '事假', isToday: false };
  if (t === '明天特休') return { leaveType: '特休', isToday: false };
  if (t === '明天休假' || t === '明天休假一天') return { leaveType: '休假', isToday: false };
  if (t === '明天請假' || t === '明天請假一天') return { vague: true, isToday: false };
  // 補休系列
  if (t === '明天補休') return { leaveType: '補休', isToday: false };
  if (t === '明天補休半天') return { leaveType: '補休', hours: 4, isToday: false };
  if (t === '明天早上補休半天') return { leaveType: '補休', hours: 4, session: '早上', isToday: false };
  if (t === '明天下午補休半天') return { leaveType: '補休', hours: 4, session: '下午', isToday: false };
  // 今日／明天 補休 N 小時（支援阿拉伯與中文數字）
  const hoursMatch = t.match(/^(今日|明天)補休\s*([\d.]+|[一兩二三四五六七八九十])\s*小時$/);
  if (hoursMatch) {
    const v = CN_NUM[hoursMatch[2]] != null ? CN_NUM[hoursMatch[2]] : parseFloat(hoursMatch[2]);
    if (v > 0) return { leaveType: '補休', hours: v, isToday: hoursMatch[1] === '今日' };
  }
  return null;
}

// 取消請假指令解析
// 支援：取消 [今日|今天|明天|明日|後天|M/D|M月D日]? [假別]? （日期省略預設今天）
function parseCancelRequest(text) {
  if (!text) return null;
  const t = text.trim();
  const m = t.match(/^取消\s*(今日|今天|明天|明日|後天|\d{1,2}[\/月]\d{1,2}日?)?\s*(請假|病假|事假|特休|休假|補休)?$/);
  if (!m) return null;
  const dateToken = m[1] || '今日';
  const dateStr = resolveLeaveDate(dateToken);
  if (!dateStr) return null;
  return { dateStr };
}

// ============================================================
// 取得小編顯示名稱
// ============================================================

async function getMemberDisplayName(userId, client, source) {
  try {
    const sheetName = await getMemberName(userId);
    if (sheetName) return sheetName;
    let profile;
    if (source && source.type === 'group') {
      profile = await client.getGroupMemberProfile(source.groupId, userId);
    } else if (source && source.type === 'room') {
      profile = await client.getRoomMemberProfile(source.roomId, userId);
    } else {
      profile = await client.getProfile(userId);
    }
    return profile.displayName || '未知用戶';
  } catch (err) {
    console.error('取得成員名稱失敗：', err.message);
    return '未知用戶';
  }
}

// ============================================================
// 工作日誌處理流程（格式檢查後靜默儲存，22:30 統一查核）
// ============================================================

async function processWorkLog(text, userId, client, source) {
  const parsedLog = parseWorkLog(text);

  // 今日類型或影片數量解析失敗才回覆錯誤（其餘格式問題一律靜默接收）
  if (parsedLog.error && (parsedLog.error.includes('今日類型') || parsedLog.error.includes('影片數量'))) {
    return `❌ 日誌格式有誤\n\n問題：${parsedLog.error}\n\n${FORMAT_ERROR_HINT}`;
  }

  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  await saveWorkLog({
    date, time, name: memberName, lineUserId: userId,
    dayType:    parsedLog.dayType    || '未知',
    videoCount: parsedLog.videoCount ?? 0,
    carouselCount: parsedLog.carouselCount ?? 0,
    timeLog:    parsedLog.timeLogRaw || text,
    status: 'pending',
    anomalies: [], notes: parsedLog.notes || '',
  });

  return null; // 全天靜默收資料，22:30 統一查核
}

// ============================================================
// 特殊工作日處理（簡短格式，直接存為正常狀態）
// ============================================================

async function processSpecialDayLog(text, userId, client, source, specialDay) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  // 若有時數，記入 notes 供 22:30 彙整參考（例：跟拍 3 小時、Podcast 4.5 小時）
  const typeName = specialDay.dayType.replace('日', '');
  const notes = specialDay.hours != null ? `${typeName} ${specialDay.hours} 小時` : '';

  await saveWorkLog({
    date, time, name: memberName, lineUserId: userId,
    dayType: specialDay.dayType, videoCount: 0, carouselCount: 0,
    timeLog: text, status: 'normal', anomalies: [], notes,
  });

  return null; // 全天靜默收資料，22:30 統一查核
}

// ============================================================
// 發布回報處理（靜默儲存至發布記錄）
// ============================================================

async function processPublishReport(text, userId, client, source) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  await savePublishReport({ date, time, name: memberName, lineUserId: userId, rawText: text });
  console.log(`📢 [發布回報] ${memberName} | ${text}`);
  return null; // 靜默接收
}

// ============================================================
// 剪輯進度處理（靜默儲存至剪輯進度記錄）
// ============================================================

async function processEditProgress(text, userId, client, source) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  const parts = text.split(/[｜|]/);
  const title  = parts[1] ? parts[1].trim() : text;
  const status = parts[2] ? parts[2].trim() : '未知';

  await saveEditProgress({ date, time, name: memberName, lineUserId: userId, title, status });
  console.log(`✂️ [剪輯進度] ${memberName} | ${title} | ${status}`);
  return null; // 靜默接收
}

// ============================================================
// 請假處理（記錄後回覆確認；重複則提醒已記錄；寫入失敗則提醒重試）
// ============================================================

async function processLeaveRequest(text, userId, client, source, leaveInfo) {
  if (leaveInfo.vague) {
    return '請問你要請哪一種假？\n・當天可請：今日病假、今日事假、今日補休\n・前一天預告：明日事假、明日特休、明日休假、明日補休\n請改傳明確的假別，謝謝。';
  }

  // dateStr 為呼叫端解析後的台灣日期字串；若缺（相容舊呼叫）→ 用 isToday 推導
  const today = getTaiwanDateString();
  let leaveDate = leaveInfo.dateStr;
  if (!leaveDate) {
    const targetDate = new Date();
    if (!leaveInfo.isToday) targetDate.setDate(targetDate.getDate() + 1);
    leaveDate = getTaiwanDateString(targetDate);
  }

  // 規則：特休 / 休假需要前一天預告，當天不受理
  if (leaveDate === today && (leaveInfo.leaveType === '特休' || leaveInfo.leaveType === '休假')) {
    return `${leaveInfo.leaveType}需要前一天預告，如今天臨時需要請直接聯絡主管。`;
  }

  const memberName = await getMemberDisplayName(userId, client, source);
  const submitTime = getTaiwanTimeString();
  const dayLabel = formatDayLabel(leaveDate);
  const cancelHint = leaveDate === today
    ? '「取消今日請假」'
    : `「取消${dayLabel}${leaveInfo.leaveType || '請假'}」`;

  // 同一人同一天已有請假記錄 → 直接回覆，不重複寫入
  const existing = await getLeaveRecordForUserOnDate(userId, leaveDate);
  if (existing) {
    console.log(`📋 [請假記錄] 重複偵測 | 小編：${memberName} | 請假日期：${leaveDate} | 已存在類型：${existing.leaveType}`);
    return `📌 你${dayLabel}（${leaveDate}）的請假已經記錄過了（類型：${existing.leaveType}）。\n如需更改，請先傳${cancelHint}再重新傳一次。`;
  }

  const ok = await saveLeaveRecord({
    leaveDate, submitTime,
    name: memberName, lineUserId: userId,
    leaveType: leaveInfo.leaveType, hours: leaveInfo.hours,
  });
  console.log(`📋 [請假記錄] 寫入${ok ? '完成' : '失敗'} | 小編：${memberName} | 請假日期：${leaveDate} | 類型：${leaveInfo.leaveType} | 提交時間：${submitTime}`);
  if (!ok) {
    return '⚠️ 請假記錄寫入失敗，請稍後再傳一次；若持續失敗，請通知主管手動登記。';
  }
  let detail = leaveInfo.leaveType;
  if (leaveInfo.session) detail += `（${leaveInfo.session}）`;
  if (leaveInfo.hours)   detail += ` ${leaveInfo.hours} 小時`;
  return `✅ 已收到並記錄你的請假\n👤 ${memberName}\n📅 ${leaveDate}（${dayLabel}）\n📌 類型：${detail}\n\n如需取消，請傳${cancelHint}；如需修改，取消後再重新傳一次即可。`;
}

// ============================================================
// 取消請假處理（刪除該人當日／隔日的請假記錄）
// ============================================================

async function processCancelRequest(text, userId, client, source, cancelInfo) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const leaveDate = cancelInfo.dateStr;
  const dayLabel  = formatDayLabel(leaveDate);
  const removed = await deleteLeaveRecordForUserOnDate(userId, leaveDate);
  if (!removed) {
    return `你${dayLabel}（${leaveDate}）沒有找到可取消的請假記錄。`;
  }
  console.log(`📋 [請假記錄] 取消 | 小編：${memberName} | 日期：${leaveDate} | 原類型：${removed.leaveType}`);
  return `✅ 已取消你${dayLabel}（${leaveDate}）的請假（原類型：${removed.leaveType}）。\n如需重新請假，直接再傳一次即可。`;
}

// ============================================================
// LINE 事件主入口
// ============================================================

async function handleEvent(event, client) {
  if (event.type !== 'message') return;

  // 圖片/影片查重（僅群組）
  if (event.message.type === 'image' || event.message.type === 'video') {
    if (event.source.type === 'group') {
      try {
        const { processMedia } = require('./fingerprint');
        const memberName = await getMemberDisplayName(event.source.userId, client, event.source);
        const date = getTaiwanDateString();
        await processMedia(client, event.message.id, event.message.type, memberName, date);
      } catch (err) {
        console.error('媒體查重失敗：', err.message);
      }
    }
    return;
  }

  if (event.message.type !== 'text') return;

  const text       = event.message.text;
  const replyToken = event.replyToken;
  const userId     = event.source.userId;
  const source     = event.source;

  let replyText;

  try {
    // 群組 ID 查詢
    if (text === '群組ID') {
      replyText = source.type === 'group'
        ? `此群組的 ID：\n${source.groupId}`
        : '請在群組中輸入「群組ID」才能取得群組 ID。';
    }
    // 優先判斷系統指令
    else {
    const cmdReply = await handleCommand(text, userId);
    if (cmdReply) {
      replyText = cmdReply;
    }
    // 取消請假（先於請假解析，避免關鍵字重疊）
    else if (parseCancelRequest(text)) {
      replyText = await processCancelRequest(text, userId, client, source, parseCancelRequest(text));
    }
    // 請假 / 補休：三段式（strict → flex → AI），絕不靜默忽略含請假關鍵字的短訊息
    else if (parseLeaveRequest(text)) {
      const strict = parseLeaveRequest(text);
      // 轉為 dateStr：strict 只有 isToday，換算成 today 或 tomorrow
      const targetDate = new Date();
      if (!strict.isToday) targetDate.setDate(targetDate.getDate() + 1);
      const dateStr = getTaiwanDateString(targetDate);
      replyText = await processLeaveRequest(text, userId, client, source, { ...strict, dateStr });
    }
    // 發布回報（靜默記錄，不回覆）
    else if (isPublishReport(text)) {
      await processPublishReport(text, userId, client, source);
      return; // 不回覆
    }
    // 剪輯進度（靜默記錄，不回覆）
    else if (isEditProgress(text)) {
      await processEditProgress(text, userId, client, source);
      return; // 不回覆
    }
    // 完整工作日誌
    else if (isWorkLog(text)) {
      replyText = await processWorkLog(text, userId, client, source);
    }
    // 含請假關鍵字的短訊息（strict 沒抓到）→ flex → AI
    else if (text && text.length <= 30 && /(特休|補休|休假|病假|事假|請假)/.test(text)) {
      const guide = '收到你的請假需求，請補上日期與假別，例如：明天特休、8/5事假、今日補休2小時';
      const flex = parseLeaveFlexible(text);
      if (flex && flex.leaveType && flex.dateStr && !flex.vague) {
        // flex 完整 → 走請假流程
        replyText = await processLeaveRequest(text, userId, client, source, flex);
      } else if (flex && flex.vague && flex.dateStr) {
        // 有日期但只寫「請假」→ 引導補假別
        replyText = guide;
      } else {
        // flex 未產出完整結果 → 交給 AI 判讀
        const ai = await parseLeaveByAI(text);
        if (ai && ai.error) {
          replyText = guide;
        } else if (ai && ai.is_leave_request === false) {
          return; // 純聊天不打擾
        } else if (ai && ai.is_leave_request === true) {
          const aiDate = ai.date_text ? resolveLeaveDate(ai.date_text) : null;
          const type = ai.leave_type;
          if (type && aiDate) {
            replyText = await processLeaveRequest(text, userId, client, source, {
              leaveType: type, hours: ai.hours || null, dateStr: aiDate,
            });
          } else {
            replyText = guide;
          }
        } else {
          replyText = guide;
        }
      }
    }
    // 特殊工作日簡短格式
    else {
      const specialDay = detectSpecialDayType(text);
      if (specialDay) {
        replyText = await processSpecialDayLog(text, userId, client, source, specialDay);
      }
    }
    } // end else (非群組ID指令)
  } catch (err) {
    console.error('handleEvent 發生錯誤：', err);
    replyText = '⚠️ 系統發生錯誤，請稍後再試。\n若問題持續，請聯絡管理員。';
  }

  if (!replyText) return;

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

module.exports = { handleEvent, isWorkLog, isPublishReport, isEditProgress, parseLeaveRequest, parseLeaveFlexible, parseCancelRequest, resolveLeaveDate };
