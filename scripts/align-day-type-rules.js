'use strict';
// 一次性 migration：把 Google Sheets「工作類型標準」分頁對齊到官方 11 列
// 使用方式：node scripts/align-day-type-rules.js
require('dotenv').config();
const { google } = require('googleapis');

const NEW_DAY_TYPE_ROWS = [
  ['工作類型', '最低影片數'],
  ['正常日', 3],
  ['跟拍日', 0],
  ['課程日', 0],
  ['大型活動日（拍照組）', 0],
  ['大型活動日（限動組）', 0],
  ['大型活動日（剪輯組）', 1],
  ['拍攝日', 1],
  ['Podcast日', 1],
  ['直播日', 1],
  ['外拍半天', 1],
  ['外拍一天', 0],
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  console.log('[讀取現況] 工作類型標準:');
  const before = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  for (const r of (before.data.values || [])) console.log('  ' + r.join(' | '));

  console.log('\n[清空並寫入新版] 共 ' + (NEW_DAY_TYPE_ROWS.length - 1) + ' 列資料');
  await sheets.spreadsheets.values.clear({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: '工作類型標準!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: NEW_DAY_TYPE_ROWS },
  });

  console.log('\n[讀回驗證]');
  const after = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  const rows = after.data.values || [];
  for (const r of rows) console.log('  ' + r.join(' | '));

  // 一致性檢查
  const expectedRows = NEW_DAY_TYPE_ROWS.map(r => r.map(String));
  const actualRows = rows.map(r => r.map(String));
  const consistent = JSON.stringify(actualRows) === JSON.stringify(expectedRows);
  console.log('\n' + (consistent ? '✅ 一致：Sheet 已對齊官方清單' : '❌ 不一致，請檢查'));
  if (!consistent) process.exit(1);
}

main().catch(err => {
  console.error('❌ 失敗:', err.message);
  process.exit(1);
});
