'use strict';
const {
  getTodayLogs, getWeeklyLogs, getAllMemberNames,
  getTaiwanDateString, getTaiwanTimeString,
  getMonthlyAnomalies, getTaiwanMonthString,
  getLeaveRecordsThisWeek, getLeaveRecordsForMonth,
  getMonthLogs, getSopSettings,
} = require('./sheets');
const { computeWeeklyProductivity } = require('./productivity');

// ============================================================
// 說明文字
// ============================================================
const HELP_TEXT = `📋 VLB 設計部工作查核系統

【主管查詢指令】
今日狀況　→ 所有人今日回報一覽
週報　　　→ 本週每人工作摘要
月報　　　→ 本月每人異常累計
本週請假　→ 本週誰請假一覽
本月請假　→ 本月每人請假統計
本月剪輯統計 → 本月每人剪輯支數合計
上月剪輯統計 → 上月每人剪輯支數合計
本週產能　→ 本週影片/輪播達標統計（依請假調整）
@姓名 狀況 → 查詢特定小編
　（例：@小芯 狀況）
說明　　　→ 顯示此說明

【小編每日回報格式】
今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 剪輯短影音
10:30-11:00 發布各平台
備註：（選填）

【工作類型選項】
正常日、跟拍日、課程日
大型活動日（拍照組／限動組／剪輯組）
Podcast日、直播日、外拍半天、外拍一天

【特殊工作日（簡短格式）】
外拍半天
外拍一天
課程拍攝 3 小時
直播 2 小時

【全員可用（群組或私聊皆可）】
本月工作進度統計 → 全員本月影片/輪播統計

【當天臨時請假】
今日病假、今日事假
今日補休（今日補休半天／今日補休 X 小時）

【前一天預告】
明日事假、明日特休、明日休假
明日補休（明日補休半天／明日補休 X 小時）

【自然說法也接受】
例：我明天要特休、8/5事假、下週一補休半天、後天休假
（建議還是用標準格式最穩，錯字或閒聊 bot 會請你補正確資訊）`;

const STATUS_MAP = {
  normal:  { emoji: '✅', label: '正常' },
  warning: { emoji: '⚠️', label: '有警告' },
  alert:   { emoji: '🚨', label: '異常' },
};

// ============================================================
// 指令偵測
// ============================================================

function detectCommand(text) {
  if (!text) return null;
  const t = text.trim();
  if (t === '今日狀況') return { type: 'today' };
  if (t === '週報')     return { type: 'weekly' };
  if (t === '月報')     return { type: 'monthly' };
  if (t === '說明' || t === 'help') return { type: 'help' };
  if (t === '我的ID' || t === 'myid') return { type: 'myid' };
  if (t === '本週請假') return { type: 'weeklyLeave' };
  if (t === '本月請假' || t === '本月請假統計') return { type: 'monthlyLeave' };
  if (t === '本月剪輯統計') return { type: 'videoStats', which: 'current' };
  if (t === '上月剪輯統計') return { type: 'videoStats', which: 'prev' };
  if (t === '本週產能' || t === '產能檢查') return { type: 'weeklyProductivity' };
  // 全員可用的月度統計（允許前綴 @機器人名稱）
  if (/^(@\S+\s*)?本月工作進度統計$/.test(t)) return { type: 'publicMonthlyStats' };
  const personMatch = t.match(/^@(.+?)\s*狀況$/);
  if (personMatch) return { type: 'person', name: personMatch[1].trim() };
  return null;
}

