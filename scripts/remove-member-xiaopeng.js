'use strict';
// 一次性 migration：從 Google Sheets「成員名單」分頁移除離職成員「小彭」
// 使用方式：node scripts/remove-member-xiaopeng.js
require('dotenv').config();
const { google } = require('googleapis');

const TARGET_NAME = '小彭';
const SHEET_TITLE = '成員名單';

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  console.log(`[讀取現況] ${SHEET_TITLE}:`);
  const before = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${SHEET_TITLE}!A:B`,
  });
  const rows = before.data.values || [];
  for (const r of rows) console.log('  ' + (r || []).join(' | '));

  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === TARGET_NAME) { idx = i; break; }
  }

  if (idx === -1) {
    console.log(`\n✅ 找不到 ${TARGET_NAME}，可能已被移除，無動作。`);
    return;
  }

  // 取得該分頁的 numeric sheetId
  const meta = await sheets.spreadsheets.get({
    spreadsheetId, fields: 'sheets.properties(sheetId,title)',
  });
  const sheetProps = (meta.data.sheets || []).find(s => s.properties.title === SHEET_TITLE);
  if (!sheetProps) throw new Error(`找不到分頁：${SHEET_TITLE}`);
  const sheetId = sheetProps.properties.sheetId;

  console.log(`\n[刪除] ${SHEET_TITLE} 第 ${idx + 1} 列（0-based=${idx}）：${rows[idx].join(' | ')}`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
    } }] },
  });

  console.log('\n[讀回驗證]');
  const after = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${SHEET_TITLE}!A:B`,
  });
  const afterRows = after.data.values || [];
  for (const r of afterRows) console.log('  ' + (r || []).join(' | '));

  const stillThere = afterRows.slice(1).some(r => (r[0] || '').trim() === TARGET_NAME);
  console.log('\n' + (stillThere ? `❌ 仍有 ${TARGET_NAME}，請檢查` : `✅ 名單已無 ${TARGET_NAME}`));
  if (stillThere) process.exit(1);
}

main().catch(err => {
  console.error('❌ 失敗:', err.message);
  process.exit(1);
});
