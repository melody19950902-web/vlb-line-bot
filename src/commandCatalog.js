'use strict';
// 指令中央註冊表：commands.js / managerCommands.js 各自把自己的指令登記進來，
// 「功能」指令依角色過濾後渲染成使用者可讀的清單。之後新增指令一律在該指令所在的模組 register，
// 就會自動出現在「功能」清單裡（避免遺漏）。

const registry = [];

// 分組顯示順序（未列入者附加在最後）
const CATEGORY_ORDER = [
  '進度查詢｜每日',
  '進度查詢｜每週',
  '進度查詢｜每月',
  '請假查詢',
  '個人查詢',
  '成員管理（主管）',
  '長期請假（主管）',
  '說明',
];

// entry: {
//   triggers:     string[]                      // 使用者實際要打的字（含同義字）
//   audience:     'public' | 'admin' | 'manager'
//   category:     string                        // 顯示分組
//   description:  string                        // 一句話說明
//   example?:     string                        // 範例（選填）
// }
function register(entry) {
  if (!entry || !Array.isArray(entry.triggers) || entry.triggers.length === 0) {
    throw new Error('commandCatalog.register: triggers 必填');
  }
  if (!['public', 'admin', 'manager'].includes(entry.audience)) {
    throw new Error(`commandCatalog.register: audience 不合法：${entry.audience}`);
  }
  registry.push({
    triggers:    entry.triggers.slice(),
    audience:    entry.audience,
    category:    entry.category || '其他',
    description: entry.description || '',
    example:     entry.example || null,
  });
}

function all() {
  return registry.slice();
}

// 過濾出當前角色能用的指令
// isAdmin / isManager 由呼叫端判斷後傳入
function forRole({ isAdmin = false, isManager = false } = {}) {
  return registry.filter(c => {
    if (c.audience === 'public')  return true;
    if (c.audience === 'admin')   return isAdmin || isManager;
    if (c.audience === 'manager') return isManager;
    return false;
  });
}

function _sortCategories(names) {
  const order = new Map(CATEGORY_ORDER.map((k, i) => [k, i]));
  return names.slice().sort((a, b) => {
    const ai = order.has(a) ? order.get(a) : Infinity;
    const bi = order.has(b) ? order.get(b) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function buildHelpMessage(entries) {
  if (!entries || entries.length === 0) return '目前沒有可用指令。';

  const byCategory = new Map();
  for (const e of entries) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }

  const lines = ['📋 VLB LINE Bot 指令清單', ''];
  for (const cat of _sortCategories([...byCategory.keys()])) {
    lines.push(`【${cat}】`);
    for (const it of byCategory.get(cat)) {
      const trig = it.triggers.join(' / ');
      lines.push(`• ${trig}`);
      lines.push(`   ${it.description}`);
      if (it.example) lines.push(`   例：${it.example}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// 測試用：清空註冊表
function _resetForTest() { registry.length = 0; }

module.exports = { register, all, forRole, buildHelpMessage, CATEGORY_ORDER, _resetForTest };
