'use strict';
// 一次性診斷：檢查請假記錄／工作記錄與成員名單的一致性
// 使用方式：node scripts/verify-leave-integrity.js
require('dotenv').config();
const { google } = require('googleapis');

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

function getTaiwanDateString(date = new Date()) {
  return date.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function lastNDates(n) {
  const dates = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(getTaiwanDateString(d));
  }
  return dates;
}

async function main() {
  const [membersRaw, leavesRaw, workLogsRaw] = await Promise.all([
    readAll('成員名單!A:B'),
    readAll('請假記錄!A:F'),
    readAll('工作記錄!A:K'),
  ]);

  const members = membersRaw.slice(1).map(r => ({
    name: (r[0] || '').trim(), id: (r[1] || '').trim(),
  })).filter(m => m.name);
  const idToName = new Map(members.filter(m => m.id).map(m => [m.id, m.name]));
  const nameSet  = new Set(members.map(m => m.name));

  console.log('════════════════════════════════════════════════════');
  console.log('a. 成員名單中 LINE_User_ID 空白的成員');
  console.log('   （這些人請假比對不到，強烈建議補 ID）');
  console.log('════════════════════════════════════════════════════');
  const missingId = members.filter(m => !m.id);
  if (missingId.length === 0) console.log('  ✅ 全員均有 LINE_User_ID');
  else for (const m of missingId) console.log(`  ❌ ${m.name}｜ID 空白`);

  console.log('\n════════════════════════════════════════════════════');
  console.log('b. 請假記錄 ID 或姓名對不上成員名單的列');
  console.log('   （過去 22:30 被誤報「未回報且未請假」的元凶）');
  console.log('════════════════════════════════════════════════════');
  const leaves = leavesRaw.slice(1);
  const badLeaves = [];
  for (const r of leaves) {
    const [leaveDate, , nameInRow, idInRow, type] = r;
    const nameTrim = (nameInRow || '').trim();
    const idTrim = (idInRow || '').trim();
    const nameById = idTrim ? idToName.get(idTrim) : null;
    const idKnown = !!nameById;
    const nameKnown = nameSet.has(nameTrim);
    if (!idKnown && !nameKnown) {
      badLeaves.push({ leaveDate, name: nameTrim, id: idTrim, type, reason: 'ID 與姓名都不在名單' });
    } else if (idKnown && nameKnown && nameById !== nameTrim) {
      badLeaves.push({ leaveDate, name: nameTrim, id: idTrim, type, reason: `姓名 "${nameTrim}" 與 ID 對應的姓名 "${nameById}" 不一致（22:30 現在以 ID 為主，會用「${nameById}」）` });
    } else if (!idKnown && nameKnown) {
      badLeaves.push({ leaveDate, name: nameTrim, id: idTrim, type, reason: 'ID 不在名單，僅姓名對得上（fallback 生效但仍建議修正 ID）' });
    }
  }
  if (badLeaves.length === 0) console.log('  ✅ 全部請假記錄 ID 與名單一致');
  else for (const b of badLeaves) console.log(`  ⚠️ ${b.leaveDate}｜姓名=${b.name}｜ID=${b.id || '(空)'}｜類型=${b.type}\n     → ${b.reason}`);

  console.log('\n════════════════════════════════════════════════════');
  console.log('c. 工作記錄 最近 30 天中姓名不在成員名單的列');
  console.log('════════════════════════════════════════════════════');
  const recent = lastNDates(30);
  const workLogs = workLogsRaw.slice(1).filter(r => recent.includes(r[0]));
  const badLogs = workLogs.filter(r => !nameSet.has((r[2] || '').trim()));
  if (badLogs.length === 0) console.log('  ✅ 最近 30 天工作記錄姓名均在名單內');
  else {
    // 依姓名 group
    const byName = new Map();
    for (const r of badLogs) {
      const n = (r[2] || '').trim() || '(空)';
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r[0]);
    }
    for (const [n, dates] of byName) {
      console.log(`  ⚠️ ${n}｜共 ${dates.length} 筆｜日期：${dates.slice(0, 5).join('、')}${dates.length > 5 ? ' ...' : ''}`);
    }
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('總結');
  console.log('════════════════════════════════════════════════════');
  console.log(`  成員名單：共 ${members.length} 人（無 ID：${missingId.length} 人）`);
  console.log(`  請假記錄：共 ${leaves.length} 筆（異常：${badLeaves.length} 筆）`);
  console.log(`  最近 30 天工作記錄：共 ${workLogs.length} 筆（姓名對不上：${badLogs.length} 筆）`);
}

main().catch(err => { console.error('❌ 診斷失敗：', err.message); process.exit(1); });
