'use strict';
// 一次性 migration：
// (1) SOP設定 新增 每週最低影片數/每週最低輪播數/產能檢查啟用日
// (2) 工作記錄 K1 標題「輪播數量」
// 使用方式：node scripts/setup-productivity-config.js
require('dotenv').config();
const { google } = require('googleapis');

const NEW_SOP_ROWS = [
  ['每週最低影片數', '12'],
  ['每週最低輪播數', '6'],
  ['產能檢查啟用日', '2026/08/03'],
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  // (1) SOP設定
  console.log('[SOP設定] 現況：');
  const sopBefore = await sheets.spreadsheets.values.get({
    spreadsheetId, range: 'SOP設定!A:B',
  });
  const existing = new Set((sopBefore.data.values || []).slice(1).map(r => (r[0] || '').trim()));
  for (const r of (sopBefore.data.values || [])) console.log('  ' + r.join(' | '));

  const toAdd = NEW_SOP_ROWS.filter(r => !existing.has(r[0]));
  if (toAdd.length === 0) {
    console.log('\n  ℹ️ SOP設定 三條皆已存在，略過');
  } else {
    console.log(`\n  ✅ 追加 ${toAdd.length} 條：${toAdd.map(r => r[0]).join('、')}`);
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: 'SOP設定!A1',
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAdd },
    });
  }

  console.log('\n[SOP設定] 更新後：');
  const sopAfter = await sheets.spreadsheets.values.get({
    spreadsheetId, range: 'SOP設定!A:B',
  });
  for (const r of (sopAfter.data.values || [])) console.log('  ' + r.join(' | '));

  // (2) 工作記錄 K1
  console.log('\n[工作記錄 K1] 現況：');
  const k1Before = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作記錄!K1',
  });
  const k1Val = (k1Before.data.values || [[]])[0][0] || '(空)';
  console.log(`  K1 = ${k1Val}`);
  if (k1Val === '輪播數量') {
    console.log('  ℹ️ K1 已是「輪播數量」，略過');
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: '工作記錄!K1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['輪播數量']] },
    });
    console.log('  ✅ K1 已寫入「輪播數量」');
  }

  const k1After = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作記錄!K1',
  });
  console.log(`  驗證 K1 = ${(k1After.data.values || [[]])[0][0] || '(空)'}`);

  console.log('\n✅ 完成');
}

main().catch(err => { console.error('❌ 失敗：', err.message); process.exit(1); });