async function handleCommand(text, userId) {
  const cmd = detectCommand(text);
  if (!cmd) return null;

  if (cmd.type === 'help') return HELP_TEXT;
  if (cmd.type === 'myid') return `你的 LINE User ID 是：\n${userId}`;
  // 全員可用（群組或私聊皆可）—— 放在管理員權限檢查之前
  if (cmd.type === 'publicMonthlyStats') return formatPublicMonthlyStats();

  if (userId !== process.env.ADMIN_LINE_USER_ID) {
    return '🔒 此指令僅限管理員使用。\n輸入「說明」查看回報格式。';
  }

  if (cmd.type === 'today')        return formatTodayStatus();
  if (cmd.type === 'weekly')       return formatWeeklyReport();
  if (cmd.type === 'monthly')      return formatMonthlyReport();
  if (cmd.type === 'weeklyLeave')  return formatWeeklyLeave();
  if (cmd.type === 'monthlyLeave') return formatMonthlyLeave();
  if (cmd.type === 'videoStats')   return formatVideoStats(cmd.which);
  if (cmd.type === 'weeklyProductivity') return formatWeeklyProductivity();
  if (cmd.type === 'person')       return formatPersonStatus(cmd.name);

  return null;
}

// ============================================================
// 今日狀況
// ============================================================

async function formatTodayStatus() {
  const [logs, allMembers] = await Promise.all([
    getTodayLogs(),
    getAllMemberNames(),
  ]);

  const today = getTaiwanDateString();
  const now   = getTaiwanTimeString();

  const latestByName = new Map();
  for (const row of logs) {
    if (row[2]) latestByName.set(row[2], row);
  }

  const lines = [
    `📊 VLB設計部 今日工作狀況`,
    `${today} 更新時間 ${now}`,
    ``,
  ];

  let reportedCount = 0;
  for (const name of allMembers) {
    const row = latestByName.get(name);
    if (row) {
      reportedCount++;
      const s = STATUS_MAP[row[7]] || { emoji: '❓', label: '未知' };
      lines.push(`${s.emoji} ${name}｜${row[5] || '?'}支｜${s.label}`);
    } else {
      lines.push(`❓ ${name}｜尚未回報`);
    }
  }

  lines.push(``, `共 ${reportedCount}/${allMembers.length} 人已回報`);
  return lines.join('\n');
}

// ============================================================
// 週報
// ============================================================

async function formatWeeklyReport() {
  const [logs, allMembers] = await Promise.all([
    getWeeklyLogs(),
    getAllMemberNames(),
  ]);

  const lines = [`📊 VLB設計部 本週工作摘要\n`];

  const statsMap = new Map();
  for (const row of logs) {
    const name = row[2];
    if (!name) continue;
    if (!statsMap.has(name)) statsMap.set(name, { days: 0, videos: 0, carousels: 0, alerts: 0, warnings: 0 });
    const s = statsMap.get(name);
    s.days++;
    s.videos    += parseInt(row[5])  || 0;
    s.carousels += parseInt(row[10]) || 0;
    if (row[7] === 'alert')   s.alerts++;
    if (row[7] === 'warning') s.warnings++;
  }

  for (const name of allMembers) {
    const s = statsMap.get(name);
    if (!s) {
      lines.push(`❓ ${name}：本週尚未回報`);
      continue;
    }
    const statusPart = s.alerts > 0
      ? `🚨 ${s.alerts}次異常`
      : s.warnings > 0
        ? `⚠️ ${s.warnings}次警告`
        : '✅ 全部正常';
    lines.push(`${name}：${s.days}天｜${s.videos}支影片｜${s.carousels}篇輪播｜${statusPart}`);
  }

  return lines.join('\n');
}

// ============================================================
// 本週產能（純查詢，不寫入月度記錄）
// ============================================================
async function formatWeeklyProductivity() {
  const stats = await computeWeeklyProductivity();
  if (stats.length === 0) return '📊 本週產能無資料可統計。';
  const minV = stats[0].minV, minC = stats[0].minC;
  const lines = [`📊 VLB 本週產能`, `標準：每週 ${minV} 支影片、${minC} 篇輪播（依請假天數等比例調整）`, ``];
  for (const s of stats) {
    const vTag = s.videoOk ? '✅' : '❌';
    const cTag = s.carouselOk ? '✅' : '❌';
    const leaveNote = s.leaveDays > 0 ? `（請假 ${s.leaveDays} 天）` : '';
    lines.push(`${s.name}｜影片 ${vTag} ${s.videos}/${s.needV}｜輪播 ${cTag} ${s.carousels}/${s.needC}${leaveNote}`);
  }
  const missed = stats.filter(s => !s.ok);
  lines.push('', missed.length === 0
    ? `全員達標，辛苦了！`
    : `未達標：${missed.map(s => s.name).join('、')}`);
  return lines.join('\n');
}

