'use strict';

// 記憶體版成員名單 & 請假例外，測試中可讀寫
let mockMembers = [];
let mockLeaveExceptions = [];

// commands.js 也會 require sheets 的一堆函式；為避免載入時炸掉，把它需要的欄位都補齊（回傳空即可）
jest.mock('../src/sheets', () => ({
  getAllMembers:            jest.fn(async () => mockMembers.map(m => ({ ...m }))),
  addMember:                jest.fn(async ({ name, lineUserId }) => { mockMembers.push({ name, id: lineUserId }); return true; }),
  removeMemberByName:       jest.fn(async (name) => {
    const idx = mockMembers.findIndex(m => m.name === name);
    if (idx === -1) return null;
    const [removed] = mockMembers.splice(idx, 1);
    return removed;
  }),
  removeMemberById:         jest.fn(async (id) => {
    const idx = mockMembers.findIndex(m => m.id === id);
    if (idx === -1) return null;
    const [removed] = mockMembers.splice(idx, 1);
    return removed;
  }),
  getAllLeaveExceptions:    jest.fn(async () => mockLeaveExceptions.map(e => ({ ...e }))),
  addLeaveException:        jest.fn(async ({ name, lineUserId, leaveType, startDate, endDate, note }) => {
    mockLeaveExceptions.push({ name, lineUserId, leaveType, startDate, endDate, note: note || '' });
    return true;
  }),
  getTaiwanDateString:      jest.fn().mockReturnValue('2026/08/14'),
  // commands.js 需要（載入時不會呼叫，只需存在）
  getTodayLogs:             jest.fn(async () => []),
  getWeeklyLogs:            jest.fn(async () => []),
  getAllMemberNames:        jest.fn(async () => []),
  getTaiwanTimeString:      jest.fn().mockReturnValue('10:00'),
  getMonthlyAnomalies:      jest.fn(async () => []),
  getTaiwanMonthString:     jest.fn().mockReturnValue('2026/08'),
  getLeaveRecordsThisWeek:  jest.fn(async () => []),
  getLeaveRecordsForMonth:  jest.fn(async () => []),
  getMonthLogs:             jest.fn(async () => []),
  getSopSettings:           jest.fn(async () => ({})),
  getHolidaySet:            jest.fn(async () => new Set()),
}));

const MANAGER_ID = 'U11111111111111111111111111111111';
const OTHER_ID   = 'U22222222222222222222222222222222';
const VALID_ID   = 'U1234567890abcdef1234567890abcdef';

process.env.MANAGER_USER_IDS = MANAGER_ID;
process.env.ADMIN_LINE_USER_ID = MANAGER_ID; // 讓 catalog 判斷 isAdmin 也對得上

const mc = require('../src/managerCommands');
// 也載入 commands.js，確保它把公開指令（今日狀況、本月工作進度統計 等）註冊進 catalog
require('../src/commands');

beforeEach(() => {
  mockMembers = [
    { name: '阿啾', id: 'U1604db7615d2864557e6110e981ef503' },
    { name: '小芯', id: 'Ud91255d03cf309eaa6d8051cfe291492' },
  ];
  mockLeaveExceptions = [];
  mc._resetStateForTest();
});

