'use strict';
// 一次性診斷：22:30 每日彙整沒有發、主管查詢沒回應
// 使用方式：node scripts/diagnose-summary.js
require('dotenv').config();
const { google } = require('googleapis');

const RENDER_URL = 'https://vlb-line-bot.onrender.com/';

function getTaiwanDateString(date = new Date()) {
  return date.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function lastNDates(n) {
  const dates = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(getTaiwanDateString(d));
  }
  return dates;
}

async function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readRange(sheets, range) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID, range,
    });
    return res.data.values || [];
  } catch (err) {
    console.error(`  ⚠️ 讀取 ${range} 失敗：${err.message}`);
    return [];
  }
}

async function step1_workLogs(sheets, recentDates) {
  console.log('════════════════════════════════════════════════════');
  console.log('步驟 1｜工作記錄 最近 10 天');
  console.log('════════════════════════════════════════════════════');
  const rows = await readRange(sheets, '工作記錄!A:J');
  if (rows.length < 2) { console.log('  (無資料)'); return {}; }

  const byDate = new Map();
  for (const row of rows.slice(1)) {
    const [date, time, name, , dayType, videoCount, , status] = row;
    if (!date || !recentDates.includes(date)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ time: time || '', name: name || '?', status: status || '', dayType: dayType || '', videoCount: videoCount || '' });
  }

  const ranSummary = new Set();
  const noSummary = new Set();
  for (const date of recentDates.slice().reverse()) {
    const entries = byDate.get(date) || [];
    if (entries.length === 0) { console.log(`\n${date}（${dayLabel(date)}）：無任何回報`); noSummary.add(date); continue; }

    console.log(`\n${date}（${dayLabel(date)}）：${entries.length} 筆`);
    // 依姓名 group，每人取所有時間點
    const byName = new Map();
    for (const e of entries) {
      if (!byName.has(e.name)) byName.set(e.name, []);
      byName.get(e.name).push(e);
    }
    let hasLateSummary = false;
    for (const [name, es] of byName) {
      const times = es.map(e => `${e.time}[${e.status || '?'}]`).join(' → ');
      console.log(`  ${name}｜${times}`);
      // 是否有 22:3x 且狀態非 pending
      if (es.some(e => /^22:3\d$/.test(e.time) && e.status && e.status !== 'pending')) {
        hasLateSummary = true;
      }
    }
    if (hasLateSummary) ranSummary.add(date);
    else noSummary.add(date);
  }

  console.log('\n── 22:30 排程執行判定 ──');
  console.log(`  ✅ 有跑 22:30 的日期（有 22:3x 最終分析列）：${[...ranSummary].sort().join('、') || '(無)'}`);
  console.log(`  ❌ 沒跑 22:30 的日期（僅 pending 或無資料）：${[...noSummary].sort().join('、') || '(無)'}`);

  return { ranSummary, noSummary, byDate };
}

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split('/').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return ['日','一','二','三','四','五','六'][day];
}

async function step2_otherSheets(sheets, recentDates) {
  console.log('\n════════════════════════════════════════════════════');
  console.log('步驟 2｜其他分頁最近狀況');
  console.log('════════════════════════════════════════════════════');
  const targets = [
    { name: '發布記錄', range: '發布記錄!A:E', dateCol: 0 },
    { name: '請假記錄', range: '請假記錄!A:F', dateCol: 0 },
    { name: '月度記錄', range: '月度記錄!A:D', dateCol: 2 }, // 月度記錄第 3 欄是異常日期
  ];
  for (const t of targets) {
    const rows = await readRange(sheets, t.range);
    if (rows.length < 2) { console.log(`\n${t.name}：無資料`); continue; }
    const data = rows.slice(1);
    const recent = data.filter(r => recentDates.includes(r[t.dateCol]));
    const lastDate = data.map(r => r[t.dateCol]).filter(Boolean).sort().pop();
    console.log(`\n${t.name}：`);
    console.log(`  總列數：${data.length}｜最後一筆日期：${lastDate || '(無)'}｜最近 10 天內：${recent.length} 筆`);
    if (recent.length > 0) {
      const grouped = new Map();
      for (const r of recent) {
        const d = r[t.dateCol];
        grouped.set(d, (grouped.get(d) || 0) + 1);
      }
      for (const date of recentDates.slice().reverse()) {
        if (grouped.has(date)) console.log(`    ${date}：${grouped.get(date)} 筆`);
      }
    }
  }
}

async function step3_sleepCheck() {
  console.log('\n════════════════════════════════════════════════════');
  console.log('步驟 3｜Render 服務睡眠檢查（連續 2 次 GET）');
  console.log('════════════════════════════════════════════════════');
  for (let i = 1; i <= 2; i++) {
    const t0 = Date.now();
    let status = '?', body = '';
    try {
      const res = await fetch(RENDER_URL, { signal: AbortSignal.timeout(60000) });
      status = res.status;
      body = (await res.text()).trim();
    } catch (err) {
      status = `錯誤 ${err.message}`;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`  第 ${i} 次：HTTP ${status}｜耗時 ${dt}s｜回應：${body.slice(0, 60)}`);
  }
  console.log('  判讀：第一次 > 10 秒 + 第二次 < 3 秒 → 服務剛從休眠喚醒（冷啟動）');
}

async function step4_indexJs() {
  console.log('\n════════════════════════════════════════════════════');
  console.log('步驟 4｜index.js 排程邏輯檢查');
  console.log('════════════════════════════════════════════════════');
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
  const hasGTE = /if \(now >= '22:30'/.test(src);
  const hasLast = /lastSummaryDate/.test(src);
  const hasInterval = /setInterval.*60.*1000|setInterval.*\* 1000/.test(src);
  console.log(`  now >= '22:30' 條件：${hasGTE ? '✅' : '❌'}`);
  console.log(`  lastSummaryDate 守門：${hasLast ? '✅' : '❌'}`);
  console.log(`  setInterval 每 60 秒：${hasInterval ? '✅' : '❌'}`);
}

async function main() {
  const nowTW = getTaiwanDateString();
  console.log(`診斷時間（台灣）：${nowTW}`);
  const sheets = await getSheets();
  const recentDates = lastNDates(10);

  const summary = await step1_workLogs(sheets, recentDates);
  await step2_otherSheets(sheets, recentDates);
  await step3_sleepCheck();
  await step4_indexJs();

  console.log('\n════════════════════════════════════════════════════');
  console.log('結論');
  console.log('════════════════════════════════════════════════════');
  // 用步驟 1 結果判斷
  const ran = summary.ranSummary || new Set();
  const no  = summary.noSummary  || new Set();
  const hasAnyRecent = [...(summary.byDate?.values() || [])].some(v => v.length > 0);
  console.log(`  10 天內有 ${ran.size} 天成功跑完 22:30 彙整、${no.size} 天沒跑`);
  console.log(`  10 天內是否有任何工作記錄進來：${hasAnyRecent ? '有' : '否'}`);
}

main().catch(err => { console.error('❌ 診斷失敗：', err.message); process.exit(1); });
