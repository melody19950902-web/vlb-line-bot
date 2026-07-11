'use strict';
const nodemailer = require('nodemailer');
const {
  getTodayLogs, getAllMemberNames, getLeaveRecordsForDate,
  getTaiwanDateString, getTaiwanTimeString,
  saveWorkLog, getTodayPublishReports,
  saveMonthlyRecord, getMonthlyAnomalies, getTaiwanMonthString,
  getSopSettings, getMonthLogs, saveMonthlyVideoStats,
} = require('./sheets');
const { parseWorkLog, analyzeWorkLog, applyCompLeaveAdjustment } = require('./analyzer');

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
    // 防重複：若「月度記錄」該月已存在「影片統計」列，代表本月已發過
    const existing = await getMonthlyAnomalies(month);
    if (existing.some(r => r[2] === '影片統計')) {
      console.log(`📊 月度影片統計已存在，略過重複發送：${month}`);
      return;
    }

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
// 工具：台灣時間今天是否為週六
// ============================================================

function isTaiwanSaturday() {
  const taiwanDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanDate.getDay() === 6;
}

function isTaiwanSunday() {
  const taiwanDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanDate.getDay() === 0;
}

// ============================================================
// 週六發布查核（只確認有無發布回報，不查工作日誌）
// ============================================================

async function sendSaturdaySummary(client) {
  const today = getTaiwanDateString();

  const [allMembers, leaveRecords, publishReportMap] = await Promise.all([
    getAllMemberNames(),
    getLeaveRecordsForDate(today),
    getTodayPublishReports(),
  ]);

  const leaveTypeMap = new Map();
  for (const r of leaveRecords) {
    if (r[2]) leaveTypeMap.set(r[2], r[4] || '請假');
  }

  const header = [`📢 VLB 週六發布查核 ${today}`, ``];
  const lines = [...header];
  const notPublished = [];

  for (const name of allMembers) {
    const leaveType = leaveTypeMap.get(name);
    if (leaveType === '病假') { lines.push(`🏥 ${name}｜病假`); continue; }
    if (leaveType === '事假') { lines.push(`📋 ${name}｜事假`); continue; }
    if (leaveType)            { lines.push(`🏖️ ${name}｜休假`); continue; }

    const reports = publishReportMap.get(name) || [];
    if (reports.length > 0) {
      lines.push(`✅ ${name}｜已發布`);
    } else {
      lines.push(`❗ ${name}｜未發布`);
      notPublished.push(name);
    }
  }

  lines.push(``);
  if (notPublished.length === 0) {
    lines.push(`全員已完成週六發布，辛苦了！`);
  } else {
    lines.push(`請 ${notPublished.join('、')} 確認發布狀況。`);
  }

  const msg = lines.join('\n');
  const groupEnabled = process.env.GROUP_NOTIFY_ENABLED === 'true';
  const tasks = [notifyAdminLine(client, msg)];
  if (groupEnabled) tasks.push(notifyGroup(client, msg));
  await Promise.all(tasks);

  console.log(`📢 週六發布查核已發送，未發布：${notPublished.length} 人`);
}

// ============================================================
// 每日 22:30 彙整（全 6 人逐人列出）
// ============================================================

