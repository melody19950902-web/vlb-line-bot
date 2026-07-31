'use strict';
// 一次性補跑：把 7/22~7/30 已進來但停在 pending 的工作日誌推進成最終狀態
// 沿用 22:30 的分析流程；不發任何 LINE 推播；不對缺席者回填「未回報」；月度記錄照寫（冪等）
// 使用方式：node scripts/backfill-pending.js
require('dotenv').config();
const {
  saveWorkLog, saveMonthlyRecord,
} = require('../src/sheets');
const { parseWorkLog, analyzeWorkLog, applyCompLeaveAdjustment } = require('../src/analyzer');
const { google } = require('googleapis');

const DATES = [
  '2026/07/22', '2026/07/23', '2026/07/24', '2026/07/25', '2026/07/26',
  '2026/07/27', '2026/07/28', '2026/07/29', '2026/07/30',
];

async function readAllRange(range) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID, range,
  });
  return res.data.values || [];
}

async function loadSopMinHours() {
  const rows = await readAllRange('SOP設定!A:B');
  if (rows.length < 2) return 6;
  for (const r of rows.slice(1)) {
    if ((r[0] || '').trim() === '最低工時_小時') return parseFloat(r[1]) || 6;
  }
  return 6;
}

function monthOf(dateStr) { return dateStr.substring(0, 7); }

