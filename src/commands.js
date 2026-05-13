'use strict';
const { getTodayLogs, getWeeklyLogs, getAllMemberNames, getTaiwanDateString, getTaiwanTimeString } = require('./sheets');

// ============================================================
// 指令說明文字
// ============================================================
const HELP_TEXT = `📋 VLB 設計部工作查核系統

【主管查詢指令】
今日狀況　→ 所有人今日回報一覽
週報　　　→ 本週每人工作摘要
@姓名 狀況 → 查詢特定小編
　（例：@小芯 狀況）
說明　　　→ 顯示此說明

【小編每日回報格式】
今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 任務名稱
10:30-11:00 任務名稱
備註：（選填）

【工作類型選項】
正常日、外拍日、直播日
大型活動日（拍照組）
大型活動日（限動組）
大型活動日（剪輯組）`;

// 狀態對應顯示文字與 emoji
const STATUS_MAP = {
  normal:  { emoji: '✅', label: '正常' },
  warning: { emoji: '⚠️', label: '有警告' },
  alert:   { emoji: '🚨', label: '異常' },
};

// ============================================================
// 指令偵測
// ============================================================

// 判斷訊息是否為系統指令，回傳指令類型或 null
function detectCommand(text) {
  if (!text) return null;
  const t = text.trim();
  if (t === '今日狀況') return { type: 'today' };
  if (t === '週報')     return { type: 'weekly' };
  if (t === '說明' || t === 'help') return { type: 'help' };
  if (t === '我的ID' || t === 'myid') return { type: 'myid' };

  // @姓名 狀況
  const personMatch = t.match(/^@(.+?)\s*狀況$/);
  if (personMatch) return { type: 'person', name: personMatch[1].trim() };

  return null;
}

// 處理指令並回傳回覆文字（非指令回傳 null）
async function handleCommand(text, userId) {
  const cmd = detectCommand(text);
  if (!cmd) return null;

  // 所有人都可以使用的指令
  if (cmd.type === 'help') return HELP_TEXT;
  if (cmd.type === 'myid') return `你的 LINE User ID 是：\n${userId}`;

  // 其他查詢指令僅限主管
  if (userId !== process.env.ADMIN_LINE_USER_ID) {
    return '🔒 此指令僅限管理員使用。\n輸入「說明」查看回報格式。';
  }

  if (cmd.type === 'today')  return formatTodayStatus();
  if (cmd.type === 'weekly') return formatWeeklyReport();
  if (cmd.type === 'person') return formatPersonStatus(cmd.name);

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

  // 每人取最後一筆（允許重複回報，以最新為準）
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

  // 統計每人資料
  const statsMap = new Map();
  for (const row of logs) {
    const name = row[2];
    if (!name) continue;
    if (!statsMap.has(name)) statsMap.set(name, { days: 0, videos: 0, alerts: 0, warnings: 0 });
    const s = statsMap.get(name);
    s.days++;
    s.videos += parseInt(row[5]) || 0;
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
    lines.push(`${name}：${s.days}天｜${s.videos}支影片｜${statusPart}`);
  }

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
      // 換行顯示異常說明，每條一行
      row[8].split('；').forEach(a => lines.push(`   └ ${a}`));
    }
  }

  return lines.join('\n');
}

module.exports = { handleCommand, detectCommand };
