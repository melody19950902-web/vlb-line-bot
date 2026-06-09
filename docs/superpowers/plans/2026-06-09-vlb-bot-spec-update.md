# VLB LINE Bot 規則更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將完整規則指令文件（2026年6月版）同步進現有 VLB LINE Bot 程式碼，補上缺漏功能、修正彙整格式、新增工作類型。

**Architecture:** 現有程式碼已有良好模組分工（parser/analysis/notifier/commands/sheets）；本次更新沿用既有架構，逐模組補齊 spec 與程式碼的落差，不做架構重構。

**Tech Stack:** Node.js 18+, @line/bot-sdk, googleapis, jest

---

## 落差摘要（spec vs 現有程式碼）

| 項目 | 現有 | 缺漏 |
|------|------|------|
| 工作類型 | 7 種 | 需加 8 種新類型（跟拍日、課程日各組、大型活動日各組） |
| detectSpecialDayType | 處理外拍/課程拍攝/直播 | 未處理跟拍日、Podcast日、直播日、課程日（各組）關鍵字 |
| 發布回報偵測 | 只接受 `已發布｜` 格式 | 舊格式（`發布完成`）未識別 |
| 剪輯進度回報 | 未實作 | 需新增 `剪輯進度｜標題｜狀態` 識別與儲存 |
| 22:30 彙整格式 | `✅ 名｜達成工作標準` | 應為 `✅ 名｜正常`；頁尾文字不符 |
| 週日排程 | 週六跳過，週日未處理 | 週日應完全不發送 |
| 月度異常通報 | 僅顯示次數 | 需附日期與類型清單 |
| 月報指令 | 未實作 | `月報` → 本月每人異常累計 |
| Claude 系統提示 | 舊工作類型 | 需同步更新 |

---

## 檔案變更地圖

| 檔案 | 變更類型 | 內容 |
|------|----------|------|
| `src/parser.js` | 修改 | 新增 VALID_DAY_TYPES、COURSE_DAY_TYPES、detectSpecialDayType |
| `src/sheets.js` | 修改 | 新增 saveEditProgress、更新 DEFAULT_DAY_TYPE_RULES |
| `src/lineHandler.js` | 修改 | isPublishReport 舊格式支援、新增剪輯進度偵測與處理 |
| `src/notifier.js` | 修改 | 週日不發送、彙整格式修正、月度通報附日期 |
| `src/commands.js` | 修改 | 新增 月報 指令 |
| `src/analysis.js` | 修改 | 系統提示同步新工作類型 |
| `tests/parser.test.js` | 修改 | 補測新工作類型 |
| `tests/lineHandler.test.js` | 修改 | 補測舊格式發布、剪輯進度 |

---

## Task 1: 更新 parser.js — 新工作類型

**Files:**
- Modify: `src/parser.js:6-13` (VALID_DAY_TYPES)
- Modify: `src/parser.js:12` (COURSE_DAY_TYPES)
- Modify: `src/parser.js:196-213` (detectSpecialDayType)
- Test: `tests/parser.test.js`

- [ ] **Step 1: 寫失敗測試（新工作類型）**

在 `tests/parser.test.js` 的 `detectSpecialDayType` describe 區塊末尾加入：

```javascript
test('跟拍日', () => {
  const result = detectSpecialDayType('跟拍日');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('跟拍日');
});

test('Podcast日', () => {
  const result = detectSpecialDayType('Podcast日');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('Podcast日');
});

test('直播日', () => {
  const result = detectSpecialDayType('直播日');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('直播日');
});

test('課程日（拍攝組）', () => {
  const result = detectSpecialDayType('課程日（拍攝組）');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('課程日（拍攝組）');
});

test('課程日（限動組）', () => {
  const result = detectSpecialDayType('課程日（限動組）');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('課程日（限動組）');
});

test('大型活動日（短影音組）', () => {
  const result = detectSpecialDayType('大型活動日（短影音組）');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('大型活動日（短影音組）');
});

test('大型活動日（拍照修片組）', () => {
  const result = detectSpecialDayType('大型活動日（拍照修片組）');
  expect(result).not.toBeNull();
  expect(result.dayType).toBe('大型活動日（拍照修片組）');
});
```

在 `parseWorkLog` describe 區塊加入：

