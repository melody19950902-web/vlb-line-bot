'use strict';
// 一次性 migration：建立「請假例外」分頁 + 預填 8 月已核准的長期請假區間
// 使用方式：node scripts/setup-leave-exceptions.js
//
// 「請假例外」與「請假記錄」的差異：
// - 請假記錄：LINE 訊息驅動（例：小編傳「今日病假」），單日、當下寫入
// - 請假例外：主管手動設定的長期請假區間（起訖日期），22:30 判定時會優先套用
require('dotenv').config();
const { google } = require('googleapis');

const SHEET_TITLE = '請假例外';
const HEADER = ['姓名', 'LINE_User_ID', '假別', '開始日期', '結束日期', '備註'];
const EXCEPTIONS = [
  ['吻仔魚', 'Ub50fcdc4414a2d54f36add1c876f5eae', '公假', '2026/08/01', '2026/08/16', '8/17 回來上班'],
  ['阿啾',   'U1604db7615d2864557e6110e981ef503', '特休', '2026/08/12', '2026/08/13', ''],
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

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
    console.log(`[分頁已存在] ${SHEET_TITLE}`);
  }

  const before = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${SHEET_TITLE}!A:F`,
  });
  const rows = before.data.values || [];

  // 若標題列不對 → 覆寫
  const headerOk = rows.length > 0 && HEADER.every((h, i) => (rows[0][i] || '') === h);
  if (!headerOk) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_TITLE}!A1:F1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER] },
    });
    console.log('  ✅ 標題已寫入 / 修正');
  }

  // 去重鍵：LINE_User_ID + 開始日期 + 結束日期
  const keyOf = r => `${(r[1] || '').trim()}|${(r[3] || '').trim()}|${(r[4] || '').trim()}`;
  const existing = new Set(rows.slice(1).map(keyOf));
  const toAdd = EXCEPTIONS.filter(r => !existing.has(keyOf(r)));

  if (toAdd.length === 0) {
    console.log('\n  ℹ️ 預填清單全部已存在，無新增');
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${SHEET_TITLE}!A1`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAdd },
    });
    console.log(`\n  ✅ 追加 ${toAdd.length} 條：`);
    for (const r of toAdd) console.log('     ' + r.join(' | '));
  }

  console.log('\n[讀回驗證] 現況：');
  const after = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${SHEET_TITLE}!A:F`,
  });
  for (const r of (after.data.values || [])) console.log('  ' + (r || []).join(' | '));

  console.log('\n════════════════════════════════════════════════════');
  console.log('  主管日後可直接在 Google Sheet「請假例外」分頁編輯：');
  console.log('  - A：姓名');
  console.log('  - B：LINE_User_ID（比對主鍵；抓成員名單裡的 U 開頭字串）');
  console.log('  - C：假別（公假/特休/事假/病假/補休等）');
  console.log('  - D：開始日期（YYYY/MM/DD，例：2026/08/01）');
  console.log('  - E：結束日期（YYYY/MM/DD，含當日）');
  console.log('  - F：備註（選填）');
  console.log('  系統 10 分鐘內自動生效，不需重啟。');
  console.log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('❌ 失敗：', err.message); process.exit(1); });
