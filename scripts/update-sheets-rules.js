'use strict';
// 一次性 migration:更新「工作類型標準」與「任務時間標準」兩個分頁
// 使用方式:node scripts/update-sheets-rules.js
require('dotenv').config();
const { google } = require('googleapis');

const NEW_DAY_TYPE_ROWS = [
  ['工作類型', '最低影片數'],
  ['正常日', 3],
  ['拍攝日', 1],
  ['Podcast日', 1],
  ['課程日', 0],
  ['外拍半天', 1],
  ['外拍一天', 0],
  ['直播日', 2],
];

const NEW_TASK_ROWS = [
  ['Podcast錄製',      60, 120, 150],
  ['Podcast上稿',      20, 60,  90 ],
  ['Podcast設備',      20, 45,  60 ],
  ['修Podcast照片',    30, 60,  90 ],
  ['撰寫Podcast文案',  60, 90,  120],
  ['撰寫修改輪播貼文',  30, 60,  90 ],
  ['修改剪輯指令',     15, 30,  45 ],
  ['生成文章重點',     30, 60,  90 ],
  ['影片排程',         15, 30,  45 ],
  ['試妝',            30, 60,  90 ],
  ['巧睫新片素材',     30, 60,  90 ],
];

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  // ===== 1. 工作類型標準:讀現況、清空、寫入新版 =====
  console.log('\n[1/2] 處理「工作類型標準」分頁...');
  const dayTypeOld = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  console.log(`  現有 ${(dayTypeOld.data.values || []).length} 列,將替換為 ${NEW_DAY_TYPE_ROWS.length} 列`);
  console.log('  舊內容:');
  for (const r of (dayTypeOld.data.values || [])) console.log('    ' + r.join(' | '));

  await sheets.spreadsheets.values.clear({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: '工作類型標準!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: NEW_DAY_TYPE_ROWS },
  });
  console.log('  ✅ 已寫入新版日類型');

  // ===== 2. 任務時間標準:讀現況、append 新項目(不動既有) =====
  console.log('\n[2/2] 處理「任務時間標準」分頁...');
  const taskOld = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '任務時間標準!A:D',
  });
  const existing = new Set((taskOld.data.values || []).slice(1).map(r => (r[0] || '').trim()));
  console.log(`  現有 ${existing.size} 項任務規則`);

  const toAppend = NEW_TASK_ROWS.filter(r => !existing.has(r[0]));
  const skipped = NEW_TASK_ROWS.filter(r => existing.has(r[0]));
  if (skipped.length > 0) {
    console.log(`  跳過已存在的 ${skipped.length} 項:${skipped.map(r => r[0]).join('、')}`);
  }

  if (toAppend.length === 0) {
    console.log('  ℹ️  沒有新項目要寫入');
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: '任務時間標準!A1',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend },
    });
    console.log(`  ✅ 已新增 ${toAppend.length} 項:${toAppend.map(r => r[0]).join('、')}`);
  }

  // ===== 驗證 =====
  console.log('\n=== 驗證最終結果 ===');
  const finalDay = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '工作類型標準!A:B',
  });
  console.log('\n工作類型標準:');
  for (const r of (finalDay.data.values || [])) console.log('  ' + r.join(' | '));

  const finalTask = await sheets.spreadsheets.values.get({
    spreadsheetId, range: '任務時間標準!A:D',
  });
  console.log(`\n任務時間標準:共 ${(finalTask.data.values || []).length - 1} 項規則`);
  for (const r of (finalTask.data.values || [])) console.log('  ' + r.join(' | '));

  console.log('\n✅ 完成');
}

main().catch(err => {
  console.error('❌ 失敗:', err.message);
  process.exit(1);
});