```javascript
test('新工作類型 — 跟拍日 可解析', () => {
  const text = `今日類型：跟拍日\n影片數量：0`;
  const result = parseWorkLog(text);
  expect(result.error).toBeUndefined();
  expect(result.dayType).toBe('跟拍日');
});

test('新工作類型 — 課程日（拍攝組）可解析', () => {
  const text = `今日類型：課程日（拍攝組）\n影片數量：0`;
  const result = parseWorkLog(text);
  expect(result.error).toBeUndefined();
  expect(result.dayType).toBe('課程日（拍攝組）');
});

test('新工作類型 — 大型活動日（短影音組）可解析', () => {
  const text = `今日類型：大型活動日（短影音組）\n影片數量：1`;
  const result = parseWorkLog(text);
  expect(result.error).toBeUndefined();
  expect(result.dayType).toBe('大型活動日（短影音組）');
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && npm test -- --testPathPattern=tests/parser
```

Expected: FAIL — `detectSpecialDayType` 回傳 null，parseWorkLog 回傳 error

- [ ] **Step 3: 更新 parser.js**

將 `src/parser.js` 的 `VALID_DAY_TYPES` 陣列改為：

```javascript
const VALID_DAY_TYPES = [
  '正常日',
  '跟拍日',
  'Podcast日',
  '直播日',
  '課程日',
  '課程日（拍攝組）',
  '課程日（拍照組）',
  '課程日（限動組）',
  '課程日（行政支援）',
  '大型活動日（短影音組）',
  '大型活動日（限動組）',
  '大型活動日（拍照修片組）',
  '拍攝日',
  '外拍半天',
  '外拍一天',
];
```

將 `COURSE_DAY_TYPES` 改為：

```javascript
const COURSE_DAY_TYPES = new Set([
  '課程日',
  '課程日（拍攝組）',
  '課程日（拍照組）',
  '課程日（限動組）',
  '課程日（行政支援）',
]);
```

將 `detectSpecialDayType` 改為：

```javascript
function detectSpecialDayType(text) {
  if (!text) return null;
  const t = text.trim();

  // 直接關鍵字對應（不需額外參數的工作類型）
  const DIRECT_KEYWORDS = [
    '跟拍日', 'Podcast日', '直播日',
    '課程日（拍攝組）', '課程日（拍照組）',
    '課程日（限動組）', '課程日（行政支援）',
    '大型活動日（短影音組）', '大型活動日（限動組）',
    '大型活動日（拍照修片組）',
    '外拍半天', '外拍一天',
  ];

  if (DIRECT_KEYWORDS.includes(t)) {
    return { dayType: t, hours: null };
  }

  const courseMatch = t.match(/^課程拍攝\s*(\d+)\s*小時/);
  if (courseMatch) return { dayType: `課程拍攝 ${courseMatch[1]} 小時`, hours: parseInt(courseMatch[1]) };

  const liveMatch = t.match(/^直播\s*(\d+)\s*小時/);
  if (liveMatch) return { dayType: `直播 ${liveMatch[1]} 小時`, hours: parseInt(liveMatch[1]) };

  const eventMatch = t.match(/^(活動外拍|課程拍攝)｜(.+)/);
  if (eventMatch) return { dayType: `${eventMatch[1]}｜${eventMatch[2]}`, hours: null };

  return null;
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && npm test -- --testPathPattern=tests/parser
```

Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/parser.js tests/parser.test.js && git commit -m "feat: 新增8種工作類型，更新detectSpecialDayType"
```

---

## Task 2: 更新 sheets.js — 新日類型預設值 + 剪輯進度儲存

**Files:**
- Modify: `src/sheets.js:51-59` (DEFAULT_DAY_TYPE_RULES)
- Modify: `src/sheets.js:363+` (新增 saveEditProgress)

- [ ] **Step 1: 更新 DEFAULT_DAY_TYPE_RULES**

將 `src/sheets.js` 的 `DEFAULT_DAY_TYPE_RULES` 改為：

```javascript
const DEFAULT_DAY_TYPE_RULES = [
  { 工作類型: '正常日',                最低影片數: 3 },
  { 工作類型: '跟拍日',                最低影片數: 0 },
  { 工作類型: 'Podcast日',             最低影片數: 0 },
  { 工作類型: '直播日',                最低影片數: 0 },
  { 工作類型: '課程日',                最低影片數: 0 },
  { 工作類型: '課程日（拍攝組）',       最低影片數: 0 },
  { 工作類型: '課程日（拍照組）',       最低影片數: 0 },
  { 工作類型: '課程日（限動組）',       最低影片數: 0 },
  { 工作類型: '課程日（行政支援）',     最低影片數: 0 },
  { 工作類型: '大型活動日（短影音組）', 最低影片數: 1 },
  { 工作類型: '大型活動日（限動組）',   最低影片數: 0 },
  { 工作類型: '大型活動日（拍照修片組）',最低影片數: 0 },
  { 工作類型: '拍攝日',                最低影片數: 1 },
  { 工作類型: '外拍半天',              最低影片數: 1 },
  { 工作類型: '外拍一天',              最低影片數: 0 },
];
```

- [ ] **Step 2: 新增 saveEditProgress 函式**

在 `src/sheets.js` 的 `saveFingerprint` 函式前插入：

```javascript
// ============================================================
// 剪輯進度記錄
// 欄位：日期 | 時間 | 姓名 | LINE_User_ID | 影片標題 | 狀態
// ============================================================

