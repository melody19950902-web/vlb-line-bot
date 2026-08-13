'use strict';
// 模擬 22:30 判定邏輯（不寫入、不推播）
// 驗證：
//   1) 8/12 阿啾、吻仔魚 應被視為請假（來自請假例外），不列未回報
//   2) 8/5  吻仔魚 應被視為請假
//   3) 8/14（今天）不在區間 → 行為不變
require('dotenv').config();
const { getAllMemberNames, getAllMembers, getLeaveRecordsForDate, getLeaveExceptionsForDate } = require('../src/sheets');

async function simulate(dateStr) {
  const [allMembers, members, leaveRecords, leaveExceptions] = await Promise.all([
    getAllMemberNames(),
    getAllMembers(),
    getLeaveRecordsForDate(dateStr),
    getLeaveExceptionsForDate(dateStr),
  ]);

  const idToName = new Map(members.filter(m => m.id).map(m => [m.id, m.name]));
  const leaveMap = new Map();
  for (const r of leaveRecords) {
    const name = idToName.get((r[3] || '').trim()) || (r[2] || '').trim();
    if (name) leaveMap.set(name, { type: r[4] || '請假', hours: parseFloat(r[5]) || 0, source: 'LINE 請假記錄' });
  }
  for (const ex of leaveExceptions) {
    const name = idToName.get(ex.lineUserId) || ex.name;
    if (name && !leaveMap.has(name)) leaveMap.set(name, { type: ex.leaveType, hours: 0, source: '請假例外' });
  }

  console.log(`\n═══ 模擬 ${dateStr} ═══`);
  console.log(`成員：${allMembers.join('、')}`);
  const leaveList = [];
  const wouldBeMissing = [];
  for (const name of allMembers) {
    const lv = leaveMap.get(name);
    if (lv) {
      leaveList.push(`🏖️ ${name}｜${lv.type}（${lv.source}）`);
    } else {
      wouldBeMissing.push(name); // 假設此人今日沒交工作日誌
    }
  }
  for (const l of leaveList) console.log('  ' + l);
  if (wouldBeMissing.length > 0) {
    console.log(`  未回報者（假設沒交）：${wouldBeMissing.join('、')}`);
  }
}

async function main() {
  await simulate('2026/08/05');  // 吻仔魚 應請假
  await simulate('2026/08/12');  // 阿啾 + 吻仔魚 都請假
  await simulate('2026/08/13');  // 阿啾 + 吻仔魚 都請假
  await simulate('2026/08/14');  // 今天 → 只有吻仔魚（8/1~8/16 公假）
  await simulate('2026/08/17');  // 兩人都不在區間
  console.log('\n═══ 晚報邏輯 ═══');
  const LATE_CUTOFF = '22:30';
  const cases = ['09:00', '22:29', '22:30', '23:10', '02:15'];
  for (const t of cases) {
    console.log(`  ${t} → ${t >= LATE_CUTOFF ? '🌙 晚報（立即分析、備註標晚報/加班）' : '正常靜默 pending'}`);
  }
}

main().catch(err => { console.error('❌ 失敗:', err.message); process.exit(1); });