// ============================================================
// 權限
// ============================================================
describe('權限', () => {
  test('主管識別正確', () => {
    expect(mc.isManager(MANAGER_ID)).toBe(true);
    expect(mc.isManager(OTHER_ID)).toBe(false);
    expect(mc.isManager(undefined)).toBe(false);
  });

  test('非主管呼叫寫入型指令 → 一律回 null（由 lineHandler 決定要不要回主管專用）', async () => {
    expect(await mc.handleManagerCommand('新增成員', OTHER_ID)).toBeNull();
    expect(await mc.handleManagerCommand('移除成員', OTHER_ID)).toBeNull();
    expect(await mc.handleManagerCommand('成員列表', OTHER_ID)).toBeNull();
  });

  test('非主管呼叫「功能」→ 回公開清單（不包含成員管理）', async () => {
    const reply = await mc.handleManagerCommand('功能', OTHER_ID);
    expect(reply).toContain('指令清單');
    expect(reply).toContain('本月工作進度統計'); // 公開
    expect(reply).not.toContain('新增成員');    // manager-only 不顯示
    expect(reply).not.toContain('長期請假列表');
  });

  test('isRestrictedKeyword 只擋改動類指令，不擋 help/? 等資訊類', () => {
    expect(mc.isRestrictedKeyword('新增成員')).toBe(true);
    expect(mc.isRestrictedKeyword('移除成員')).toBe(true);
    expect(mc.isRestrictedKeyword('成員列表')).toBe(true);
    expect(mc.isRestrictedKeyword('長期請假列表')).toBe(true);
    expect(mc.isRestrictedKeyword('請假 阿啾 特休 2026/08/01 2026/08/02')).toBe(true);
    expect(mc.isRestrictedKeyword('功能')).toBe(false);
    expect(mc.isRestrictedKeyword('help')).toBe(false);
    // 「請假」單獨（沒空格接參數）不擋，避免和小編的請假關鍵字衝突
    expect(mc.isRestrictedKeyword('請假')).toBe(false);
  });
});

// ============================================================
// normalize / 容錯
// ============================================================
describe('normalize', () => {
  test('全形空格轉半形、trim、多空白折疊', () => {
    expect(mc.normalize('  新增成員  ')).toBe('新增成員');
    expect(mc.normalize('彭德芬　' + VALID_ID)).toBe('彭德芬 ' + VALID_ID);
    expect(mc.normalize('a　　b   c')).toBe('a b c');
  });
});

// ============================================================
// 功能／同義字
// ============================================================
describe('功能／help 同義字（主管）', () => {
  test.each(['功能', '指令', '選單', 'help', 'Help', 'HELP', '?', '？'])('%s → 顯示完整指令清單', async (kw) => {
    const reply = await mc.handleManagerCommand(kw, MANAGER_ID);
    expect(reply).toContain('指令清單');
    // 主管專用指令
    expect(reply).toContain('新增成員');
    expect(reply).toContain('移除成員');
    expect(reply).toContain('成員列表');
    expect(reply).toContain('長期請假列表');
    // 進度查詢（admin 或 public 皆會顯示給主管）
    expect(reply).toContain('今日狀況');
    expect(reply).toContain('週報');
    expect(reply).toContain('本週產能');
    expect(reply).toContain('月報');
    expect(reply).toContain('本月工作進度統計');
    expect(reply).toContain('本月剪輯統計');
    // 尾端主管操作提示
    expect(reply).toContain('取消');
  });
});

// ============================================================
// 成員列表
// ============================================================
describe('成員列表', () => {
  test('列出目前成員，ID 只顯示後 4 碼', async () => {
    const reply = await mc.handleManagerCommand('成員列表', MANAGER_ID);
    expect(reply).toContain('共 2 位');
    expect(reply).toContain('阿啾');
    expect(reply).toContain('小芯');
    expect(reply).toContain('…f503'); // 阿啾 ID 後 4 碼
  });
});