async function saveEditProgress({ date, time, name, lineUserId, title, status }) {
  return appendRow('剪輯進度', [date, time, name, lineUserId, title, status]);
}
```

在 `module.exports` 中加入 `saveEditProgress`：

```javascript
module.exports = {
  // ... 既有 exports ...
  saveEditProgress,
  // ...
};
```

- [ ] **Step 3: 確認語法正確**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && node -e "require('./src/sheets.js'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/sheets.js && git commit -m "feat: 更新日類型預設值，新增剪輯進度儲存"
```

---

## Task 3: 更新 lineHandler.js — 舊格式發布 + 剪輯進度

**Files:**
- Modify: `src/lineHandler.js:37-39` (isPublishReport)
- Modify: `src/lineHandler.js:3-4` (imports)
- Modify: `src/lineHandler.js:174+` (handleEvent)
- Test: `tests/lineHandler.test.js`

- [ ] **Step 1: 寫失敗測試**

在 `tests/lineHandler.test.js` 的 `isPublishReport` describe 加入：

```javascript
test('舊格式 — 《帳號》發布完成 → true', () => {
  expect(isPublishReport('《薔薇的職場女人說》第一更 IG、Threads、FB 發布完成（留言/私訊皆已回覆）')).toBe(true);
});

test('舊格式 — 包含發布完成字樣 → true', () => {
  expect(isPublishReport('第一更 IG 發布完成')).toBe(true);
});
```

在 `tests/lineHandler.test.js` 新增：

```javascript
// ============================================================
// isEditProgress
// ============================================================

// 需先從 lineHandler 取得 isEditProgress（下一步實作後才能解鎖）
describe('isEditProgress', () => {
  let isEditProgress;
  beforeAll(() => {
    isEditProgress = require('../src/lineHandler').isEditProgress;
  });

  test('標準剪輯進度格式 → true', () => {
    expect(isEditProgress('剪輯進度｜今日短影音｜剪輯中')).toBe(true);
  });

  test('已完成狀態 → true', () => {
    expect(isEditProgress('剪輯進度｜本週 Podcast 剪輯｜已完成')).toBe(true);
  });

  test('一般訊息 → false', () => {
    expect(isEditProgress('今天剪了幾支影片')).toBe(false);
  });

  test('null → false', () => {
    expect(isEditProgress(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && npm test -- --testPathPattern=tests/lineHandler
```

Expected: FAIL — 舊格式 isPublishReport 返回 false，isEditProgress 未定義

- [ ] **Step 3: 更新 lineHandler.js**

更新 imports（第 3 行）：

```javascript
const { parseWorkLog, detectSpecialDayType } = require('./analyzer');
const { saveWorkLog, savePublishReport, saveLeaveRecord, saveEditProgress, getMemberName,
        getTaiwanDateString, getTaiwanTimeString }           = require('./sheets');
```

將 `isPublishReport` 函式改為（第 37-39 行）：

```javascript
// 發布回報（新格式：已發布｜平台｜帳號；舊格式：含「發布完成」字樣）
function isPublishReport(text) {
  if (!text) return false;
  const t = text.trim();
  return /^已發布[｜|]/.test(t) || t.includes('發布完成');
}
```

