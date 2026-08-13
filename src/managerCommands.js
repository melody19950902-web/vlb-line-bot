'use strict';
// 主管指令：新增／移除／列出成員；兩段式互動、5 分鐘逾時、僅授權主管可用
// MANAGER_USER_IDS（逗號分隔）為授權清單；未設定則 fallback 到 ADMIN_LINE_USER_ID
const { getAllMembers, addMember, removeMemberByName, removeMemberById,
        getAllLeaveExceptions, addLeaveException } = require('./sheets');
const catalog = require('./commandCatalog');

// ============================================================
// 指令註冊（新增/修改主管指令時，同步更新這裡即可）
// ============================================================
catalog.register({ triggers: ['新增成員'],                                                 audience: 'manager', category: '成員管理（主管）', description: '兩段式：先傳「新增成員」，bot 進入模式後貼「姓名 U開頭ID」' });
catalog.register({ triggers: ['移除成員'],                                                 audience: 'manager', category: '成員管理（主管）', description: '兩段式：先傳「移除成員」，bot 進入模式後貼「姓名」（同名多筆時改貼 ID）' });
catalog.register({ triggers: ['成員列表'],                                                 audience: 'manager', category: '成員管理（主管）', description: '查看目前所有成員（ID 只顯示後 4 碼）' });
catalog.register({ triggers: ['請假 <姓名或ID> <假別> <開始日期> <結束日期> [備註]'],       audience: 'manager', category: '長期請假（主管）', description: '一次寫入長期請假區間（起訖含當日）', example: '請假 吻仔魚 公假 2026/08/01 2026/08/16 8/17 回來上班' });
catalog.register({ triggers: ['長期請假列表'],                                             audience: 'manager', category: '長期請假（主管）', description: '查看目前所有長期請假區間' });
catalog.register({ triggers: ['功能', '指令', '選單', 'help', '?', '？'],                    audience: 'public',  category: '說明',             description: '顯示這份完整指令清單（依你的角色過濾）' });

const STATE_TTL_MS = 5 * 60 * 1000;
const pendingState = new Map(); // userId → { mode: 'add'|'remove', expiresAt: number }

const ID_PATTERN = /^U[0-9a-fA-F]{32}$/;

const ADD_KEYWORD          = '新增成員';
const REMOVE_KEYWORD       = '移除成員';
const LIST_KEYWORD         = '成員列表';
const LEAVE_ADD_PREFIX     = '請假';           // 「請假 姓名 假別 開始 結束 [備註]」
const LEAVE_LIST_KEYWORD   = '長期請假列表';
const CANCEL_KEYWORD       = '取消';
const HELP_KEYWORDS        = new Set(['功能', '指令', '選單', 'help', 'Help', 'HELP', '?', '？']);
const VALID_LEAVE_TYPES    = new Set(['公假', '特休', '事假', '病假', '休假', '補休', '育嬰假', '產假']);
const DATE_PATTERN         = /^\d{4}\/\d{1,2}\/\d{1,2}$/;
// 只保護「會改動資料」的關鍵字；其他（help 等）不擋非主管，保留現有相容性
const RESTRICTED_KEYWORDS  = new Set([ADD_KEYWORD, REMOVE_KEYWORD, LIST_KEYWORD, LEAVE_LIST_KEYWORD]);

function normalize(text) {
  return (text || '').replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
}

