'use strict';
const { parseWorkLog, analyzeWorkLog, detectSpecialDayType } = require('./analyzer');
const { saveWorkLog, saveLeaveRecord, getMemberName,
        getTaiwanDateString, getTaiwanTimeString }           = require('./sheets');
const { sendAnomalyAlert }                                   = require('./notifier');
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

工作類型可填：
正常日、外拍日、直播日、外拍半天、外拍一天
大型活動日（短影音組）
大型活動日（限動組）
大型活動日（拍照修片組）`.trim();

// ============================================================
// 訊息類型偵測
// ============================================================

// 完整工作日誌（含三個必要欄位）
function isWorkLog(text) {
  return text
    && text.includes('今日類型')
    && text.includes('影片數量')
    && text.includes('時間記錄');
}

// 請假 / 補休 / 當天臨時請假（靜默記錄，不回覆）
// 明天格式：明天請假、明天補休半天、明天補休 X 小時
// 當天格式：今日病假、今日事假
function parseLeaveRequest(text) {
  if (!text) return null;
  const t = text.trim();
  // 當天臨時請假（isToday = true，記錄今天日期）
  if (t === '今日病假') return { leaveType: '病假', hours: null, isToday: true };
  if (t === '今日事假') return { leaveType: '事假', hours: null, isToday: true };
  // 隔天預告請假
  if (t === '明天請假') return { leaveType: '請假', hours: null, isToday: false };
  const halfMatch = t.match(/^明天補休半天$/);
  if (halfMatch) return { leaveType: '補休', hours: 0.5, isToday: false };
  const hoursMatch = t.match(/^明天補休\s*(\d+(?:\.\d+)?)\s*小時$/);
  if (hoursMatch) return { leaveType: '補休', hours: parseFloat(hoursMatch[1]), isToday: false };
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
// 回覆訊息格式化
// ============================================================

function buildNormalReply(memberName, analysis, parsedLog) {
  return [
    `✅ ${memberName} 的工作日誌已收到！`,
    `📹 影片數量：${parsedLog.videoCount} 支 ✓`,
    `⏱️ 時間記錄：合理 ✓`,
    `📋 今日類型：${parsedLog.dayType}`,
    `⏰ 總工時：${analysis.total_hours} 小時`,
    ``,
    `辛苦了，繼續加油！`,
  ].join('\n');
}

function buildAnomalyReply(memberName, analysis, parsedLog) {
  const lines = [`⚠️ ${memberName} 的工作日誌已收到`];
  lines.push(analysis.video_count_ok
    ? `📹 影片數量：${parsedLog.videoCount} 支 ✓`
    : `📹 影片數量：${parsedLog.videoCount} 支（${parsedLog.dayType}標準未達）`
  );
  lines.push(analysis.time_log_ok
    ? `⏱️ 時間記錄：合理 ✓`
    : `⏱️ 時間記錄：發現異常`
  );
  lines.push(`📋 今日類型：${parsedLog.dayType}`);
  lines.push(`⏰ 總工時：${analysis.total_hours} 小時`);
  if (analysis.anomalies && analysis.anomalies.length > 0) {
    lines.push(``, `異常說明：`);
    analysis.anomalies.forEach(a => lines.push(`• ${a}`));
  }
  lines.push(``, `主管已收到通知。`);
  return lines.join('\n');
}

// ============================================================
// 工作日誌處理流程
// ============================================================

async function processWorkLog(text, userId, client, source) {
  const parsedLog = parseWorkLog(text);
  if (parsedLog.error) {
    return `❌ 日誌格式有誤\n\n問題：${parsedLog.error}\n\n${FORMAT_ERROR_HINT}`;
  }

  const memberName = await getMemberDisplayName(userId, client, source);
  const analysis   = await analyzeWorkLog(parsedLog, memberName);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  await saveWorkLog({
    date, time, name: memberName, lineUserId: userId,
    dayType: parsedLog.dayType, videoCount: parsedLog.videoCount,
    timeLog: parsedLog.timeLogRaw, status: analysis.status,
    anomalies: analysis.anomalies, notes: parsedLog.notes,
  });

  if (analysis.status !== 'normal') {
    await sendAnomalyAlert(client, {
      memberName,
      dayType:   parsedLog.dayType,
      anomalies: analysis.anomalies,
      date,
      status:    analysis.status,
    });
  }

  return analysis.status === 'normal'
    ? buildNormalReply(memberName, analysis, parsedLog)
    : buildAnomalyReply(memberName, analysis, parsedLog);
}

// ============================================================
// 特殊工作日處理（簡短格式，直接存為正常狀態）
// ============================================================

async function processSpecialDayLog(text, userId, client, source, specialDay) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  await saveWorkLog({
    date, time, name: memberName, lineUserId: userId,
    dayType: specialDay.dayType, videoCount: 0,
    timeLog: text, status: 'normal', anomalies: [], notes: '',
  });

  return `✅ ${memberName} 已登記：${specialDay.dayType}`;
}

// ============================================================
// 請假處理（靜默記錄，計算隔天日期）
// ============================================================

async function processLeaveRequest(text, userId, client, source, leaveInfo) {
  const memberName = await getMemberDisplayName(userId, client, source);

  // 當天臨時請假用今天，隔天預告請假用明天
  const targetDate = new Date();
  if (!leaveInfo.isToday) targetDate.setDate(targetDate.getDate() + 1);
  const leaveDate  = getTaiwanDateString(targetDate);
  const submitTime = getTaiwanTimeString();

  await saveLeaveRecord({
    leaveDate,
    submitTime,
    name:      memberName,
    lineUserId: userId,
    leaveType: leaveInfo.leaveType,
    hours:     leaveInfo.hours,
  });

  // 靜默記錄，不回覆任何訊息
  console.log(`📋 請假記錄：${memberName} ${leaveDate} ${leaveInfo.leaveType}`);
}

// ============================================================
// LINE 事件主入口
// ============================================================

async function handleEvent(event, client) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text       = event.message.text;
  const replyToken = event.replyToken;
  const userId     = event.source.userId;
  const source     = event.source;

  let replyText;

  try {
    // 優先判斷系統指令
    const cmdReply = await handleCommand(text, userId);
    if (cmdReply) {
      replyText = cmdReply;
    }
    // 請假 / 補休（靜默記錄，不回覆）
    else if (parseLeaveRequest(text)) {
      await processLeaveRequest(text, userId, client, source, parseLeaveRequest(text));
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

module.exports = { handleEvent };