在 `isPublishReport` 後新增 `isEditProgress`：

```javascript
// 剪輯進度上傳（格式：剪輯進度｜影片標題｜狀態）
function isEditProgress(text) {
  if (!text) return false;
  return /^剪輯進度[｜|]/.test(text.trim());
}
```

在 `processPublishReport` 函式後新增：

```javascript
// ============================================================
// 剪輯進度處理（靜默儲存至剪輯進度記錄）
// ============================================================

async function processEditProgress(text, userId, client, source) {
  const memberName = await getMemberDisplayName(userId, client, source);
  const date       = getTaiwanDateString();
  const time       = getTaiwanTimeString();

  // 解析格式：剪輯進度｜影片標題｜狀態
  const parts = text.split(/[｜|]/);
  const title  = parts[1] ? parts[1].trim() : text;
  const status = parts[2] ? parts[2].trim() : '未知';

  await saveEditProgress({ date, time, name: memberName, lineUserId: userId, title, status });
  console.log(`✂️ [剪輯進度] ${memberName} | ${title} | ${status}`);
  return null; // 靜默接收
}
```

在 `handleEvent` 的 `isPublishReport` 判斷後加入：

```javascript
// 剪輯進度（靜默記錄，不回覆）
else if (isEditProgress(text)) {
  await processEditProgress(text, userId, client, source);
  return; // 不回覆
}
```

在 `module.exports` 加入 `isEditProgress`：

```javascript
module.exports = { handleEvent, isWorkLog, isPublishReport, parseLeaveRequest, isEditProgress };
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && npm test -- --testPathPattern=tests/lineHandler
```

Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/lineHandler.js tests/lineHandler.test.js && git commit -m "feat: 支援舊格式發布回報，新增剪輯進度識別"
```

---

## Task 4: 修正 notifier.js — 彙整格式 + 週日 + 月度通報

**Files:**
- Modify: `src/notifier.js:174-177` (isTaiwanSaturday / 新增 isTaiwanSunday)
- Modify: `src/notifier.js:236+` (sendDailySummary)
- Modify: `src/notifier.js:444-460` (月度異常通報)

- [ ] **Step 1: 在 `isTaiwanSaturday` 後新增 `isTaiwanSunday`**

在 `src/notifier.js` 的 `isTaiwanSaturday` 函式後加入：

```javascript
function isTaiwanSunday() {
  const taiwanDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return taiwanDate.getDay() === 0;
}
```

- [ ] **Step 2: 在 sendDailySummary 開頭加入週日判斷**

在 `sendDailySummary` 函式的 `if (isTaiwanSaturday())` 之前加入：

```javascript
// 週日不執行任何彙整
if (isTaiwanSunday()) {
  console.log('🔕 今日為週日，不執行彙整');
  return;
}
```

- [ ] **Step 3: 修正正常狀態行格式**

找到 `notifier.js` 中這段（約第 390-394 行）：

```javascript
} else if (row[7] === 'normal') {
  const isSpecialDay = /外拍半天|外拍一天|課程拍攝|直播\s*\d|活動外拍/.test(row[4] || '');
  const line = isSpecialDay ? `✅ ${name}｜${row[4]}` : `✅ ${name}｜達成工作標準`;
  groupLines.push(line);
  adminLines.push(line);
}
```

改為：

```javascript
} else if (row[7] === 'normal') {
  const line = `✅ ${name}｜正常`;
  groupLines.push(line);
  adminLines.push(line);
}
```

- [ ] **Step 4: 修正頁尾文字**

找到 `notifier.js` 中：

```javascript
allNormal
  ? `${allMembers.length} 人全員達成工作標準，辛苦了！`
  : `${allMembers.length} 人狀態已確認。`,
```

改為：

```javascript
allNormal
  ? `${allMembers.length} 人全員正常，辛苦了！`
  : `${allMembers.length} 人狀態已確認。`,
