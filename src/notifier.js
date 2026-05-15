'use strict';
const nodemailer = require('nodemailer');
const { getTodayLogs, getAllMemberNames, getLeaveRecordsForDate, getTaiwanDateString } = require('./sheets');

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
// 每日 22:30 彙整（格式依規格書第 8 節）
// ============================================================

async function sendDailySummary(client) {
  const today = getTaiwanDateString();

  const [logs, allMembers, leaveRecords] = await Promise.all([
    getTodayLogs(),
    getAllMemberNames(),
    getLeaveRecordsForDate(today),
  ]);

  // 每人取最後一筆回報
  const latestByName = new Map();
  for (const row of logs) {
    if (row[2]) latestByName.set(row[2], row);
  }

  // 今日請假名單（取姓名欄，欄位索引 2）
  const leaveNames = new Set(leaveRecords.map(r => r[2]).filter(Boolean));

  const normalList   = [];
  const anomalyList  = []; // { name, reason }
  const absentList   = []; // 未回報且未請假
  const onLeaveList  = [];

  for (const name of allMembers) {
    if (leaveNames.has(name)) {
      onLeaveList.push(name);
      continue;
    }
    const row = latestByName.get(name);
    if (!row) {
      absentList.push(name);
    } else if (row[7] === 'normal') {
      normalList.push(name);
    } else {
      // warning 或 alert，附異常說明
      const reason = row[8] ? row[8].split('；')[0] : (row[7] === 'alert' ? '嚴重異常' : '有警告');
      anomalyList.push({ name, reason });
    }
  }

  // 全員正常且無人缺席
  if (anomalyList.length === 0 && absentList.length === 0) {
    const dateStr = today.replace(/\//g, '/');
    return notifyAdminLine(client, `✅ VLB ${dateStr} 全員回報正常，辛苦了！`);
  }

  // 有異常或缺報
  const dateStr = today;
  const lines = [`📊 VLB 今日工作回報 ${dateStr}`, ``];

  if (normalList.length > 0) {
    lines.push(`✅ 正常：${normalList.join('、')}`);
  }
  for (const { name, reason } of anomalyList) {
    lines.push(`⚠️ 異常：${name}｜${reason}`);
  }
  for (const name of absentList) {
    lines.push(`❗ 未回報且未請假：${name}（請確認狀況）`);
  }
  if (onLeaveList.length > 0) {
    lines.push(`🏖️ 休假：${onLeaveList.join('、')}（已請假）`);
  }

  if (anomalyList.length > 0) {
    lines.push(``, `請 ${anomalyList.map(a => a.name).join('、')} 補充說明。`);
  }

  return notifyAdminLine(client, lines.join('\n'));
}

module.exports = { notifyAdminLine, sendEmailAlert, sendAnomalyAlert, sendDailySummary };