function getManagerIds() {
  const raw = (process.env.MANAGER_USER_IDS || process.env.ADMIN_LINE_USER_ID || '').trim();
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isManager(userId) {
  return !!userId && getManagerIds().includes(userId);
}

function isRestrictedKeyword(rawText) {
  const t = normalize(rawText);
  if (RESTRICTED_KEYWORDS.has(t)) return true;
  // 「請假 姓名 假別 ...」也視為主管專用（防非主管誤觸）
  if (t.startsWith(LEAVE_ADD_PREFIX + ' ')) return true;
  return false;
}

function isManagerCommandKeyword(rawText) {
  const t = normalize(rawText);
  return RESTRICTED_KEYWORDS.has(t) || HELP_KEYWORDS.has(t) || t.startsWith(LEAVE_ADD_PREFIX + ' ');
}

function _getPending(userId) {
  const s = pendingState.get(userId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { pendingState.delete(userId); return null; }
  return s;
}

function helpMessage(userId) {
  const isAdmin   = !!userId && userId === process.env.ADMIN_LINE_USER_ID;
  const asManager = isManager(userId);
  const entries   = catalog.forRole({ isAdmin, isManager: asManager });
  const body      = catalog.buildHelpMessage(entries);
  // 補一段主管專屬的操作提示
  if (asManager) {
    return body + '\n\n💡 進入新增／移除模式後，5 分鐘內未貼資料會自動失效；模式中傳「取消」可提前結束。';
  }
  return body;
}

async function listLeaveExceptionsMessage() {
  const list = await getAllLeaveExceptions();
  if (list.length === 0) return '目前沒有任何長期請假記錄。';
  const lines = [`🏖️ 目前長期請假（共 ${list.length} 筆）`, ''];
  list.forEach((ex, i) => {
    const noteTail = ex.note ? `｜${ex.note}` : '';
    lines.push(`${i + 1}. ${ex.name}｜${ex.leaveType}｜${ex.startDate} ~ ${ex.endDate}${noteTail}`);
  });
  return lines.join('\n');
}

// 「請假 <姓名或ID> <假別> <開始> <結束> [備註…]」
// 姓名可含空格？中文姓名幾乎無空格，且 ID 一定 U+32 hex 一段，
// 因此以「空格 tokenize、前 4 個必要欄位、剩下當備註」處理。
async function handleLeaveAdd(rawText) {
  const t = normalize(rawText);
  const rest = t.slice(LEAVE_ADD_PREFIX.length).trim();
  if (!rest) {
    return '❌ 格式：請假 <姓名或ID> <假別> <開始日期> <結束日期> [備註]';
  }
  const parts = rest.split(' ').filter(Boolean);
  if (parts.length < 4) {
    return '❌ 欄位不足。格式：請假 <姓名或ID> <假別> <開始日期> <結束日期> [備註]';
  }
  const [who, leaveType, startDate, endDate, ...noteParts] = parts;
  const note = noteParts.join(' ');

  // 解析 who：ID 直接用；否則從成員名單查
  const members = await getAllMembers();
  let name = null;
  let lineUserId = '';
  if (ID_PATTERN.test(who)) {
    const m = members.find(x => x.id === who);
    if (!m) return `❌ 找不到 ID 為 ${who} 的成員，請先「新增成員」。`;
    name = m.name;
    lineUserId = who;
  } else {
    const matches = members.filter(x => x.name === who);
    if (matches.length === 0) return `❌ 找不到成員：${who}。可先傳「成員列表」核對。`;
    if (matches.length > 1) {
      const list = matches.map(x => `  ${x.name}｜${x.id}`).join('\n');
      return `⚠️ 同名多筆，請改用 U 開頭 ID：\n${list}`;
    }
    name = matches[0].name;
    lineUserId = matches[0].id;
  }

  if (!VALID_LEAVE_TYPES.has(leaveType)) {
    const valid = [...VALID_LEAVE_TYPES].join('／');
    return `❌ 假別「${leaveType}」不在支援清單。可填：${valid}`;
  }
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
    return '❌ 日期格式錯誤，需為 YYYY/MM/DD（例：2026/08/01）。';
  }
  if (startDate > endDate) {
    return '❌ 開始日期不能晚於結束日期。';
  }

  const ok = await addLeaveException({ name, lineUserId, leaveType, startDate, endDate, note });
  if (!ok) return '❌ 寫入失敗，請稍後再試。';
  return [
    `✅ 已登記長期請假`,
    `👤 ${name}`,
    `📌 ${leaveType}`,
    `📅 ${startDate} ~ ${endDate}${note ? `｜${note}` : ''}`,
    ``,
    '該區間內的每日 22:30 判定將不再列為未回報。',
  ].join('\n');
}

async function listMembersMessage() {
  const members = await getAllMembers();
  if (members.length === 0) return '目前成員名單是空的。';
  const lines = [`👥 目前成員（共 ${members.length} 位）`, ''];
  members.forEach((m, i) => {
    const tail = m.id ? `…${m.id.slice(-4)}` : '(無 ID)';
    lines.push(`${i + 1}. ${m.name}（${tail}）`);
  });
  return lines.join('\n');
}

async function _handleAddInput(text, userId) {
  const parts = text.split(' ').filter(Boolean);
  if (parts.length < 2) {
    return '❌ 格式錯誤：需要「姓名」＋「LINE User ID」（用空格分隔）。\n請再貼一次，或傳「取消」結束。';
  }
  const name = parts[0];
  const id   = parts[1];
  if (!ID_PATTERN.test(id)) {
    return '❌ LINE User ID 格式不對（需為 U 開頭 + 32 個 hex 字元）。\n請再貼一次，或傳「取消」結束。';
  }
  const members = await getAllMembers();
  if (members.some(m => m.id === id)) {
    pendingState.delete(userId);
    return `⚠️ 已存在此 ID 的成員（${members.find(m => m.id === id).name}），未新增。`;
  }
  if (members.some(m => m.name === name)) {
    pendingState.delete(userId);
    return `⚠️ 已存在同名成員「${name}」，未新增。若真的要加同名者，請先跟我說。`;
  }
  const ok = await addMember({ name, lineUserId: id });
  pendingState.delete(userId);
  if (!ok) return '❌ 寫入失敗，請稍後再試一次。';
  return `✅ 已新增成員：${name}。目前共 ${members.length + 1} 位。`;
}

async function _handleRemoveInput(text, userId) {
  const trimmed = text.trim();
  const members = await getAllMembers();
  // 傳 U 開頭 ID：以 ID 精準刪除
  if (ID_PATTERN.test(trimmed)) {
    const found = members.find(m => m.id === trimmed);
    if (!found) {
      return `❌ 找不到 ID 為 ${trimmed} 的成員。\n請再貼一次，或傳「取消」結束。`;
    }
    const removed = await removeMemberById(trimmed);
    pendingState.delete(userId);
    if (!removed) return '❌ 刪除失敗，請稍後再試一次。';
    return `✅ 已移除成員：${removed.name}。目前共 ${members.length - 1} 位。`;
  }
  // 姓名比對
  const matches = members.filter(m => m.name === trimmed);
  if (matches.length === 0) {
    return `❌ 找不到成員：${trimmed}。\n請再貼一次，或傳「取消」結束。`;
  }
  if (matches.length > 1) {
    const list = matches.map(m => `  ${m.name} ｜ ${m.id}`).join('\n');
    return `⚠️ 同名多筆，請改貼該員的 LINE User ID：\n${list}`;
  }
  const removed = await removeMemberByName(trimmed);
  pendingState.delete(userId);
  if (!removed) return '❌ 刪除失敗，請稍後再試一次。';
  return `✅ 已移除成員：${removed.name}。目前共 ${members.length - 1} 位。`;
}

// 主管訊息主入口。回傳字串 = 已處理要回覆；回傳 null = 未處理，由呼叫端繼續其他流程
async function handleManagerCommand(rawText, userId) {
  const text = normalize(rawText);
  // HELP 類指令對所有人開放，依角色渲染不同的清單
  if (HELP_KEYWORDS.has(text)) return helpMessage(userId);

  // 以下為主管專用
  if (!isManager(userId)) return null;
  const pending = _getPending(userId);

  // 模式中：允許取消
  if (pending && text === CANCEL_KEYWORD) {
    pendingState.delete(userId);
    return '✅ 已取消。';
  }

  // 主指令永遠優先（即使處於模式中，也允許切換）
  if (text === LIST_KEYWORD)         return listMembersMessage();
  if (text === LEAVE_LIST_KEYWORD)   return listLeaveExceptionsMessage();
  if (text.startsWith(LEAVE_ADD_PREFIX + ' ')) return handleLeaveAdd(text);
  if (text === ADD_KEYWORD) {
    pendingState.set(userId, { mode: 'add', expiresAt: Date.now() + STATE_TTL_MS });
    return [
      '好的，請貼上要新增的成員：一行內含 姓名 與 LINE User ID（U 開頭）',
      '例如：彭德芬 U1234567890abcdef1234567890abcdef',
      '',
      '要取消請傳「取消」。5 分鐘內未回覆將自動失效。',
    ].join('\n');
  }
  if (text === REMOVE_KEYWORD) {
    pendingState.set(userId, { mode: 'remove', expiresAt: Date.now() + STATE_TTL_MS });
    return [
      '好的，請貼上要移除的成員姓名（同名多筆時改貼 U 開頭 ID）。',
      '',
      '要取消請傳「取消」。5 分鐘內未回覆將自動失效。',
    ].join('\n');
  }

  // 模式中且不是主指令 → 當作輸入
  if (pending) {
    if (pending.mode === 'add')    return _handleAddInput(text, userId);
    if (pending.mode === 'remove') return _handleRemoveInput(text, userId);
  }

  return null;
}

// 測試用（重設狀態）
function _resetStateForTest() { pendingState.clear(); }

module.exports = {
  handleManagerCommand,
  isManager,
  isRestrictedKeyword,
  isManagerCommandKeyword,
  normalize,
  getManagerIds,
  _resetStateForTest,
  // 常數匯出，供 lineHandler 判斷
  ADD_KEYWORD, REMOVE_KEYWORD, LIST_KEYWORD, CANCEL_KEYWORD, HELP_KEYWORDS,
  ID_PATTERN, STATE_TTL_MS,
};
