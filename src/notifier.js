'use strict';
const nodemailer = require('nodemailer');
const {
  getTodayLogs, getAllMemberNames, getLeaveRecordsForDate,
  getTaiwanDateString, getTaiwanTimeString,
  saveWorkLog, getTodayPublishReports,
  saveMonthlyRecord, getMonthlyAnomalies, getTaiwanMonthString,
  getSopSettings, getMonthLogs, saveMonthlyVideoStats,
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

async function notifyGroup(client, message) {
  const groupId = process.env.LINE_GROUP_ID;
  if (!groupId) {
    console.warn('未設定 LINE_GROUP_ID，略過群組推播');
    return false;
  }
  try {
    await client.pushMessage({
      to:       groupId,
      messages: [{ type: 'text', text: message }],
    });
    console.log('✅ 群組 LINE 推播已發送');
    return true;
  } catch (err) {
    console.error('群組推播失敗：', err.message);
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
// 月底影片數量統計
// ============================================================

async function sendMonthlyVideoReport(client, month, allMembers) {
  try {
    const logs = await getMonthLogs(month);

    // 每人每天取最後一筆，再加總
    const latestPerDay = new Map(); // `${name}_${date}` → videoCount
    for (const row of logs) {
      if (!row[2] || !row[0]) continue;
      const key = `${row[2]}_${row[0]}`;
      latestPerDay.set(key, parseInt(row[5]) || 0);
    }

    const totalByMember = new Map();
    for (const [key, count] of latestPerDay) {
      const name = key.split('_')[0];
      totalByMember.set(name, (totalByMember.get(name) || 0) + count);
    }

    const [year, monthNum] = month.split('/');
    const lines = [`📊 VLB ${year}年${parseInt(monthNum)}月｜當月影片剪輯統計`, ``];

    let total = 0;
    for (const name of allMembers) {
      const count = totalByMember.get(name) || 0;
      total += count;
      lines.push(`${name}：${count} 支`);
    }
    lines.push(``, `團隊本月合計：${total} 支`);

    await notifyAdminLine(client, lines.join('\n'));

    // 寫入月度記錄
    for (const name of allMembers) {
      const count = totalByMember.get(name) || 0;
      await saveMonthlyVideoStats({ month, name, videoCount: count });
    }

    console.log(`📊 月度影片統計已發送：${month} 合計 ${total} 支`);
  } catch (err) {
    console.error('月度統計失敗：', err.message);
  }
}

// ============================================================
// 每日 22:30 彙整（全 6 人逐人列出）
// ============================================================

async function sendDailySummary(client) {
  const today = getTaiwanDateString();
  const month = getTaiwanMonthString();

  const [logs, allMembers, leaveRecords, publishReportMap, sopSettings] = await Promise.all([
    getTodayLogs(),
    getAllMemberNames(),
    getLeaveRecordsForDate(today),
    getTodayPublishReports(),
    getSopSettings(),
  ]);

  console.log(`📂 [請假記錄] 今日(${today})共 ${leaveRecords.length} 筆請假記錄：${leaveRecords.map(r => r[2]).join('、') || '無'}`);

  const minHours = parseFloat(sopSettings['最低工時_小時'] || '6');
  const hoursDetailMap = new Map(); // name → { actual: 實際時數 }

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
        // 解析失敗：更新為 warning，不讓 pending 卡死
        const time = getTaiwanTimeString();
        const failAnomalies = ['分析失敗，請人工確認'];
        await saveWorkLog({
          date: today, time, name, lineUserId: row[3],
          dayType: row[4] || '未知', videoCount: parseInt(row[5]) || 0,
          timeLog: mergedTimeLog, status: 'warning',
          anomalies: failAnomalies, notes: row[9] || '',
        });
        latestByName.set(name, [
          today, time, name, row[3],
          row[4] || '未知', row[5] || '0',
          mergedTimeLog, 'warning',
          failAnomalies.join('；'), row[9] || '',
        ]);
        continue;
      }

      const analysis = await analyzeWorkLog(parsedLog, name);
      const time = getTaiwanTimeString();

      if (analysis.anomalies.includes('時數未達標準')) {
        hoursDetailMap.set(name, { actual: parsedLog.effectiveTotalHours });
      }

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
      // 例外：更新為 warning，不讓 pending 卡死
      try {
        const time = getTaiwanTimeString();
        const failAnomalies = ['分析失敗，請人工確認'];
        await saveWorkLog({
          date: today, time, name, lineUserId: row[3],
          dayType: row[4] || '未知', videoCount: parseInt(row[5]) || 0,
          timeLog: row[6] || '', status: 'warning',
          anomalies: failAnomalies, notes: row[9] || '',
        });
        latestByName.set(name, [
          today, time, name, row[3],
          row[4] || '未知', row[5] || '0',
          row[6] || '', 'warning',
          failAnomalies.join('；'), row[9] || '',
        ]);
      } catch (saveErr) {
        console.error(`22:30 寫入失敗記錄也失敗 ${name}：`, saveErr.message);
      }
    }
  }

  // 請假類型對照表 { name → leaveType }
  const leaveTypeMap = new Map();
  for (const r of leaveRecords) {
    if (r[2]) leaveTypeMap.set(r[2], r[4] || '請假');
  }

  const header = [`📊 VLB 今日工作回報 ${today}`, ``];
  const groupLines = [...header];
  const adminLines = [...header];

  const needsFollowUp = [];
  const monthlyToRecord = [];

  for (const name of allMembers) {
    console.log(`🔍 [22:30查核] ${name} | 請假=${leaveTypeMap.get(name) || '無'} | 工作日誌=${latestByName.has(name) ? '有' : '無'}`);
    const leaveType = leaveTypeMap.get(name);

    if (leaveType === '病假') {
      groupLines.push(`🏥 ${name}｜病假`);
      adminLines.push(`🏥 ${name}｜病假`);
      continue;
    }
    if (leaveType === '事假') {
      groupLines.push(`📋 ${name}｜事假`);
      adminLines.push(`📋 ${name}｜事假`);
      continue;
    }
    if (leaveType) {
      groupLines.push(`🏖️ ${name}｜休假（已請假）`);
      adminLines.push(`🏖️ ${name}｜休假（已請假）`);
      continue;
    }

    const row = latestByName.get(name);
    if (!row) {
      groupLines.push(`❗ ${name}｜未回報且未請假`);
      adminLines.push(`❗ ${name}｜未回報且未請假`);
      monthlyToRecord.push({ name, anomalyType: '未回報' });
      needsFollowUp.push(name);
    } else if (row[7] === 'pending') {
      groupLines.push(`❓ ${name}｜分析待確認`);
      adminLines.push(`❓ ${name}｜分析待確認`);
      needsFollowUp.push(name);
    } else if (row[7] === 'normal') {
      const isSpecialDay = /外拍半天|外拍一天|課程拍攝|直播\s*\d|活動外拍/.test(row[4] || '');
      const line = isSpecialDay ? `✅ ${name}｜${row[4]}` : `✅ ${name}｜達成工作標準`;
      groupLines.push(line);
      adminLines.push(line);
    } else {
      const allAnomalies = (row[8] || '').split('；').filter(Boolean);
      const reason = allAnomalies[0];
      const emoji = row[7] === 'alert' ? '🚨' : '⚠️';
      groupLines.push(`${emoji} ${name}｜${reason}`);

      // 主管版：若有時數異常，附上實際時數與不足量
      const hoursDetail = hoursDetailMap.get(name);
      let adminReason = reason;
      if (hoursDetail) {
        const shortfall = Math.round((minHours - hoursDetail.actual) * 10) / 10;
        const hoursNote = `時數未達標準（實際 ${hoursDetail.actual} 小時，不足 ${shortfall} 小時）`;
        if (reason === '時數未達標準') {
          adminReason = hoursNote;
        } else {
          adminReason = `${reason}（另：${hoursNote}）`;
        }
      }
      adminLines.push(`${emoji} ${name}｜${adminReason}`);

      for (const anomalyType of allAnomalies) {
        monthlyToRecord.push({ name, anomalyType });
      }
      needsFollowUp.push(name);
    }
  }

  const allNormal = needsFollowUp.length === 0;
  const footer = [
    ``,
    allNormal
      ? `${allMembers.length} 人全員達成工作標準，辛苦了！`
      : `${allMembers.length} 人狀態已確認。`,
    ...(needsFollowUp.length > 0 ? [`請 ${needsFollowUp.join('、')} 補充說明。`] : []),
  ];
  groupLines.push(...footer);
  adminLines.push(...footer);

  // 群組推播開關：穩定觀察期間僅推給主管，待後台穩定後設為 true
  const groupEnabled = process.env.GROUP_NOTIFY_ENABLED === 'true';
  const tasks = [notifyAdminLine(client, adminLines.join('\n'))];
  if (groupEnabled) {
    tasks.push(notifyGroup(client, groupLines.join('\n')));
  } else {
    console.log('🔕 GROUP_NOTIFY_ENABLED 未開啟，本次彙整僅推播主管');
  }
  await Promise.all(tasks);

  // 月度異常記錄與達標通報（並行化）
  await Promise.all(monthlyToRecord.map(async ({ name, anomalyType }) => {
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
  }));

  // 月底：發送當月影片統計
  const todayDate = new Date();
  const tomorrowDate = new Date(todayDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  if (tomorrowDate.getMonth() !== todayDate.getMonth()) {
    await sendMonthlyVideoReport(client, month, allMembers);
  }
}

module.exports = { notifyAdminLine, notifyGroup, sendEmailAlert, sendAnomalyAlert, sendDailySummary, sendMonthlyVideoReport };
