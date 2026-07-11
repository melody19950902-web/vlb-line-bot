'use strict';
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

// 請假 / 補休（記錄後回覆確認；重複則提醒已記錄）
// 當天僅 病假／事假；明日 事假／特休／休假／補休
// 「明天／明日」「今日／今天」四種講法皆等價；通用「請假」回傳 vague，由 processLeaveRequest 反問假別
function parseLeaveRequest(text) {
  if (!text) return null;
  // 開頭統一正規化：明日→明天、今天→今日
  const t = text.trim().replace(/^明日/, '明天').replace(/^今天/, '今日');
  // 當天：只允許病假與臨時事假
  if (t === '今日病假') return { leaveType: '病假', isToday: true };
  if (t === '今日事假') return { leaveType: '事假', isToday: true };
  if (t === '今日請假') return { vague: true, isToday: true };
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
  const hoursMatch = t.match(/^明天補休\s*(\d+(?:\.\d+)?)\s*小時$/);
  if (hoursMatch) return { leaveType: '補休', hours: parseFloat(hoursMatch[1]), isToday: false };
  return null;
}

// 取消請假指令解析
// 支援：取消今日／取消今天／取消明天／取消明日 + 假別（可選）
function parseCancelRequest(text) {
  if (!text) return null;
  const t = text.trim();
  if (/^取消(今日|今天)(請假|病假|事假|特休|休假|補休)?$/.test(t)) return { isToday: true };
  if (/^取消(明天|明日)(請假|病假|事假|特休|休假|補休)?$/.test(t)) return { isToday: false };
  return null;
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
    dayType: specialDay.dayType, videoCount: 0,
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
    return '請問你要請哪一種假？\n・當天可請：今日病假、今日事假\n・前一天預告：明日事假、明日特休、明日休假、明日補休\n請改傳明確的假別，謝謝。';
  }

  const memberName = await getMemberDisplayName(userId, client, source);

  // 當天臨時請假用今天，隔天預告請假用明天
  const targetDate = new Date();
  if (!leaveInfo.isToday) targetDate.setDate(targetDate.getDate() + 1);
  const leaveDate  = getTaiwanDateString(targetDate);
  const submitTime = getTaiwanTimeString();

  // 同一人同一天已有請假記錄 → 直接回覆，不重複寫入
  const existing = await getLeaveRecordForUserOnDate(userId, leaveDate);
  if (existing) {
    const dayLabel = leaveInfo.isToday ? '今日' : '明日';
    const cancelWord = leaveInfo.isToday ? '今日' : '明天';
    console.log(`📋 [請假記錄] 重複偵測 | 小編：${memberName} | 請假日期：${leaveDate} | 已存在類型：${existing.leaveType}`);
    return `📌 你${dayLabel}（${leaveDate}）的請假已經記錄過了（類型：${existing.leaveType}）。\n如需更改，請先傳「取消${cancelWord}請假」再重新傳一次。`;
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
  const dayLabel = leaveInfo.isToday ? '今日' : '明日';
  const cancelWord = leaveInfo.isToday ? '今日' : '明天';
  let detail = leaveInfo.leaveType;
  if (leaveInfo.session) detail += `（${leaveInfo.session}）`;
  if (leaveInfo.hours)   detail += ` ${leaveInfo.hours} 小時`;
  return `✅ 已收到並記錄你的請假\n👤 ${memberName}\n📅 ${leaveDate}（${dayLabel}）\n📌 類型：${detail}\n\n如需取消，請傳「取消${cancelWord}請假」；如需修改，取消後再重新傳一次即可。`;
}

// ============================================================
// 取消請假處理（刪除該人當日／隔日的請假記錄）
// ============================================================

async function processCancelRequest(text, userId, client, source, cancelInfo) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const targetDate = new Date();
  if (!cancelInfo.isToday) targetDate.setDate(targetDate.getDate() + 1);
  const leaveDate = getTaiwanDateString(targetDate);
  const dayLabel  = cancelInfo.isToday ? '今日' : '明日';
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
    // 請假 / 補休（記錄後回覆確認；重複則提醒已記錄）
    else if (parseLeaveRequest(text)) {
      replyText = await processLeaveRequest(text, userId, client, source, parseLeaveRequest(text));
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

module.exports = { handleEvent, isWorkLog, isPublishReport, isEditProgress, parseLeaveRequest };
