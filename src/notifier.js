'use strict';
const nodemailer = require('nodemailer');
const {
  getTodayLogs, getAllMemberNames, getLeaveRecordsForDate,
  getTaiwanDateString, getTaiwanTimeString,
  saveWorkLog, getTodayPublishReports,
  saveMonthlyRecord, getMonthlyAnomalies, getTaiwanMonthString,
} = require('./sheets');
const { parseWorkLog, analyzeWorkLog } = require('./analyzer');

// ============================================================
// LINE 推播通知
// ============================================================

async function notifyAdminLine(client, message) {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) {
    console.warn('未設定 ADMIN_LINE_USER_ID，略過 LINE 推播');
    return false;
  }
  try {
    await client.pushMessage({
      to:       adminId,
      messages: [{ type: 'text', text: message }],
    });
    console.log('✅ 主管 LINE 推播已發送');
    return true;
  } catch (err) {
    console.error('LINE 推播失敗：', err.message);
    return false;
  }
}

// ============================================================
// Email 警報（Gmail）
// ============================================================

async function sendEmailAlert(subject, body) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.NOTIFY_EMAIL) {
    console.warn('Email 設定不完整，略過寄信');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    await transporter.sendMail({
      from:    `VLB工作查核系統 <${process.env.GMAIL_USER}>`,
      to:      process.env.NOTIFY_EMAIL,
      subject: `【VLB工作查核】${subject}`,
      text:    body,
      html:    `<pre style="font-family:sans-serif;line-height:1.6">${body}</pre>`,
    });
    console.log(`📧 警報郵件已發送：${subject}`);
    return true;
  } catch (err) {
    console.error('發送郵件失敗：', err.message);
    return false;
  }
}

// ============================================================
// 異常警報（即時，工作日誌送出後觸發）
// ============================================================

async function sendAnomalyAlert(client, { memberName, dayType, anomalies, date, status }) {
  const statusLabel = status === 'alert' ? '🚨 嚴重異常' : '⚠️ 警告';
  const anomalyLines = anomalies.map(a => `• ${a}`).join('\n');

  const lineMsg = [
    `${statusLabel}｜工作日誌通知`,
    `小編：${memberName}`,
    `日期：${date}`,
    `類型：${dayType}`,
    ``,
    `異常項目：`,
    anomalyLines,
  ].join('\n');

  const emailBody = [
    `${statusLabel} 工作日誌異常通知`,
    ``,
    `小編：${memberName}`,
    `日期：${date}`,
    `工作類型：${dayType}`,
    ``,
    `異常項目：`,
    anomalyLines,
    ``,
    `請登入 Google Sheets 查看完整記錄。`,
  ].join('\n');

  await Promise.all([
    notifyAdminLine(client, lineMsg),
    sendEmailAlert(`${memberName} 工作日誌異常 - ${date}`, emailBody),
  ]);
}

// ============================================================
// 每日 22:30 彙整（全 6 人逐人列出）
// ============================================================

