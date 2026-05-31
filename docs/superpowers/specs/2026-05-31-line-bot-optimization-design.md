# VLB LINE Bot 工作流程優化設計文件

**日期：** 2026-05-31  
**範圍：** 準確性修正 + 可靠性提升 + 功能補齊 + 程式碼重構 + 測試覆蓋  
**方向：** 先補測試鎖住現有行為，再修 bug，再重構架構

---

## 已知問題清單

| # | 檔案 | 問題 | 嚴重度 |
|---|------|------|--------|
| 1 | lineHandler.js | 「今日病假」「今日事假」未處理，傳了沒反應 | 高 |
| 2 | analyzer.js | detectSpecialDayType 回傳「課程拍攝 3 小時」不在 VALID_DAY_TYPES，notifier 顯示異常 | 中 |
| 3 | analyzer.js | buildSystemPrompt 每次分析都重讀 Sheets（6 人 × 3 API = 18 次）| 中 |
| 4 | analyzer.js | parseWorkLog 備註 regex 只抓一行，多行備註被截斷 | 低 |
| 5 | notifier.js | 22:30 分析失敗時靜默，pending 記錄永遠不更新 | 高 |
| 6 | notifier.js | 月度異常記錄逐筆 await，N 筆異常串行執行很慢 | 低 |

---

## 架構設計

### 現況
```
src/analyzer.js   ← 494 行，混合：解析 + 分析 + Claude API + 備援 + 工具函數
```

### 目標
```
src/parser.js     ← 純文字解析（parseWorkLog, detectSpecialDayType, 時間工具）
src/analysis.js   ← 純分析（analyzeWorkLog, buildSystemPrompt, 備援邏輯）
src/analyzer.js   ← 刪除（調用方改為直接 import parser / analysis）
```

**原則：**
- `parser.js` 零外部依賴（no Sheets, no Claude API），所有函數為純函數
- `analysis.js` 依賴 Sheets（讀 SOP 設定）和 Anthropic SDK
- Claude 系統提示快取：同一程序生命週期內只讀一次 Sheets

---

## Bug 修復規格

### Bug 1：今日病假 / 今日事假

**位置：** `src/lineHandler.js` → `parseLeaveRequest()`

**修法：** 新增以下 pattern，`isToday: true`

```
今日病假  → { leaveType: '病假', isToday: true }
今日事假  → { leaveType: '事假', isToday: true }
今日請假  → { leaveType: '請假', isToday: true }
```

`processLeaveRequest` 已有 `isToday` 判斷，寫入當天日期，無需額外修改。

---

### Bug 2：detectSpecialDayType 回傳格式

**位置：** `src/analyzer.js` → `detectSpecialDayType()`

**問題：** 回傳 `{ dayType: '課程拍攝 3 小時' }` 不在 VALID_DAY_TYPES，但 `processSpecialDayLog` 直接 `status: 'normal'` 存入 Sheets。22:30 彙整顯示時 `isSpecialDay` regex 能匹配，顯示不影響。

**實際影響：** 僅影響 Sheets 資料的 dayType 欄位格式不一致，無功能性 bug。

**修法：** `detectSpecialDayType` 回傳標準 dayType（如 `課程日`）＋ `displayLabel`（如 `課程拍攝 3 小時`），Sheets 存 dayType，LINE 顯示用 displayLabel。

---

### Bug 3：系統提示快取

**位置：** `src/analysis.js`（重構後）

**修法：** 模組層級快取變數

```js
let _cachedSystemPrompt = null;

async function getSystemPrompt() {
  if (!_cachedSystemPrompt) {
    _cachedSystemPrompt = await buildSystemPrompt();
  }
  return _cachedSystemPrompt;
}
```

---

### Bug 4：備註多行截斷

**位置：** `src/parser.js`（重構後）→ `parseWorkLog()`