```

- [ ] **Step 5: 修正月度異常通報格式（附日期與類型清單）**

找到 `notifier.js` 中月度異常通報區塊（約第 444-459 行）：

```javascript
const records = await getMonthlyAnomalies(month, name);
const count = records.length;
if (count >= 4) {
  const alertMsg = [
    `🚨 月度異常通報`,
    `小編：${name}`,
    `本月（${month}）累計異常：${count} 次`,
    `最新異常：${anomalyType}（${today}）`,
    ``,
    `請盡快與 ${name} 確認狀況。`,
  ].join('\n');
  await notifyAdminLine(client, alertMsg);
}
```

改為：

```javascript
const records = await getMonthlyAnomalies(month, name);
const count = records.length;
if (count >= 4) {
  // 只計算 ⚠️異常 或 ❗未回報，排除請假
  const anomalyRecords = records.filter(r => r[3] !== '病假' && r[3] !== '事假' && r[3] !== '休假' && r[3] !== '補休');
  const dateList = anomalyRecords.map(r => {
    const emoji = r[3] === '未回報' ? '❗' : '⚠️';
    return `${emoji} ${r[2]}`;
  }).join('、');

  const alertMsg = [
    `🚨 月度異常警示`,
    ``,
    `${name} 本月已累積 ${anomalyRecords.length} 次異常`,
    dateList ? `（${dateList}）` : '',
    ``,
    `請主管留意並確認狀況。`,
  ].filter(line => line !== '').join('\n');
  await notifyAdminLine(client, alertMsg);
}
```

- [ ] **Step 6: 確認語法正確**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && node -e "require('./src/notifier.js'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/notifier.js && git commit -m "fix: 週日不執行彙整，正常狀態顯示「正常」，月度通報附日期"
```

---

## Task 5: 新增 月報 指令 (commands.js)

**Files:**
- Modify: `src/commands.js:53-81` (detectCommand, handleCommand)
- Modify: `src/commands.js:3` (imports)

- [ ] **Step 1: 更新 imports**

在 `src/commands.js` 第 3 行，將 import 改為：

```javascript
const {
  getTodayLogs, getWeeklyLogs, getAllMemberNames,
  getTaiwanDateString, getTaiwanTimeString,
  getMonthlyAnomalies, getTaiwanMonthString,
} = require('./sheets');
```

- [ ] **Step 2: 更新 detectCommand 加入月報**

找到 `detectCommand` 函式中：

```javascript
if (t === '週報')     return { type: 'weekly' };
```

改為：

```javascript
if (t === '週報')     return { type: 'weekly' };
if (t === '月報')     return { type: 'monthly' };
```

- [ ] **Step 3: 更新 handleCommand 加入月報處理**

找到：

```javascript
if (cmd.type === 'today')  return formatTodayStatus();
if (cmd.type === 'weekly') return formatWeeklyReport();
if (cmd.type === 'person') return formatPersonStatus(cmd.name);
```

改為：

```javascript
if (cmd.type === 'today')   return formatTodayStatus();
if (cmd.type === 'weekly')  return formatWeeklyReport();
if (cmd.type === 'monthly') return formatMonthlyReport();
if (cmd.type === 'person')  return formatPersonStatus(cmd.name);
```

- [ ] **Step 4: 新增 formatMonthlyReport 函式**

在 `formatWeeklyReport` 函式後插入：

```javascript
// ============================================================
// 月報：本月每人異常累計次數
// ============================================================

async function formatMonthlyReport() {
  const [allMembers] = await Promise.all([getAllMemberNames()]);
  const month = getTaiwanMonthString();
  const lines = [`📊 VLB設計部 ${month} 月度異常統計\n`];

  for (const name of allMembers) {
    const records = await getMonthlyAnomalies(month, name);
    // 排除請假類型，只計算實際異常
    const anomalies = records.filter(r => r[3] !== '病假' && r[3] !== '事假' && r[3] !== '休假' && r[3] !== '補休');
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
```

- [ ] **Step 5: 更新 HELP_TEXT 加入月報說明**

找到：

```javascript
週報　　　→ 本週每人工作摘要
```

改為：

```javascript
週報　　　→ 本週每人工作摘要
月報　　　→ 本月每人異常累計
```

