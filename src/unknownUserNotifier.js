'use strict';
// 未登記使用者訊息通知：發現寄件者既不在成員名單也不是主管時，
// 推播一則 LINE 訊息給所有 MANAGER_USER_IDS，含 userId、訊息摘要、可直接照抄的新增範本
// 防洗版：同一個 userId 一天只推一次（記憶體 Map；跨日自動清空）
const { getAllMembers, getTaiwanDateString } = require('./sheets');
const { getManagerIds, isManager } = require('./managerCommands');

// dateStr → Set<userId>；跨日發現舊 key 直接清掉
const notifiedByDate = new Map();

function _todaySet() {
  const today = getTaiwanDateString();
  const set = notifiedByDate.get(today);
  if (set) return set;
  notifiedByDate.clear();
  const fresh = new Set();
  notifiedByDate.set(today, fresh);
  return fresh;
}

function _preview(text) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(非文字訊息)';
  return s.length <= 50 ? s : s.slice(0, 50) + '…';
}

// 主流程：若寄件者未登記，推播通知並記錄；不改變原訊息處理
async function maybeNotifyUnknownUser({ userId, text, sourceType, client }) {
  try {
    if (!userId) return;
    if (isManager(userId)) return;
    // 只處理 user 私訊；群組/房間訊息不觸發（避免被亂群拉爆）
    if (sourceType && sourceType !== 'user') return;

    const members = await getAllMembers();
    if (members.some(m => m.id === userId)) return;

    const set = _todaySet();
    if (set.has(userId)) return;
    set.add(userId);

    const preview = _preview(text);
    const msg = [
      '⚠️ 有未登記使用者傳訊給 Bot',
      '',
      `User ID：${userId}`,
      `訊息：${preview}`,
      '',
      '如要新增到成員名單，請依序傳：',
      '1) 新增成員',
      `2) <姓名> ${userId}`,
    ].join('\n');

    const managers = getManagerIds();
    if (managers.length === 0) {
      console.warn('未設定 MANAGER_USER_IDS/ADMIN_LINE_USER_ID，未登記通知略過');
      return;
    }
    for (const mid of managers) {
      try {
        await client.pushMessage({ to: mid, messages: [{ type: 'text', text: msg }] });
      } catch (err) {
        console.error(`推播未登記使用者通知失敗 (mid=${mid})：`, err.message);
      }
    }
    console.log(`📣 [未登記通知] ${userId} → 已推播給 ${managers.length} 位主管`);
  } catch (err) {
    console.error('maybeNotifyUnknownUser 例外：', err.message);
  }
}

function _resetForTest() { notifiedByDate.clear(); }

module.exports = { maybeNotifyUnknownUser, _resetForTest };