// ============================================================
// 新增成員兩段式
// ============================================================
describe('新增成員', () => {
  test('完整流程：進入模式 → 貼資料 → 寫入', async () => {
    const enter = await mc.handleManagerCommand('新增成員', MANAGER_ID);
    expect(enter).toContain('請貼上要新增的成員');

    const done = await mc.handleManagerCommand(`彭德芬 ${VALID_ID}`, MANAGER_ID);
    expect(done).toContain('✅ 已新增成員：彭德芬');
    expect(done).toContain('共 3 位');
    expect(mockMembers).toHaveLength(3);
    expect(mockMembers[2]).toEqual({ name: '彭德芬', id: VALID_ID });
  });

  test('全形空格分隔也能解析', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const done = await mc.handleManagerCommand(`彭德芬　${VALID_ID}`, MANAGER_ID);
    expect(done).toContain('✅ 已新增成員：彭德芬');
  });

  test('ID 格式錯誤：不寫入、留在模式讓再試一次', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const bad = await mc.handleManagerCommand('小明 U-not-valid', MANAGER_ID);
    expect(bad).toContain('❌');
    expect(bad).toContain('格式不對');
    expect(mockMembers).toHaveLength(2);
    // 仍在模式中：直接再貼合法資料就能成功
    const ok = await mc.handleManagerCommand(`小明 ${VALID_ID}`, MANAGER_ID);
    expect(ok).toContain('✅ 已新增成員：小明');
  });

  test('缺欄位（只有姓名）：留在模式', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const bad = await mc.handleManagerCommand('只有姓名', MANAGER_ID);
    expect(bad).toContain('❌');
    expect(bad).toContain('格式錯誤');
    const ok = await mc.handleManagerCommand(`只有姓名 ${VALID_ID}`, MANAGER_ID);
    expect(ok).toContain('✅');
  });

  test('重複 ID：不寫入、結束模式', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const reply = await mc.handleManagerCommand(`另一名 U1604db7615d2864557e6110e981ef503`, MANAGER_ID);
    expect(reply).toContain('⚠️');
    expect(reply).toContain('已存在');
    expect(mockMembers).toHaveLength(2);
  });

  test('重複姓名：不寫入、結束模式', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const reply = await mc.handleManagerCommand(`阿啾 ${VALID_ID}`, MANAGER_ID);
    expect(reply).toContain('⚠️');
    expect(reply).toContain('阿啾');
    expect(mockMembers).toHaveLength(2);
  });

  test('取消：結束模式、不新增', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const reply = await mc.handleManagerCommand('取消', MANAGER_ID);
    expect(reply).toBe('✅ 已取消。');
    // 取消後再貼資料應該不會被誤解為 add input
    const after = await mc.handleManagerCommand(`彭德芬 ${VALID_ID}`, MANAGER_ID);
    expect(after).toBeNull();
    expect(mockMembers).toHaveLength(2);
  });
});

// ============================================================
// 移除成員兩段式
// ============================================================
describe('移除成員', () => {
  test('用姓名移除', async () => {
    const enter = await mc.handleManagerCommand('移除成員', MANAGER_ID);
    expect(enter).toContain('請貼上要移除的成員姓名');
    const done = await mc.handleManagerCommand('小芯', MANAGER_ID);
    expect(done).toContain('✅ 已移除成員：小芯');
    expect(done).toContain('共 1 位');
    expect(mockMembers).toHaveLength(1);
    expect(mockMembers[0].name).toBe('阿啾');
  });

  test('用 ID 移除', async () => {
    await mc.handleManagerCommand('移除成員', MANAGER_ID);
    const done = await mc.handleManagerCommand('Ud91255d03cf309eaa6d8051cfe291492', MANAGER_ID);
    expect(done).toContain('✅ 已移除成員：小芯');
    expect(mockMembers).toHaveLength(1);
  });

  test('找不到：留在模式', async () => {
    await mc.handleManagerCommand('移除成員', MANAGER_ID);
    const bad = await mc.handleManagerCommand('不存在', MANAGER_ID);
    expect(bad).toContain('❌');
    expect(bad).toContain('找不到成員：不存在');
    // 仍在模式中：直接改貼正確姓名可成功
    const ok = await mc.handleManagerCommand('阿啾', MANAGER_ID);
    expect(ok).toContain('✅ 已移除成員：阿啾');
  });

  test('同名多筆：列出並要求貼 ID', async () => {
    mockMembers.push({ name: '阿啾', id: 'U9999999999999999999999999999999b' });
    await mc.handleManagerCommand('移除成員', MANAGER_ID);
    const reply = await mc.handleManagerCommand('阿啾', MANAGER_ID);
    expect(reply).toContain('⚠️ 同名多筆');
    expect(reply).toContain('U1604db7615d2864557e6110e981ef503');
    expect(reply).toContain('U9999999999999999999999999999999b');
    // 貼 ID 精準刪除
    const done = await mc.handleManagerCommand('U9999999999999999999999999999999b', MANAGER_ID);
    expect(done).toContain('✅ 已移除');
    expect(mockMembers.filter(m => m.name === '阿啾')).toHaveLength(1);
  });

  test('取消', async () => {
    await mc.handleManagerCommand('移除成員', MANAGER_ID);
    const reply = await mc.handleManagerCommand('取消', MANAGER_ID);
    expect(reply).toBe('✅ 已取消。');
    expect(mockMembers).toHaveLength(2);
  });
});

