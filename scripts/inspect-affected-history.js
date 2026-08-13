'use strict';
// 檢查請假例外覆蓋期間內，工作記錄 & 月度記錄 是否有被誤標的資料
// 只讀不寫，用於決定補正範圍
require('dotenv').config();
const { google } = require('googleapis');

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  const exceptions = [
    { name: '吻仔魚', id: 'Ub50fcdc4414a2d54f36add1c876f5eae', type: '公假', start: '2026/08/01', end: '2026/08/16' },
    { name: '阿啾',   id: 'U1604db7615d2864557e6110e981ef503', type: '特休', start: '2026/08/12', end: '2026/08/13' },
  ];

  function daysInRange(start, end) {
    const [ys, ms, ds] = start.split('/').map(Number);
    const [ye, me, de] = end.split('/').map(Number);
    const s = new Date(ys, ms - 1, ds);
    const e = new Date(ye, me - 1, de);
    const days = [];
    for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      days.push(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
    }
    return days;
  }

  // 讀工作記錄
  const workRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: '工作記錄!A:K' });
  const workRows = workRes.data.values || [];
  console.log(`工作記錄總筆數：${workRows.length - 1}`);

  // 讀月度記錄
  const monRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: '月度記錄!A:D' });
  const monRows = monRes.data.values || [];
  console.log(`月度記錄總筆數：${monRows.length - 1}\n`);

  for (const ex of exceptions) {
    const days = new Set(daysInRange(ex.start, ex.end));
    console.log(`═══ ${ex.name}｜${ex.type}｜${ex.start} ~ ${ex.end}（共 ${days.size} 天） ═══`);

    // 工作記錄命中：以 ID 為主
    const workHits = workRows.slice(1).filter(r => {
      const date = (r[0] || '').trim();
      const id = (r[3] || '').trim();
      const name = (r[2] || '').trim();
      return days.has(date) && (id === ex.id || (!id && name === ex.name));
    });
    console.log(`  工作記錄命中 ${workHits.length} 筆：`);
    for (const r of workHits) {
      console.log(`    ${r[0]} ${r[1]} | ${r[2]} | 類型=${r[4]} | 狀態=${r[7]} | 異常=${(r[8] || '').slice(0, 60)}`);
    }

    // 月度記錄命中：僅比對姓名（月度記錄只有姓名，沒有 ID）
    const monHits = monRows.slice(1).filter(r => {
      const name = (r[1] || '').trim();
      const date = (r[2] || '').trim();
      return days.has(date) && name === ex.name;
    });
    console.log(`  月度記錄命中 ${monHits.length} 筆：`);
    for (const r of monHits) {
      console.log(`    ${r[0]} | ${r[1]} | ${r[2]} | 異常類型=${r[3]}`);
    }
    console.log();
  }
}

main().catch(err => { console.error('❌ 失敗:', err.message); process.exit(1); });
