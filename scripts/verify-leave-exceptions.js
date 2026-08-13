'use strict';
// 驗證：讀「請假例外」表，測 3 個日期
// - 2026/08/12：阿啾應在區間、吻仔魚應在區間
// - 2026/08/05：吻仔魚應在區間
// - 2026/08/17：兩人都不在
require('dotenv').config();
const { getLeaveExceptionsForDate, getAllLeaveExceptions } = require('../src/sheets');

async function main() {
  console.log('全部請假例外：');
  const all = await getAllLeaveExceptions();
  for (const ex of all) console.log(`  ${ex.name} | ${ex.leaveType} | ${ex.startDate} ~ ${ex.endDate} | ${ex.note}`);

  const cases = ['2026/08/05', '2026/08/12', '2026/08/13', '2026/08/17'];
  for (const d of cases) {
    const list = await getLeaveExceptionsForDate(d);
    console.log(`\n[${d}] 命中 ${list.length} 筆：`);
    for (const ex of list) console.log(`  ✅ ${ex.name} - ${ex.leaveType}`);
    if (list.length === 0) console.log('  (無)');
  }
}

main().catch(err => { console.error('❌ 失敗:', err.message); process.exit(1); });
