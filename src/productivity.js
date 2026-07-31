'use strict';
const {
  getWeeklyLogs, getSopSettings, getAllMemberNames, getAllMembers,
  getLeaveRecordsThisWeek,
} = require('./sheets');

// ============================================================
// 每週產能計算（週五 22:30 檢查 + 主管指令「本週產能」共用）
// 每筆請假：有時數(hours>0) → +hours/8 天；無時數 → +1 天
// needV = round(每週最低影片數 * (5 - 請假天數) / 5)，下限 0
// needC = round(每週最低輪播數 * (5 - 請假天數) / 5)，下限 0
// ============================================================
async function computeWeeklyProductivity() {
  const [logs, allMemberNames, members, sop, leaves] = await Promise.all([
    getWeeklyLogs(),
    getAllMemberNames(),
    getAllMembers(),
    getSopSettings(),
    getLeaveRecordsThisWeek(),
  ]);

  const minV = parseFloat(sop['每週最低影片數'] || '12');
  const minC = parseFloat(sop['每週最低輪播數'] || '6');

  // 每人每天取最後一筆的影片數量與輪播數量
  const latestPerDay = new Map(); // `${name}|${date}` → { v, c }
  for (const row of logs) {
    if (!row[0] || !row[2]) continue;
    const key = `${(row[2] || '').trim()}|${row[0]}`;
    latestPerDay.set(key, {
      v: parseInt(row[5]) || 0,
      c: parseInt(row[10]) || 0, // K 欄 輪播數量
    });
  }

  const totals = new Map();
  for (const [key, val] of latestPerDay) {
    const name = key.split('|')[0];
    if (!totals.has(name)) totals.set(name, { videos: 0, carousels: 0 });
    const s = totals.get(name);
    s.videos += val.v;
    s.carousels += val.c;
  }

  // 請假折算（ID 優先）
  const idToName = new Map(members.filter(m => m.id).map(m => [m.id, m.name]));
  const leaveByName = new Map();
  for (const r of leaves) {
    const name = idToName.get((r[3] || '').trim()) || (r[2] || '').trim();
    if (!name) continue;
    const hours = parseFloat(r[5]) || 0;
    const days = hours > 0 ? hours / 8 : 1;
    leaveByName.set(name, (leaveByName.get(name) || 0) + days);
  }

  return allMemberNames.map(rawName => {
    const name = rawName.trim();
    const s = totals.get(name) || { videos: 0, carousels: 0 };
    const leaveDaysRaw = leaveByName.get(name) || 0;
    const leaveDays = Math.round(leaveDaysRaw * 10) / 10; // 一位小數
    const needV = Math.max(0, Math.round(minV * (5 - leaveDays) / 5));
    const needC = Math.max(0, Math.round(minC * (5 - leaveDays) / 5));
    return {
      name, videos: s.videos, carousels: s.carousels,
      leaveDays, needV, needC,
      videoOk: s.videos >= needV,
      carouselOk: s.carousels >= needC,
      ok: s.videos >= needV && s.carousels >= needC,
      minV, minC,
    };
  });
}

module.exports = { computeWeeklyProductivity };