async function sendDailySummary(client) {
  // 是否為台灣時區月底（明天進入下個月）
  const taiwanNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const twTomorrow = new Date(taiwanNow); twTomorrow.setDate(twTomorrow.getDate() + 1);
  const isMonthEnd = twTomorrow.getMonth() !== taiwanNow.getMonth();

  // 週日不執行任何彙整；月底仍發影片統計
  if (isTaiwanSunday()) {
    console.log('🔕 今日為週日，不執行彙整');
    if (isMonthEnd) {
      const members = await getAllMemberNames();
      await sendMonthlyVideoReport(client, getTaiwanMonthString(), members);
    }
    return;
  }

  // 週六只查發布，不查工作日誌；月底仍發影片統計
  if (isTaiwanSaturday()) {
    await sendSaturdaySummary(client);
    if (isMonthEnd) {
      const members = await getAllMemberNames();
      await sendMonthlyVideoReport(client, getTaiwanMonthString(), members);
    }
    return;
  }

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

  // 請假對照表：name → { type, hours }
  const leaveMap = new Map();
  for (const r of leaveRecords) {
    if (r[2]) leaveMap.set(r[2], { type: r[4] || '請假', hours: parseFloat(r[5]) || 0 });
  }
  // 補休時數：只有補休且有指定時數（如半天 4 小時）才回傳 > 0；整天補休回 0
  const compHoursOf = (name) => {
    const lv = leaveMap.get(name);
    return lv && lv.type === '補休' && lv.hours > 0 ? lv.hours : 0;
  };

  const minHours = parseFloat(sopSettings['最低工時_小時'] || '6');
  const hoursDetailMap = new Map(); // name → { actual: 實際時數, min: 該人套用的最低工時 }

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
      const comp = compHoursOf(name);
      const finalAnalysis = comp > 0
        ? applyCompLeaveAdjustment(analysis, parsedLog, { compHours: comp, minHours })
        : analysis;
      const time = getTaiwanTimeString();

      if (finalAnalysis.anomalies.includes('時數未達標準')) {
        hoursDetailMap.set(name, {
          actual: parsedLog.effectiveTotalHours,
          min: comp > 0 ? Math.max(0, minHours - comp) : minHours,
        });
      }

      await saveWorkLog({
        date: today, time, name, lineUserId: row[3],
        dayType: parsedLog.dayType, videoCount: parsedLog.videoCount,
        timeLog: mergedTimeLog, status: finalAnalysis.status,
        anomalies: finalAnalysis.anomalies, notes: parsedLog.notes || '',
      });

      // 更新 latestByName，讓下方彙整使用最終結果
      latestByName.set(name, [
        today, time, name, row[3],
        parsedLog.dayType, String(parsedLog.videoCount),
        mergedTimeLog, finalAnalysis.status,
        finalAnalysis.anomalies.join('；'), parsedLog.notes || '',
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

  const header = [`📊 VLB 今日工作回報 ${today}`, ``];
  const groupLines = [...header];
  const adminLines = [...header];

  const needsFollowUp = [];
  const monthlyToRecord = [];
  const notPublishedToday = [];

  for (const name of allMembers) {
    const leave = leaveMap.get(name);
    const comp = compHoursOf(name);
    console.log(`🔍 [22:30查核] ${name} | 請假=${leave ? leave.type : '無'}${comp > 0 ? `(補休${comp}小時)` : ''} | 工作日誌=${latestByName.has(name) ? '有' : '無'}`);

    // 整天請假（含整天補休）／其他假別 → 跳過工作日誌顯示（不查發布）
    if (leave && comp === 0) {
      if (leave.type === '病假') { groupLines.push(`🏥 ${name}｜病假`); adminLines.push(`🏥 ${name}｜病假`); continue; }
      if (leave.type === '事假') { groupLines.push(`📋 ${name}｜事假`); adminLines.push(`📋 ${name}｜事假`); continue; }
      groupLines.push(`🏖️ ${name}｜${leave.type}（已請假）`);
      adminLines.push(`🏖️ ${name}｜${leave.type}（已請假）`);
      continue;
    }
    // 補休半天：改走工作日誌顯示，並標註補休時數
    const compNote = comp > 0 ? `（補休${comp}小時）` : '';
    // 平日發布查核：只顯示與點名，不寫入月度記錄、不改 status
    const published = (publishReportMap.get(name) || []).length > 0;
    const pubNote = published ? '' : '｜📢未發布';
    if (!published) notPublishedToday.push(name);

    const row = latestByName.get(name);
    if (!row) {
      groupLines.push(`❗ ${name}｜未回報且未請假${compNote}${pubNote}`);
      adminLines.push(`❗ ${name}｜未回報且未請假${compNote}${pubNote}`);
      monthlyToRecord.push({ name, anomalyType: '未回報' });
      needsFollowUp.push(name);
    } else if (row[7] === 'pending') {
      groupLines.push(`❓ ${name}｜分析待確認${compNote}${pubNote}`);
      adminLines.push(`❓ ${name}｜分析待確認${compNote}${pubNote}`);
      needsFollowUp.push(name);
    } else if (row[7] === 'normal') {
      const line = `✅ ${name}｜正常${compNote}${pubNote}`;
      groupLines.push(line);
      adminLines.push(line);
    } else {
      const allAnomalies = (row[8] || '').split('；').filter(Boolean);
      const reason = allAnomalies[0];
      const emoji = row[7] === 'alert' ? '🚨' : '⚠️';
      groupLines.push(`${emoji} ${name}｜${reason}${compNote}${pubNote}`);

      // 主管版：若有時數異常，附上實際時數與不足量（用該人套用的最低工時）
      const hoursDetail = hoursDetailMap.get(name);
      let adminReason = reason;
      if (hoursDetail) {
        const baseMin = hoursDetail.min != null ? hoursDetail.min : minHours;
        const shortfall = Math.round((baseMin - hoursDetail.actual) * 10) / 10;
        const hoursNote = `時數未達標準（實際 ${hoursDetail.actual} 小時，不足 ${shortfall} 小時）`;
        if (reason === '時數未達標準') {
          adminReason = hoursNote;
        } else {
          adminReason = `${reason}（另：${hoursNote}）`;
        }
      }
      adminLines.push(`${emoji} ${name}｜${adminReason}${compNote}${pubNote}`);

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
      ? `${allMembers.length} 人全員正常，辛苦了！`
      : `${allMembers.length} 人狀態已確認。`,
    ...(needsFollowUp.length > 0 ? [`請 ${needsFollowUp.join('、')} 補充說明。`] : []),
    ...(notPublishedToday.length > 0 ? [`📢 今日尚未回報發布：${notPublishedToday.join('、')}，請補「已發布｜平台｜帳號」。`] : []),
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
    // 只計算 ⚠️異常 或 ❗未回報，排除請假類型與影片統計列
    const anomalyRecords = records.filter(r =>
      r[2] !== '影片統計' && !['病假','事假','特休','休假','補休'].includes(r[3]));
    const count = anomalyRecords.length;
    if (count >= 4) {
      const dateList = anomalyRecords.map(r => {
        const emoji = r[3] === '未回報' ? '❗' : '⚠️';
        return `${emoji} ${r[2]}`;
      }).join('、');

      const alertMsg = [
        `🚨 月度異常警示`,
        ``,
        `${name} 本月已累積 ${count} 次異常`,
        `（${dateList}）`,
        ``,
        `請主管留意並確認狀況。`,
      ].join('\n');
      await notifyAdminLine(client, alertMsg);
    }
  }));

  // 月底：發送當月影片統計（isMonthEnd 已於函式開頭以台灣時區計算）
  if (isMonthEnd) await sendMonthlyVideoReport(client, month, allMembers);
}

module.exports = { notifyAdminLine, notifyGroup, sendEmailAlert, sendAnomalyAlert, sendDailySummary, sendMonthlyVideoReport };
