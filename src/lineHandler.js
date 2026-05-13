'use strict';
const { parseWorkLog, analyzeWorkLog }          = require('./analyzer');
const { saveWorkLog, getMemberName,
        getTaiwanDateString, getTaiwanTimeString } = require('./sheets');
const { sendAnomalyAlert }                       = require('./notifier');
const { handleCommand }                          = require('./commands');

// ============================================================
// 格式錯誤提示範本
// ============================================================
const FORMAT_ERROR_HINT = `
請依以下格式重新傳送：

今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 任務名稱
10:30-11:00 任務名稱
備註：（選填）

工作類型可填：
正常日、外拍日、直播日
大型活動日（拍照組）
大型活動日（限動組）
大型活動日（剪輯組）`.trim();

// ============================================================
// 判斷訊息類型
// ============================================================

// 訊息是否包含工作日誌關鍵欄位
function isWorkLog(text) {
  return text
    && text.includes('今日類型')
    && text.includes('影片數量')
    && text.includes('時間記錄');
}

// ============================================================
// 取得小編顯示名稱
// ============================================================

// 優先查 Sheets 成員名單，查不到則依來源類型呼叫對應 LINE API
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

// 正常回覆
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

// 異常或警告回覆
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
  // Step 1：解析格式
  const parsedLog = parseWorkLog(text);
  if (parsedLog.error) {
    return `❌ 日誌格式有誤\n\n問題：${parsedLog.error}\n\n${FORMAT_ERROR_HINT}`;
  }

  // Step 2：取得小編名稱
  const memberName = await getMemberDisplayName(userId, client, source);

  // Step 3：Claude 分析
  const analysis = await analyzeWorkLog(parsedLog, memberName);

  // Step 4：取得現在時間
  const date = getTaiwanDateString();
  const time = getTaiwanTimeString();

  // Step 5：儲存到 Sheets
  await saveWorkLog({
    date,
    time,
    name:       memberName,
    lineUserId: userId,
    dayType:    parsedLog.dayType,
    videoCount: parsedLog.videoCount,
    timeLog:    parsedLog.timeLogRaw,
    status:     analysis.status,
    anomalies:  analysis.anomalies,
    notes:      parsedLog.notes,
  });

  // Step 6：異常時通知主管
  if (analysis.status !== 'normal') {
    await sendAnomalyAlert(client, {
      memberName,
      dayType:   parsedLog.dayType,
      anomalies: analysis.anomalies,
      date,
      status:    analysis.status,
    });
  }

  // Step 7：回覆小編
  return analysis.status === 'normal'
    ? buildNormalReply(memberName, analysis, parsedLog)
    : buildAnomalyReply(memberName, analysis, parsedLog);
}

// ============================================================
// LINE 事件主入口
// ============================================================
async function handleEvent(event, client) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text       = event.message.text;
  const replyToken = event.replyToken;
  const userId     = event.source.userId;
  const source     = event.source;

  let replyText;

  try {
    // 優先判斷是否為系統指令
    const cmdReply = await handleCommand(text, userId);
    if (cmdReply) {
      replyText = cmdReply;
    } else if (isWorkLog(text)) {
      replyText = await processWorkLog(text, userId, client, source);
    } else {
      // 不認識的訊息，顯示提示
      replyText = [
        `👋 嗨！`,
        ``,
        `如要提交今日工作日誌，請依格式回報：`,
        ``,
        `今日類型：正常日`,
        `影片數量：3`,
        `時間記錄：`,
        `09:00-10:30 任務名稱`,
        ``,
        `輸入「說明」查看完整格式與指令。`,
      ].join('\n');
    }
  } catch (err) {
    console.error('handleEvent 發生錯誤：', err);
    replyText = '⚠️ 系統發生錯誤，請稍後再試。\n若問題持續，請聯絡管理員。';
  }

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

module.exports = { handleEvent };