// ============================================================
// 狀態切換與逾時
// ============================================================
describe('狀態管理', () => {
  test('模式中重傳主指令 → 切換模式', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    // 中途改主意 → 切成移除模式
    const swap = await mc.handleManagerCommand('移除成員', MANAGER_ID);
    expect(swap).toContain('請貼上要移除的成員姓名');
    const done = await mc.handleManagerCommand('小芯', MANAGER_ID);
    expect(done).toContain('✅ 已移除');
  });

  test('模式中傳其他主指令（成員列表）→ 也能執行', async () => {
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    const list = await mc.handleManagerCommand('成員列表', MANAGER_ID);
    expect(list).toContain('目前成員');
    // 主指令執行後仍在 add 模式（因為只是查詢，未觸發結束）
    // 再貼資料仍能新增
    const done = await mc.handleManagerCommand(`小新 ${VALID_ID}`, MANAGER_ID);
    expect(done).toContain('✅ 已新增成員：小新');
  });

  test('5 分鐘逾時：貼資料回 null（未處理）', async () => {
    jest.useFakeTimers();
    try {
      await mc.handleManagerCommand('新增成員', MANAGER_ID);
      jest.advanceTimersByTime(mc.STATE_TTL_MS + 1000);
      const late = await mc.handleManagerCommand(`彭德芬 ${VALID_ID}`, MANAGER_ID);
      expect(late).toBeNull(); // 逾時後貼資料視為一般訊息，未處理
      expect(mockMembers).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('不同 userId 不會互相干擾（雖然只有主管能觸發，但測隔離）', async () => {
    process.env.MANAGER_USER_IDS = `${MANAGER_ID},${OTHER_ID}`;
    await mc.handleManagerCommand('新增成員', MANAGER_ID);
    // OTHER_ID 沒進模式：貼資料應回 null
    const other = await mc.handleManagerCommand(`X ${VALID_ID}`, OTHER_ID);
    expect(other).toBeNull();
    // MANAGER_ID 仍在模式，貼資料能新增
    const done = await mc.handleManagerCommand(`Y ${VALID_ID}`, MANAGER_ID);
    expect(done).toContain('✅ 已新增成員：Y');
    process.env.MANAGER_USER_IDS = MANAGER_ID; // 還原
  });
});

// ============================================================
// 長期請假指令
// ============================================================
describe('長期請假指令', () => {
  test('用姓名 + 完整參數 → 寫入請假例外', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休 2026/08/12 2026/08/13', MANAGER_ID);
    expect(reply).toContain('✅ 已登記長期請假');
    expect(reply).toContain('阿啾');
    expect(reply).toContain('特休');
    expect(reply).toContain('2026/08/12 ~ 2026/08/13');
    expect(mockLeaveExceptions).toHaveLength(1);
    expect(mockLeaveExceptions[0]).toEqual({
      name: '阿啾', lineUserId: 'U1604db7615d2864557e6110e981ef503',
      leaveType: '特休', startDate: '2026/08/12', endDate: '2026/08/13', note: '',
    });
  });

  test('備註可含多個字（含空格）', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休 2026/08/12 2026/08/13 家庭 事務', MANAGER_ID);
    expect(reply).toContain('家庭 事務');
    expect(mockLeaveExceptions[0].note).toBe('家庭 事務');
  });

  test('用 ID 也可以', async () => {
    const reply = await mc.handleManagerCommand('請假 U1604db7615d2864557e6110e981ef503 特休 2026/08/12 2026/08/13', MANAGER_ID);
    expect(reply).toContain('✅');
    expect(mockLeaveExceptions[0].name).toBe('阿啾');
    expect(mockLeaveExceptions[0].lineUserId).toBe('U1604db7615d2864557e6110e981ef503');
  });

  test('全形空格分隔也能解析', async () => {
    const reply = await mc.handleManagerCommand('請假　阿啾　特休　2026/08/12　2026/08/13', MANAGER_ID);
    expect(reply).toContain('✅');
    expect(mockLeaveExceptions).toHaveLength(1);
  });

  test('找不到成員 → 錯誤、不寫入', async () => {
    const reply = await mc.handleManagerCommand('請假 不存在 特休 2026/08/12 2026/08/13', MANAGER_ID);
    expect(reply).toContain('❌');
    expect(reply).toContain('找不到成員');
    expect(mockLeaveExceptions).toHaveLength(0);
  });

  test('假別不合法 → 錯誤、列出可用假別', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 亂七八糟假 2026/08/12 2026/08/13', MANAGER_ID);
    expect(reply).toContain('❌');
    expect(reply).toContain('公假');
    expect(mockLeaveExceptions).toHaveLength(0);
  });

  test('日期格式錯誤 → 錯誤', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休 8/12 8/13', MANAGER_ID);
    expect(reply).toContain('❌');
    expect(reply).toContain('YYYY/MM/DD');
    expect(mockLeaveExceptions).toHaveLength(0);
  });

  test('開始日期晚於結束日期 → 錯誤', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休 2026/08/13 2026/08/12', MANAGER_ID);
    expect(reply).toContain('❌');
    expect(reply).toContain('晚於結束');
    expect(mockLeaveExceptions).toHaveLength(0);
  });

  test('欄位不足 → 錯誤', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休', MANAGER_ID);
    expect(reply).toContain('❌');
    expect(reply).toContain('欄位不足');
  });

  test('非主管傳「請假 ...」→ handleManagerCommand 回 null（讓 lineHandler 決定擋下）', async () => {
    const reply = await mc.handleManagerCommand('請假 阿啾 特休 2026/08/12 2026/08/13', OTHER_ID);
    expect(reply).toBeNull();
    expect(mockLeaveExceptions).toHaveLength(0);
  });

  test('非主管單獨傳「請假」→ 不視為主管指令（保留小編請假語意）', () => {
    expect(mc.isRestrictedKeyword('請假')).toBe(false);
  });
});

