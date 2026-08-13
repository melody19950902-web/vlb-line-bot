'use strict';
const {
  getWeeklyLogs, getSopSettings, getAllMemberNames, getAllMembers,
  getLeaveRecordsThisWeek, getAllLeaveExceptions, getHolidaySet, getTaiwanDateString,
} = require('./sheets');

// 本週週一~週五的日期陣列（台灣時間）
function weekWeekdays() {
  const taiwanNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dow = taiwanNow.getDay(); // 0=Sun
  const monOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date();
  monday.setDate(monday.getDate() + monOffset);
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(getTaiwanDateString(d));
  }
  return days;
}

// 本週（週一~週五）落在國定假日的天數
function countHolidayWeekdays(holidays) {
  return weekWeekdays().filter(d => holidays.has(d)).length;
}

// 依「請假例外」計算某人本週落在該人區間內的工作日天數（Mon–Fri）
function countExceptionWeekdays(name, id, exceptions, weekdays) {
  let n = 0;
  for (const ex of exceptions) {
    const matched = (id && ex.lineUserId === id) || (!ex.lineUserId && ex.name === name);
    if (!matched) continue;
    for (const d of weekdays) {
      if (d >= ex.startDate && d <= ex.endDate) n++;
    }
  }
  return n;
}

// ============================================================
// 每週產能計算（週五 22:30 檢查 + 主管指令「本週產能」共用）
// 每筆請假：有時數(hours>0) → +hours/8 天；無時數 → +1 天
// 國定假日折算：本週（週一~週五）落在假日的天數 h
// needV = round(每週最低影片數 * (5 - h - 請假天數) / 5)，下限 0
// needC = round(每週最低輪播數 * (5 - h - 請假天數) / 5)，下限 0
// ============================================================
async function computeWeeklyProductivity() {
  const [logs, allMemberNames, members, sop, leaves, exceptions, holidays] = await Promise.all([
    getWeeklyLogs(),
    getAllMemberNames(),
    getAllMembers(),
    getSopSettings(),
    getLeaveRecordsThisWeek(),
    getAllLeaveExceptions(),
    getHolidaySet(),
  ]);

  const minV = parseFloat(sop['每週最低影片數'] || '12');
  const minC = parseFloat(sop['每週最低輪播數'] || '6');
  const holidayDays = countHolidayWeekdays(holidays);
  const weekdays = weekWeekdays();

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

  // 姓名 → id 對照，用於請假例外比對
  const nameToId = new Map(members.filter(m => m.name).map(m => [m.name, m.id]));

  return allMemberNames.map(rawName => {
    const name = rawName.trim();
    const s = totals.get(name) || { videos: 0, carousels: 0 };
    const leaveDaysRaw = leaveByName.get(name) || 0;
    // 疊加「請假例外」在本週的重疊工作日
    const exceptionDays = countExceptionWeekdays(name, nameToId.get(name), exceptions, weekdays);
    const totalLeave = leaveDaysRaw + exceptionDays;
    const leaveDays = Math.round(totalLeave * 10) / 10; // 一位小數
    const availableDays = Math.max(0, 5 - holidayDays - leaveDays);
    const needV = Math.max(0, Math.round(minV * availableDays / 5));
    const needC = Math.max(0, Math.round(minC * availableDays / 5));
    return {
      name, videos: s.videos, carousels: s.carousels,
      leaveDays, holidayDays, needV, needC,
      videoOk: s.videos >= needV,
      carouselOk: s.carousels >= needC,
      ok: s.videos >= needV && s.carousels >= needC,
      minV, minC,
    };
  });
}

module.exports = { computeWeeklyProductivity };
