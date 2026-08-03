'use strict';
// 一次性 migration：建立「國定假日」分頁 + 預填 2026 下半年常見台灣國定假日
// 使用方式：node scripts/setup-holidays.js
// ⚠️ 預填清單僅供起始使用，請至行政院人事行政總處(DGPA)行事曆核對補齊
require('dotenv').config();
const { google } = require('googleapis');

const SHEET_TITLE = '國定假日';
const HEADER = ['日期', '名稱'];
// 2026 下半年（7 月以後）常見國定假日（含彈性補假可能）——需自行核對 DGPA
const HOLIDAYS_2026_H2 = [
  ['2026/09/25', '中秋節'],           // 農曆 8/15，2026 落在週五
  ['2026/10/09', '國慶日補假'],       // 若 DGPA 有安排補假（10/10 為週六）
  ['2026/10/10', '國慶日'],           // 週六
  // ↓ 以下依需要自行維護
  // ['2026/12/25', '聖誕節'],        // 非國定假日；填入僅為公司規則使用
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  // 檢查分頁是否存在
  const meta = await sheets.spreadsheets.get({
    spreadsheetId, fields: 'sheets.properties(sheetId,title)',
  });
  const exists = (meta.data.sheets || []).some(s => s.properties.title === SHEET_TITLE);

  if (!exists) {
    console.log(`[建立分頁] ${SHEET_TITLE}`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }] },
    });
    console.log('  ✅ 分頁已建立');
  } else {
    console.log(`[分頁已存在] ${SHEET_TITLE}，讀取現況：`);
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE}!A:B` });
    for (const r of (cur.data.values || [])) console.log('  ' + r.join(' | '));
  }

  // 讀現有列避免重複寫
  const before = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE}!A:B` });
  const rows = before.data.values || [];
  const existing = new Set(rows.slice(1).map(r => (r[0] || '').trim()));

  // 若 A1 空白 → 先寫標題
  if (rows.length === 0 || !rows[0] || rows[0][0] !== HEADER[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_TITLE}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER] },
    });
    console.log('  ✅ 標題已寫入');
  }

  const toAdd = HOLIDAYS_2026_H2.filter(r => !existing.has(r[0]));
  if (toAdd.length === 0) {
    console.log('\n  ℹ️ 預填清單全部已存在，無新增');
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${SHEET_TITLE}!A1`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAdd },
    });
    console.log(`\n  ✅ 追加 ${toAdd.length} 條：${toAdd.map(r => `${r[0]} ${r[1]}`).join('、')}`);
  }

  console.log('\n[驗證] 現況：');
  const after = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TITLE}!A:B` });
  for (const r of (after.data.values || [])) console.log('  ' + r.join(' | '));

  console.log('\n════════════════════════════════════════════════════');
  console.log('⚠️  重要提醒');
  console.log('════════════════════════════════════════════════════');
  console.log('  預填的 2026 下半年清單僅為起始資料，僅涵蓋中秋、國慶。');
  console.log('  請至【行政院人事行政總處】網站行事曆核對並補齊：');
  console.log('  https://www.dgpa.gov.tw/informationlist?uid=30');
  console.log('  ');
  console.log('  日後主管可直接在 Google Sheet「國定假日」分頁編輯：');
  console.log('  - A 欄：日期（YYYY/MM/DD 格式，例：2026/12/31）');
  console.log('  - B 欄：名稱（例：中秋節、國慶日補假）');
  console.log('  系統 10 分鐘內自動生效，不需重啟。');
}

main().catch(err => { console.error('❌ 失敗：', err.message); process.exit(1); });