// ============================================================
// 長期請假列表
// ============================================================
describe('長期請假列表', () => {
  test('空白時提示', async () => {
    const reply = await mc.handleManagerCommand('長期請假列表', MANAGER_ID);
    expect(reply).toContain('沒有任何');
  });

  test('有資料時列出', async () => {
    mockLeaveExceptions = [
      { name: '阿啾',  lineUserId: 'U1',  leaveType: '特休', startDate: '2026/08/12', endDate: '2026/08/13', note: '' },
      { name: '吻仔魚', lineUserId: 'U2', leaveType: '公假', startDate: '2026/08/01', endDate: '2026/08/16', note: '8/17 回來' },
    ];
    const reply = await mc.handleManagerCommand('長期請假列表', MANAGER_ID);
    expect(reply).toContain('共 2 筆');
    expect(reply).toContain('阿啾');
    expect(reply).toContain('特休');
    expect(reply).toContain('2026/08/12 ~ 2026/08/13');
    expect(reply).toContain('吻仔魚');
    expect(reply).toContain('公假');
    expect(reply).toContain('8/17 回來');
  });
});

// ============================================================
// 功能清單包含新指令（catalog 整合）
// ============================================================
describe('功能清單', () => {
  test('顯示長期請假與請假列表', async () => {
    const reply = await mc.handleManagerCommand('功能', MANAGER_ID);
    expect(reply).toContain('請假');
    expect(reply).toContain('長期請假列表');
    // 起訖範例出現在 example 行
    expect(reply).toContain('2026/08/01');
  });

  test('分組標題出現', async () => {
    const reply = await mc.handleManagerCommand('功能', MANAGER_ID);
    expect(reply).toContain('【進度查詢｜每日】');
    expect(reply).toContain('【進度查詢｜每週】');
    expect(reply).toContain('【進度查詢｜每月】');
    expect(reply).toContain('【請假查詢】');
    expect(reply).toContain('【成員管理（主管）】');
    expect(reply).toContain('【長期請假（主管）】');
    expect(reply).toContain('【說明】');
  });
});
