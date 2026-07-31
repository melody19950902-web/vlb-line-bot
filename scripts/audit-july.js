'use strict';
// 一次性稽核：2026/07 工作記錄完整性（每工作日 × 每人 是否有日誌或請假）
// 純讀取，不寫入、不修改任何資料
// 使用方式：node scripts/audit-july.js
require('dotenv').config();
const { google } = require('googleapis');

const MONTH_PREFIX = '2026/07';
const YEAR = 2026, MON = 7; // 1-based

async function readAll(range) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID, range,
  });
  return res.data.values || [];
}

// 產生 2026/07 所有工作日（週一~週五）
function julyWorkdays() {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    const dow = new Date(Date.UTC(YEAR, MON - 1, d)).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const ds = `${YEAR}/${String(MON).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
      days.push({ date: ds, dow });
    }
  }
  return days;
}

const DOW_LABEL = ['日','一','二','三','四','五','六'];
const LEAVE_EMOJI = { 病假: '🏥', 事假: '📋', 特休: '🏖️', 休假: '🏖️', 補休: '🔄' };

function fmtCell(cell) {
  if (!cell) return '❌   ';
  if (cell.type === 'log')   return `✅${String(cell.videos).padStart(2, ' ')}  `;
  if (cell.type === 'leave') {
    const e = LEAVE_EMOJI[cell.leaveType] || '🏖️';
    const suffix = cell.leaveType === '補休' && cell.hours ? String(cell.hours) : '';
    return `${e}${cell.leaveType.slice(0,2)}${suffix}`.padEnd(6, ' ');
  }
  return '❌   ';
}

async function main() {
  const [workRaw, leaveRaw, memberRaw] = await Promise.all([
    readAll('工作記錄!A:K'),
    readAll('請假記錄!A:F'),
    readAll('成員名單!A:B'),
  ]);

  const members = memberRaw.slice(1)
    .map(r => ({ name: (r[0] || '').trim(), id: (r[1] || '').trim() }))
    .filter(m => m.name);
  const memberNames = members.map(m => m.name);
  const idToName = new Map(members.filter(m => m.id).map(m => [m.id, m.name]));
  const nameSet = new Set(memberNames);

  const workRows = workRaw.slice(1).filter(r => (r[0] || '').startsWith(MONTH_PREFIX));
  const leaveRows = leaveRaw.slice(1).filter(r => (r[0] || '').startsWith(MONTH_PREFIX));
  const workdays = julyWorkdays();

  // 每人每天：取最後一筆
  const cellMap = new Map(); // key = `${name}|${date}` → cell
  const countMap = new Map(); // key → 筆數（用來偵測異常筆數）
  const nonMemberRows = []; // 不在成員名單的日誌
  const monthlyPerName = new Map(); // name → { videos, carousels }

  for (const r of workRows) {
    const [date, , rawName, , , videoStr, , status, , , carouselStr] = r;
    const name = (rawName || '').trim();
    if (!nameSet.has(name)) {
      nonMemberRows.push({ date, name, status });
      continue;
    }
    const key = `${name}|${date}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
    // 取最後一筆（overwrite）
    cellMap.set(key, {
      type: 'log',
      videos: parseInt(videoStr) || 0,
      carousels: parseInt(carouselStr) || 0,
      status: status || '',
    });
  }

  // 請假記錄（ID 優先解析姓名）
  for (const r of leaveRows) {
    const [date, , rawName, rawId, type, hoursStr] = r;
    const name = idToName.get((rawId || '').trim()) || (rawName || '').trim();
    if (!nameSet.has(name)) continue;
    const key = `${name}|${date}`;
    // 請假記錄若當天已有日誌，日誌優先（有實際工作）；反之標請假
    if (cellMap.get(key) && cellMap.get(key).type === 'log') continue;
    cellMap.set(key, {
      type: 'leave',
      leaveType: type || '請假',
      hours: parseFloat(hoursStr) || 0,
    });
  }

  // 每人每月影片/輪播加總（同「上月剪輯統計」口徑：只取每天最後一筆的日誌）
  for (const [key, cell] of cellMap) {
    if (cell.type !== 'log') continue;
    const [name] = key.split('|');
    if (!monthlyPerName.has(name)) monthlyPerName.set(name, { videos: 0, carousels: 0 });
    const s = monthlyPerName.get(name);
    s.videos += cell.videos;
    s.carousels += cell.carousels;
  }

  // ========== 輸出 ==========

  console.log('════════════════════════════════════════════════════════════');
  console.log(`VLB 2026/07 工作記錄完整性稽核`);
  console.log('════════════════════════════════════════════════════════════');
  console.log(`成員：${memberNames.join('、')}（${memberNames.length} 人）`);
  console.log(`7 月工作日：${workdays.length} 天（週一~週五；週六發布日、週日休息不列入）`);

  console.log('\n═══ a. 完整對照表（工作日 × 成員） ═══');
  console.log(`圖例：✅N=有日誌N支影片｜🏥病假 📋事假 🏖️休假/特休 🔄補休[時數]｜❌未回報未請假`);
  console.log();
  // Header
  const nameHead = memberNames.map(n => n.padEnd(6, ' ')).join('');
  console.log(`日期          週  | ${nameHead}`);
  console.log('-'.repeat(20 + memberNames.length * 6));
  for (const { date, dow } of workdays) {
    const row = memberNames.map(n => fmtCell(cellMap.get(`${n}|${date}`))).join('');
    console.log(`${date}(${DOW_LABEL[dow]}) | ${row}`);
  }

  console.log('\n═══ b. 每人漏記日清單 ═══');
  const missingByName = new Map();
  for (const { date } of workdays) {
    for (const name of memberNames) {
      if (!cellMap.get(`${name}|${date}`)) {
        if (!missingByName.has(name)) missingByName.set(name, []);
        missingByName.get(name).push(date);
      }
    }
  }
  for (const name of memberNames) {
    const list = missingByName.get(name) || [];
    if (list.length === 0) console.log(`  ✅ ${name}：無漏記，7 月工作日全數有交代`);
    else console.log(`  ❌ ${name}：漏記 ${list.length} 天\n     日期：${list.join('、')}`);
  }

  console.log('\n═══ c. 7 月影片/輪播總數（每天最後一筆加總） ═══');
  let totalV = 0, totalC = 0;
  for (const name of memberNames) {
    const s = monthlyPerName.get(name) || { videos: 0, carousels: 0 };
    totalV += s.videos; totalC += s.carousels;
    console.log(`  ${name}：影片 ${s.videos} 支｜輪播 ${s.carousels} 篇`);
  }
  console.log(`  ────────────`);
  console.log(`  團隊合計：影片 ${totalV} 支｜輪播 ${totalC} 篇`);

  console.log('\n═══ d. 工作記錄中不在成員名單的姓名 ═══');
  if (nonMemberRows.length === 0) console.log('  ✅ 全數姓名皆在成員名單內');
  else {
    const byName = new Map();
    for (const r of nonMemberRows) {
      const n = r.name || '(空)';
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r.date);
    }
    for (const [n, dates] of byName) {
      console.log(`  ⚠️ ${n}｜共 ${dates.length} 筆｜日期：${dates.slice(0, 5).join('、')}${dates.length > 5 ? ' ...' : ''}`);
    }
  }

  console.log('\n═══ e. 單日筆數異常（>2 筆）═══');
  console.log(`（正常：pending + 22:30 最終列 = 2 筆；補跑或重傳可能造成更多）`);
  const overCount = [];
  for (const [key, cnt] of countMap) {
    if (cnt > 2) overCount.push({ key, cnt });
  }
  if (overCount.length === 0) console.log('  ✅ 每人每天筆數皆 ≤ 2');
  else {
    overCount.sort((a, b) => b.cnt - a.cnt);
    for (const { key, cnt } of overCount) {
      const [name, date] = key.split('|');
      console.log(`  ⚠️ ${name}｜${date}｜共 ${cnt} 筆（取最後一筆為準）`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('稽核完成（純讀取，未修改任何資料）');
}

main().catch(err => { console.error('❌ 稽核失敗：', err.message); process.exit(1); });