async function sendDailySummary(client) {
  const today = getTaiwanDateString();
  const month = getTaiwanMonthString();

  const [logs, allMembers, leaveRecords, publishReportMap] = await Promise.all([
    getTodayLogs(),
    getAllMemberNames(),
    getLeaveRecordsForDate(today),
    getTodayPublishReports(),
  ]);

  // 每人取最後一筆回報
  const latestByName = new Map();
  for (const row of logs) {
    if (row[2]) latestByName.set(row[2], row);
  }

  // 對 pending 的工作日誌執行最終分析（整合發布回報後才判斷）
  for (const [name, row] of latestByName) {
    if (row[7] !== 'pending') continue;
    try {
      const publishLines = publishReportMap.get(name) || [];
      const mergedTimeLog = publishLines.length > 0
        ? row[6] + '\n' + publishLines.join('\n')
        : row[6];

      const fullLogText = [
        `今日類型：${row[4]}`,
        `影片數量：${row[5]}`,
        `時間記錄：`,
        mergedTimeLog,
        row[9] ? `備註：${row[9]}` : '',
      ].filter(Boolean).join('\n');

      const parsedLog = parseWorkLog(fullLogText);
      if (parsedLog.error) {
        console.error(`22:30 重新解析失敗 ${name}：${parsedLog.error}`);
        continue;
      }

      const analysis = await analyzeWorkLog(parsedLog, name);
      const time = getTaiwanTimeString();

      await saveWorkLog({
        date: today, time, name, lineUserId: row[3],
        dayType: parsedLog.dayType, videoCount: parsedLog.videoCount,
        timeLog: mergedTimeLog, status: analysis.status,
        anomalies: analysis.anomalies, notes: parsedLog.notes || '',
      });

      // 更新 latestByName，讓下方彙整使用最終結果
      latestByName.set(name, [
        today, time, name, row[3],
        parsedLog.dayType, String(parsedLog.videoCount),
        mergedTimeLog, analysis.status,
        analysis.anomalies.join('；'), parsedLog.notes || '',
      ]);
    } catch (err) {
      console.error(`22:30 分析 ${name} 失敗：`, err.message);
    }
  }

  // 請假類型對照表 { name → leaveType }
  const leaveTypeMap = new Map();
  for (const r of leaveRecords) {
    if (r[2]) leaveTypeMap.set(r[2], r[4] || '請假');
  }

  const lines = [`📊 VLB 今日工作回報 ${today}`, ``];

  const needsFollowUp = []; // 需要補充說明的人
  const monthlyToRecord = []; // 需要寫入月度記錄的 { name, anomalyType }
  const hoursWarnings = []; // 工時不足，不顯示於群組彙整，私下通知主管

  for (const name of allMembers) {
    const leaveType = leaveTypeMap.get(name);

    if (leaveType === '病假') {
      lines.push(`🏥 ${name}｜病假`);
      continue;
    }
    if (leaveType === '事假') {
      lines.push(`📋 ${name}｜事假`);
      continue;
    }
    if (leaveType) {
      lines.push(`🏖️ ${name}｜休假（已請假）`);
      continue;
    }

    const row = latestByName.get(name);
    if (!row) {
      lines.push(`❗ ${name}｜未回報且未請假`);
      monthlyToRecord.push({ name, anomalyType: '未回報' });
      needsFollowUp.push(name);
    } else if (row[7] === 'pending') {
      // 22:30 分析失敗的兜底
      lines.push(`❓ ${name}｜分析待確認`);
      needsFollowUp.push(name);
    } else if (row[7] === 'normal') {
      const isSpecialDay = /外拍半天|外拍一天|課程拍攝|直播\s*\d|活動外拍/.test(row[4] || '');
      lines.push(isSpecialDay ? `✅ ${name}｜${row[4]}` : `✅ ${name}｜達成工作標準`);
    } else {
      // 拆開異常：工時不足不顯示於群組，其餘正常顯示
      const allAnomalies = (row[8] || '').split('；').filter(Boolean);
      const groupAnomalies = allAnomalies.filter(a => a !== '工時未達標準');

      if (allAnomalies.includes('工時未達標準')) {
        hoursWarnings.push(name);
        monthlyToRecord.push({ name, anomalyType: '工時未達標準' });
      }

      if (groupAnomalies.length > 0) {
        const reason = groupAnomalies[0];
        const emoji = row[7] === 'alert' ? '🚨' : '⚠️';
        lines.push(`${emoji} ${name}｜${reason}`);
        monthlyToRecord.push({ name, anomalyType: reason });
        needsFollowUp.push(name);
      } else {
        // 只有工時異常 → 群組顯示達成標準，主管私下另行告知
        const isSpecialDay = /外拍半天|外拍一天|課程拍攝|直播\s*\d|活動外拍/.test(row[4] || '');
        lines.push(isSpecialDay ? `✅ ${name}｜${row[4]}` : `✅ ${name}｜達成工作標準`);
      }
    }
  }

  lines.push(``);
  const allNormal = needsFollowUp.length === 0;
  lines.push(allNormal
    ? `${allMembers.length} 人全員達成工作標準，辛苦了！`
    : `${allMembers.length} 人狀態已確認。`
  );

  if (needsFollowUp.length > 0) {
    lines.push(`請 ${needsFollowUp.join('、')} 補充說明。`);
  }

  // 工時提醒：不顯示於群組彙整，私下附在訊息底部供主管確認
  if (hoursWarnings.length > 0) {
    lines.push(``, `─────`, `工時提醒（請私下確認）：${hoursWarnings.join('、')}`);
  }

  await notifyAdminLine(client, lines.join('\n'));

  // 月度異常記錄與達標通報
  for (const { name, anomalyType } of monthlyToRecord) {
    await saveMonthlyRecord({ month, name, date: today, anomalyType });

    const records = await getMonthlyAnomalies(month, name);
    const count = records.length;
    if (count >= 4) {
      const alertMsg = [
        `🚨 月度異常通報`,
        `小編：${name}`,
        `本月（${month}）累計異常：${count} 次`,
        `最新異常：${anomalyType}（${today}）`,
        ``,
        `請盡快與 ${name} 確認狀況。`,
      ].join('\n');
      await notifyAdminLine(client, alertMsg);
    }
  }
}

module.exports = { notifyAdminLine, sendEmailAlert, sendAnomalyAlert, sendDailySummary };