// ============================================================
// 月報：本月每人異常累計次數
// ============================================================

async function formatMonthlyReport() {
  const [allMembers, allRecords] = await Promise.all([
    getAllMemberNames(),
    getMonthlyAnomalies(getTaiwanMonthString()),
  ]);
  const month = getTaiwanMonthString();
  const lines = [`📊 VLB設計部 ${month} 月度異常統計\n`];

  // 一次讀完整月記錄，於程式內以 r[1]（小編名稱）分組
  const byName = new Map();
  for (const r of allRecords) {
    if (r[2] === '影片統計') continue;
    if (['病假','事假','特休','休假','補休'].includes(r[3])) continue;
    const name = r[1];
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(r);
  }

  for (const name of allMembers) {
    const anomalies = byName.get(name) || [];
    if (anomalies.length === 0) {
      lines.push(`✅ ${name}：本月無異常`);
    } else {
      const dateList = anomalies.map(r => {
        const emoji = r[3] === '未回報' ? '❗' : '⚠️';
        return `${emoji}${r[2]}`;
      }).join('、');
      lines.push(`⚠️ ${name}：${anomalies.length} 次（${dateList}）`);
    }
  }

  lines.push(`\n統計月份：${month}`);
  return lines.join('\n');
}

// ============================================================
// 本週請假一覽（依日期、姓名排序）
// 請假記錄欄位：0 日期 1 提交時間 2 姓名 3 ID 4 類型 5 時數
// ============================================================

async function formatWeeklyLeave() {
  const records = await getLeaveRecordsThisWeek();
  if (records.length === 0) return '📅 本週目前沒有任何請假記錄。';
  records.sort((a, b) => (a[0] === b[0] ? String(a[2]).localeCompare(b[2]) : (a[0] < b[0] ? -1 : 1)));
  const lines = ['📅 VLB設計部 本週請假', ''];
  for (const r of records) {
    let detail = r[4] || '請假';
    if (r[5]) detail += ` ${r[5]} 小時`;
    lines.push(`${r[0]}　${r[2] || '?'}：${detail}`);
  }
  lines.push('', `本週合計 ${records.length} 人次`);
  return lines.join('\n');
}

// ============================================================
// 本月請假統計（每人次數與類型分布）
// ============================================================

async function formatMonthlyLeave() {
  const month = getTaiwanMonthString();
  const records = await getLeaveRecordsForMonth(month);
  const lines = [`📊 VLB設計部 ${month} 請假統計`, ''];
  if (records.length === 0) { lines.push('本月目前沒有任何請假記錄。'); return lines.join('\n'); }
  const byName = new Map();
  for (const r of records) {
    const name = r[2] || '未知';
    if (!byName.has(name)) byName.set(name, { total: 0, types: new Map() });
    const s = byName.get(name);
    s.total++;
    const ty = r[4] || '請假';
    s.types.set(ty, (s.types.get(ty) || 0) + 1);
  }
  for (const [name, s] of byName) {
    const breakdown = [...s.types.entries()].map(([ty, n]) => `${ty}${n}`).join('、');
    lines.push(`${name}：${s.total} 次（${breakdown}）`);
  }
  lines.push('', `統計月份：${month}`);
  return lines.join('\n');
}

// ============================================================
// 剪輯數量統計（本月／上月）
// 每人每天取工作記錄最後一筆的影片數量再加總
// ============================================================

