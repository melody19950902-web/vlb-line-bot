'use strict';
// 一次性 migration：清除「月度記錄」中，落在「請假例外」區間內的異常紀錄
// - 只刪 (姓名 == 請假例外中的人) AND (異常日期 在該人的 startDate~endDate 間)
//   AND (異常類型 != '影片統計')  ← 影片統計是月度彙總，不能誤刪
// - 支援 --dry-run：只列出、不寫入
// 使用方式：
//   node scripts/backfill-leave-exception-anomalies.js --dry-run
//   node scripts/backfill-leave-exception-anomalies.js
require('dotenv').config();
const { google } = require('googleapis');

const DRY = process.argv.includes('--dry-run');
const SHEET_TITLE_MONTHLY   = '月度記錄';
const SHEET_TITLE_EXCEPTION = '請假例外';

function daysInRange(start, end) {
  const [ys, ms, ds] = start.split('/').map(Number);
  const [ye, me, de] = end.split('/').map(Number);
  const s = new Date(ys, ms - 1, ds);
  const e = new Date(ye, me - 1, de);
  const out = new Set();
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.add(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  // 1) 讀請假例外
  const exRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE_EXCEPTION}!A:F` });
  const exRows = exRes.data.values || [];
  const exceptions = exRows.slice(1)
    .filter(r => (r[0] || '').trim() && (r[3] || '').trim() && (r[4] || '').trim())
    .map(r => ({
      name: r[0].trim(), leaveType: r[2].trim(),
      startDate: r[3].trim(), endDate: r[4].trim(),
    }));
  if (exceptions.length === 0) {
    console.log('請假例外沒有任何資料，無需 backfill。');
    return;
  }
  console.log(`請假例外共 ${exceptions.length} 筆：`);
  for (const ex of exceptions) console.log(`  ${ex.name} | ${ex.leaveType} | ${ex.startDate} ~ ${ex.endDate}`);

  // 建 (name → Set<date>) 索引
  const rangeByName = new Map();
  for (const ex of exceptions) {
    const set = rangeByName.get(ex.name) || new Set();
    for (const d of daysInRange(ex.startDate, ex.endDate)) set.add(d);
    rangeByName.set(ex.name, set);
  }

  // 2) 讀月度記錄
  const monRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE_MONTHLY}!A:D` });
  const monRows = monRes.data.values || [];
  console.log(`\n月度記錄總筆數：${monRows.length - 1}`);

  // 找出要刪的 row 索引（0-based，含標題列，所以資料從 index 1 開始）
  const toDelete = [];
  for (let i = 1; i < monRows.length; i++) {
    const [_month, name, date, anomalyType] = monRows[i].map(v => (v || '').trim());
    if (!name || !date) continue;
    if (anomalyType === '影片統計') continue;                          // 保留月度彙總
    const range = rangeByName.get(name);
    if (!range) continue;
    if (!range.has(date)) continue;
    toDelete.push({ idx: i, row: monRows[i] });
  }

  if (toDelete.length === 0) {
    console.log('\n✅ 沒有需要清除的誤標紀錄。');
    return;
  }

  console.log(`\n${DRY ? '[DRY-RUN] ' : ''}命中 ${toDelete.length} 筆將被${DRY ? '刪除（模擬）' : '刪除'}：`);
  for (const d of toDelete) console.log(`  第 ${d.idx + 1} 列 | ${d.row.join(' | ')}`);

  if (DRY) {
    console.log('\n(此為 dry-run，未實際變更。加上 --no-dry-run 或直接不帶 --dry-run 執行即可實刪。)');
    return;
  }

  // 3) 取得 sheetId 並反向刪除（從最後一列往前刪，避免索引位移）
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const props = (meta.data.sheets || []).find(s => s.properties.title === SHEET_TITLE_MONTHLY);
  if (!props) throw new Error(`找不到分頁：${SHEET_TITLE_MONTHLY}`);
  const sheetId = props.properties.sheetId;

  const requests = toDelete
    .slice()
    .sort((a, b) => b.idx - a.idx)
    .map(d => ({ deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: d.idx, endIndex: d.idx + 1 },
    } }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log(`\n✅ 已刪除 ${toDelete.length} 筆誤標。`);

  // 4) 讀回驗證：對每個人再次比對，應為 0 筆
  const afterRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE_MONTHLY}!A:D` });
  const afterRows = afterRes.data.values || [];
  let stillBad = 0;
  for (let i = 1; i < afterRows.length; i++) {
    const [_m, name, date, anomalyType] = afterRows[i].map(v => (v || '').trim());
    if (anomalyType === '影片統計') continue;
    const range = rangeByName.get(name);
    if (range && range.has(date)) stillBad++;
  }
  console.log(`\n[讀回驗證] 剩餘應為 0 → 實際 ${stillBad} 筆 ${stillBad === 0 ? '✅' : '❌'}`);
}

main().catch(err => { console.error('❌ 失敗:', err.message); process.exit(1); });