async function processDate(date, allWorkLogs, allPublishReports, allLeaveRecords, minHours, outputByDate) {
  const todayLogs = allWorkLogs.filter(r => r[0] === date);
  const todayLeave = allLeaveRecords.filter(r => r[0] === date);

  // 發布回報 Map<姓名, string[]>
  const publishReportMap = new Map();
  for (const r of allPublishReports) {
    if (r[0] !== date || !r[2]) continue;
    if (!publishReportMap.has(r[2])) publishReportMap.set(r[2], []);
    publishReportMap.get(r[2]).push(r[4] || '');
  }

  // 請假對照表（含補休時數）
  const leaveMap = new Map();
  for (const r of todayLeave) {
    if (r[2]) leaveMap.set(r[2], { type: r[4] || '請假', hours: parseFloat(r[5]) || 0 });
  }
  const compHoursOf = (name) => {
    const lv = leaveMap.get(name);
    return lv && lv.type === '補休' && lv.hours > 0 ? lv.hours : 0;
  };

  // 每人取最後一筆
  const latestByName = new Map();
  for (const row of todayLogs) {
    if (row[2]) latestByName.set(row[2], row);
  }

  const perPersonOutput = [];
  const monthlyToRecord = [];

  for (const [name, row] of latestByName) {
    if (row[7] !== 'pending') {
      // 已有最終狀態，記錄現況給輸出，不重跑
      perPersonOutput.push({ name, status: row[7], anomalies: (row[8] || '').split('；').filter(Boolean), skipped: true });
      continue;
    }

    const publishLines = publishReportMap.get(name) || [];
    const mergedTimeLog = publishLines.length > 0 ? row[6] + '\n' + publishLines.join('\n') : row[6];
    const fullLogText = [
      `今日類型：${row[4]}`,
      `影片數量：${row[5]}`,
      `時間記錄：`,
      mergedTimeLog,
      row[9] ? `備註：${row[9]}` : '',
    ].filter(Boolean).join('\n');

    const parsedLog = parseWorkLog(fullLogText);
    if (parsedLog.error) {
      const failAnomalies = ['分析失敗，請人工確認'];
      await saveWorkLog({
        date, time: '22:30', name, lineUserId: row[3],
        dayType: row[4] || '未知', videoCount: parseInt(row[5]) || 0,
        timeLog: mergedTimeLog, status: 'warning',
        anomalies: failAnomalies, notes: row[9] || '',
      });
      perPersonOutput.push({ name, status: 'warning', anomalies: failAnomalies });
      continue;
    }

    try {
      const analysis = await analyzeWorkLog(parsedLog, name);
      const comp = compHoursOf(name);
      const finalAnalysis = comp > 0
        ? applyCompLeaveAdjustment(analysis, parsedLog, { compHours: comp, minHours })
        : analysis;

      await saveWorkLog({
        date, time: '22:30', name, lineUserId: row[3],
        dayType: parsedLog.dayType, videoCount: parsedLog.videoCount,
        timeLog: mergedTimeLog, status: finalAnalysis.status,
        anomalies: finalAnalysis.anomalies, notes: parsedLog.notes || '',
      });

      perPersonOutput.push({
        name, status: finalAnalysis.status, anomalies: finalAnalysis.anomalies,
        compNote: comp > 0 ? `補休${comp}h` : '',
      });

      if (finalAnalysis.status !== 'normal') {
        for (const a of finalAnalysis.anomalies) monthlyToRecord.push({ name, anomalyType: a });
      }
    } catch (err) {
      const failAnomalies = [`分析失敗：${err.message}`];
      await saveWorkLog({
        date, time: '22:30', name, lineUserId: row[3],
        dayType: row[4] || '未知', videoCount: parseInt(row[5]) || 0,
        timeLog: mergedTimeLog, status: 'warning',
        anomalies: failAnomalies, notes: row[9] || '',
      });
      perPersonOutput.push({ name, status: 'warning', anomalies: failAnomalies });
    }
  }

  // 寫入月度異常記錄（saveMonthlyRecord 已冪等去重）
  const month = monthOf(date);
  for (const { name, anomalyType } of monthlyToRecord) {
    await saveMonthlyRecord({ month, name, date, anomalyType });
  }

  outputByDate.set(date, perPersonOutput);
}

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('補跑 pending：7/22 ~ 7/30（不含 7/31）');
  console.log('════════════════════════════════════════════════════\n');

  console.log('讀取工作記錄、發布記錄、請假記錄、SOP設定 ...');
  const [allWorkLogs, allPublishReports, allLeaveRecords, minHours] = await Promise.all([
    readAllRange('工作記錄!A:J').then(r => r.slice(1)),
    readAllRange('發布記錄!A:E').then(r => r.slice(1)),
    readAllRange('請假記錄!A:F').then(r => r.slice(1)),
    loadSopMinHours(),
  ]);
  console.log(`  工作記錄 ${allWorkLogs.length}｜發布記錄 ${allPublishReports.length}｜請假記錄 ${allLeaveRecords.length}｜最低工時 ${minHours}h\n`);

  const outputByDate = new Map();
  for (const date of DATES) {
    const cnt = allWorkLogs.filter(r => r[0] === date && r[7] === 'pending').length;
    if (cnt === 0) {
      console.log(`── ${date} ── 無 pending，略過`);
      outputByDate.set(date, []);
      continue;
    }
    console.log(`── ${date} ── 處理 ${cnt} 筆 pending ...`);
    await processDate(date, allWorkLogs, allPublishReports, allLeaveRecords, minHours, outputByDate);
  }

  console.log('\n\n════════════════════════════════════════════════════');
  console.log('補跑結果總表');
  console.log('════════════════════════════════════════════════════');
  const emojiMap = { normal: '✅', warning: '⚠️', alert: '🚨' };
  for (const date of DATES) {
    const rows = outputByDate.get(date) || [];
    console.log(`\n${date}：`);
    if (rows.length === 0) { console.log('  （無 pending）'); continue; }
    for (const r of rows) {
      const e = emojiMap[r.status] || '❓';
      const suffix = r.skipped ? '（先前已最終化，未動）' : (r.compNote ? `（${r.compNote}）` : '');
      const anomText = r.anomalies && r.anomalies.length > 0 ? `｜${r.anomalies.join('；')}` : '';
      console.log(`  ${e} ${r.name} → ${r.status}${suffix}${anomText}`);
    }
  }

  console.log('\n✅ 完成');
}

main().catch(err => { console.error('❌ 補跑失敗：', err.message); process.exit(1); });