**現況：** `/備註:\s*(.+)/` 的 `.+` 不跨行  
**修法：** `/備註:\s*([\s\S]+?)(?:\n\n|$)/` 或讀到字串結尾

---

### Bug 5：22:30 分析失敗靜默

**位置：** `src/notifier.js` → `sendDailySummary()` 內的 pending 重分析迴圈

**修法：**
- catch 區塊：將該筆記錄 status 從 `pending` 更新為 `warning`，anomalies 加入 `分析失敗，請人工確認`
- 確保 `latestByName` 的該條目同步更新，讓 22:30 彙整顯示 `⚠️ 分析失敗` 而非遺漏

---

### Bug 6：月度記錄並行化

**位置：** `src/notifier.js` → `sendDailySummary()` 底部

**修法：**
```js
await Promise.all(
  monthlyToRecord.map(async ({ name, anomalyType }) => {
    await saveMonthlyRecord({ month, name, date: today, anomalyType });
    const records = await getMonthlyAnomalies(month, name);
    if (records.length >= 4) await notifyAdminLine(client, alertMsg);
  })
);
```

---

## 測試計畫

**框架：** Jest  
**位置：** `tests/`

### tests/parser.test.js

| 測試案例 | 輸入 | 預期輸出 |
|---------|------|---------|
| 標準日誌解析 | 完整格式 | dayType, videoCount, timeEntries 正確 |
| 時間記錄選填 | 無時間記錄 | 不報錯，timeEntries = [] |
| 單位數小時補正 | `1:00-2:30` | 解析為 13:00-14:30 |
| 備註多行 | 多行備註 | 完整擷取 |
| 無效 dayType | 今日類型：怪類型 | error 訊息 |
| 影片數量缺失 | 無影片數量行 | error 訊息 |
| 批量剪輯抓支數 | 「剪片 3 支」 | batchCount = 3 |
| detectSpecialDayType 外拍 | `外拍半天` | dayType: '外拍半天' |
| detectSpecialDayType 課程 | `課程拍攝 3 小時` | dayType: '課程日' |

### tests/lineHandler.test.js

| 測試案例 | 輸入 | 預期輸出 |
|---------|------|---------|
| isWorkLog 正常 | 含今日類型+影片數量 | true |
| isWorkLog 缺欄位 | 只有今日類型 | false |
| isPublishReport | `已發布｜IG｜薇安` | true |
| parseLeaveRequest 明天請假 | `明天請假` | leaveType:'請假', isToday:false |
| parseLeaveRequest 今日病假（新） | `今日病假` | leaveType:'病假', isToday:true |
| parseLeaveRequest 今日事假（新） | `今日事假` | leaveType:'事假', isToday:true |
| parseLeaveRequest 補休時數 | `明天補休 2 小時` | hours:2 |
| 無法識別訊息 | `隨便文字` | null |

### tests/analysis.test.js

| 測試案例 | 輸入 | 預期輸出 |
|---------|------|---------|
| 批量正常（≤120分/支） | 3支/240分 | 無異常 |
| 批量超時（>120分/支） | 2支/360分 | 加入異常 |
| Claude 誤加批量異常被移除 | batchOk + Claude 誤判 | 異常被清除 |
| localFallback 課程日 | dayType:課程日, 0支 | status:normal |
| localFallback 正常日0支無備註 | | status:alert |
| localFallback 工時不足 | 4小時 | 時數未達標準 |

---

## 實作順序

1. 安裝 Jest，建立 `tests/` 結構，寫測試（Phase 1）
2. 修 Bug 1（今日病假）→ 跑測試驗證
3. 修 Bug 4（備註多行）→ 跑測試驗證
4. 修 Bug 5（22:30 靜默失敗）
5. 修 Bug 6（月度並行）
6. 修 Bug 3（系統提示快取）
7. 重構 analyzer.js → parser.js + analysis.js（Phase 3）
8. 修 Bug 2（detectSpecialDayType 格式統一）
9. 全部測試通過 → 推上 GitHub