function prevMonthString() {
  const [y, m] = getTaiwanMonthString().split('/').map(Number);
  return m === 1 ? `${y - 1}/12` : `${y}/${String(m - 1).padStart(2, '0')}`;
}

async function formatVideoStats(which) {
  const month = which === 'prev' ? prevMonthString() : getTaiwanMonthString();
  const [logs, allMembers] = await Promise.all([getMonthLogs(month), getAllMemberNames()]);
  const latestPerDay = new Map();
  for (const row of logs) {
    if (row[2] && row[0]) latestPerDay.set(`${row[2]}｜${row[0]}`, parseInt(row[5]) || 0);
  }
  const totals = new Map();
  for (const [key, c] of latestPerDay) {
    const n = key.split('｜')[0];
    totals.set(n, (totals.get(n) || 0) + c);
  }
  const lines = [`📊 VLB ${month}｜剪輯數量統計`, ''];
  let total = 0;
  for (const name of allMembers) {
    const c = totals.get(name) || 0; total += c;
    lines.push(`${name}：${c} 支`);
  }
  lines.push('', `團隊合計：${total} 支`, '（來源：工作記錄各日最後一筆影片數量）');
  return lines.join('\n');
}

// ============================================================
// 全員可用：本月工作進度統計（群組或私聊皆可）
// 每人每天取最後一筆的影片/輪播數量，加總
// ============================================================
async function formatPublicMonthlyStats() {
  const month = getTaiwanMonthString();
  const [logs, allMembers, sop] = await Promise.all([
    getMonthLogs(month), getAllMemberNames(), getSopSettings(),
  ]);
  const minV = parseFloat(sop['每週最低影片數'] || '12');
  const minC = parseFloat(sop['每週最低輪播數'] || '6');

  // 每人每天取最後一筆
  const latestPerDay = new Map(); // `${name}|${date}` → { v, c }
  for (const row of logs) {
    if (!row[0] || !row[2]) continue;
    const key = `${(row[2] || '').trim()}|${row[0]}`;
    latestPerDay.set(key, {
      v: parseInt(row[5]) || 0,
      c: parseInt(row[10]) || 0,
    });
  }

  const totals = new Map();
  for (const [key, val] of latestPerDay) {
    const name = key.split('|')[0];
    if (!totals.has(name)) totals.set(name, { videos: 0, carousels: 0 });
    const s = totals.get(name);
    s.videos    += val.v;
    s.carousels += val.c;
  }

  const lines = [`📊 VLB ${month} 工作進度統計`, ``];
  let totalV = 0, totalC = 0;
  for (const name of allMembers) {
    const s = totals.get(name) || { videos: 0, carousels: 0 };
    totalV += s.videos; totalC += s.carousels;
    lines.push(`${name}：影片 ${s.videos} 支｜輪播 ${s.carousels} 篇`);
  }
  lines.push('', `團隊合計：影片 ${totalV} 支｜輪播 ${totalC} 篇`);
  lines.push(`（每週標準：影片 ${minV} 支＋輪播 ${minC} 篇／人）`);
  return lines.join('\n');
}

// ============================================================
// 特定成員本週狀況
// ============================================================

async function formatPersonStatus(name) {
  const logs = await getWeeklyLogs(name);

  if (logs.length === 0) {
    return `❓ ${name} 本週尚無工作記錄。`;
  }

  const lines = [`📋 ${name} 本週工作記錄\n`];
  for (const row of logs) {
    const s = STATUS_MAP[row[7]] || { emoji: '❓', label: '未知' };
    lines.push(`${s.emoji} ${row[0]}｜${row[4] || '未知類型'}｜${row[5] || '0'}支`);
    if (row[8]) {
      row[8].split('；').forEach(a => lines.push(`   └ ${a}`));
    }
  }

  return lines.join('\n');
}

module.exports = { handleCommand, detectCommand };
