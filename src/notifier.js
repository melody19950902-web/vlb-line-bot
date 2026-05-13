'use strict';
const nodemailer = require('nodemailer');

// ============================================================
// LINE 推播通知
// ============================================================

// 推播訊息給主管（私訊，非群組回覆）
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

// 發送電子郵件警報
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
// 組合警報（同時推播 LINE 和寄送 Email）
// ============================================================

// 發送工作日誌異常警報給主管
async function sendAnomalyAlert(client, { memberName, dayType, anomalies, date, status }) {
  const statusLabel = status === 'alert' ? '🚨 嚴重異常' : '⚠️ 警告';
  const anomalyLines = anomalies.map(a => `• ${a}`).join('\n');

  // LINE 推播內容
  const lineMsg = [
    `${statusLabel}｜工作日誌通知`,
    `小編：${memberName}`,
    `日期：${date}`,
    `類型：${dayType}`,
    ``,
    `異常項目：`,
    anomalyLines,
  ].join('\n');

  // Email 內容
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

module.exports = { notifyAdminLine, sendEmailAlert, sendAnomalyAlert };