- [ ] **Step 6: 確認語法正確**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && node -e "require('./src/commands.js'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/commands.js && git commit -m "feat: 新增月報指令，顯示本月異常累計"
```

---

## Task 6: 更新 analysis.js — 系統提示同步新工作類型

**Files:**
- Modify: `src/analysis.js:78-163` (buildSystemPrompt 的靜態說明文字)

- [ ] **Step 1: 更新課程日說明段落**

在 `analysis.js` 的 `buildSystemPrompt` 中，找到：

```javascript
【課程日特別說明】
課程日：
- 影片數量 0 支為完全正常，不標記異常
- 主要任務是課程拍攝與現場記錄，不需常規剪輯或輪播產出
- 不得因影片數量為 0 或無輪播記錄而標記
```

改為：

```javascript
【課程日特別說明】
課程日系列（課程日、課程日（拍攝組）、課程日（拍照組）、課程日（限動組）、課程日（行政支援））：
- 影片數量 0 支為完全正常，不標記異常
- 主要任務是課程拍攝、現場記錄、拍照、即時限動或行政支援
- 不得因影片數量為 0 或無輪播記錄而標記

大型活動日系列（大型活動日（短影音組）、大型活動日（限動組）、大型活動日（拍照修片組））：
- 大型活動日（短影音組）：1–2 支影片為正常標準
- 大型活動日（限動組）、大型活動日（拍照修片組）：影片數量 0 為正常，查核限動數量或照片產出
- 不得因影片數量為 0 而對限動組或拍照修片組標記異常
```

找到拍攝日說明，改為：

```javascript
【跟拍日特別說明】
跟拍日（舊稱拍攝日）：
- 當天主力為現場跟拍，影片由後製日產出
- 最低影片數 0–1 支，不得因影片數量低而標記異常
```

- [ ] **Step 2: 確認語法正確並清空 prompt 快取**

在 `analysis.js` 開頭的 `let _cachedSystemPrompt = null;` 行上方加入一行確認功能未受損：

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && node -e "require('./src/analysis.js'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git add src/analysis.js && git commit -m "feat: 系統提示同步新工作類型說明"
```

---

## Task 7: 跑完整測試 + 推送 GitHub

**Files:** 無程式碼修改，只跑測試

- [ ] **Step 1: 跑全部測試**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && npm test
```

Expected: PASS — 所有測試通過，無失敗

- [ ] **Step 2: 如果有失敗，排查**

常見問題：
- `isEditProgress` 未 export → 確認 lineHandler.js module.exports 包含它
- sheets.js mock 未包含 saveEditProgress → 在 lineHandler.test.js mock 中加入 `saveEditProgress: jest.fn().mockResolvedValue(undefined)`

- [ ] **Step 3: 確認 .env 設定（GROUP_NOTIFY_ENABLED）**

如需啟用群組推播，在 `.env` 加入：

```
GROUP_NOTIFY_ENABLED=true
```

注意：建議先在測試階段保持 `false`，確認彙整格式正確後再開啟。

- [ ] **Step 4: 推送 GitHub**

```bash
cd /Users/melodylai/Downloads/melody\ agent/vlb-line-bot && git push
```

---

## 自我審查

### Spec 覆蓋確認

| Spec 章節 | 對應 Task | 狀態 |
|-----------|----------|------|
| 一、團隊結構（帳號分配） | 僅文件，無程式碼需更新 | ✓ |
| 二、工作類型（新增 8 種） | Task 1, 2 | ✓ |
| 二、影片數量彈性計算 | 現有程式碼已實作 | ✓ |
| 三、全天靜默原則 | 現有程式碼已實作 | ✓ |
| 三、六種訊息識別 | Task 3（舊格式發布、剪輯進度） | ✓ |
| 四、請假記錄資料流 + Logger.log | 現有程式碼已有 console.log，符合需求 | ✓ |
| 五、異常判斷門檻 | 現有程式碼已實作 | ✓ |
| 六、週間排程（週日不執行） | Task 4 | ✓ |
| 七、22:30 彙整格式 | Task 4 | ✓ |
| 八、月度功能（月度異常附日期） | Task 4, 5 | ✓ |
| 九、影片與截圖查重 | 現有程式碼已實作 | ✓ |
| 十、發布工時自動換算 | 現有程式碼已實作 | ✓ |
| 十一、主管查詢指令（月報） | Task 5 | ✓ |
| 十二、技術規範 | 各 Task 遵循 | ✓ |

### Placeholder 掃描

無任何 TBD / TODO / 待補 字樣。所有 Step 皆有完整程式碼。

### 類型一致性

- `saveEditProgress` 在 sheets.js 定義並在 lineHandler.js 引用 ✓
- `isEditProgress` 在 lineHandler.js 定義並 export ✓
- `getTaiwanMonthString` 已在 sheets.js export，commands.js 引用 ✓
