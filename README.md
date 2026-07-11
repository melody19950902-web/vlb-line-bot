# VLB LINE Bot 工作查核系統

台灣美業設計部小編每日工作日誌回報與自動查核工具。
小編在 LINE 傳送工作日誌，系統自動判斷工作量是否合理，異常時通知主管。

---

## 部署前準備（一次性設定，約 30–45 分鐘）

### 步驟一：建立 LINE Bot

1. 前往 [LINE Developers Console](https://developers.line.biz/)
2. 登入 → 點選 **「Create a new provider」**
3. 建立 **Messaging API channel**
4. 進入 channel 頁面，記錄以下兩個值：
   - **Channel secret**（Basic settings 頁面）
   - **Channel access token**（Messaging API 頁面 → 點「Issue」產生）
5. 在 Messaging API 頁面：
   - 關閉「Auto-reply messages」
   - 關閉「Greeting messages」

---

### 步驟二：建立 Google Sheets 試算表

1. 前往 [Google Sheets](https://sheets.google.com) 新增一份空白試算表
2. 記錄網址中 `/d/` 後面那段文字（即 Spreadsheet ID），例如：
   ```
   https://docs.google.com/spreadsheets/d/【這段就是 ID】/edit
   ```
3. 依照下表建立 **5 個分頁**（在底部標籤按「+」新增）：

#### 分頁 1：`SOP設定`
| A（設定名稱） | B（值） |
|---|---|
| 設定名稱 | 值 |
| 最低工時_小時 | 6 |
| 空白時段上限_分 | 120 |

#### 分頁 2：`任務時間標準`
| A（任務關鍵字） | B（最短時間_分） | C（合理最長_分） | D（異常上限_分） |
|---|---|---|---|
| 任務關鍵字 | 最短時間_分 | 合理最長_分 | 異常上限_分 |
| 剪輯 | 60 | 90 | 120 |
| 發布影片 | 20 | 30 | 45 |
| 留言回覆 | 30 | 60 | 90 |
| Threads | 15 | 30 | 45 |
| 限時動態 | 20 | 40 | 60 |
| 輪播 | 30 | 90 | 150 |
| FAQ | 30 | 60 | 90 |
| 直播設備 | 30 | 60 | 90 |
| 直播剪輯 | 60 | 90 | 120 |
| waxTV | 60 | 120 | 180 |
| Podcast | 60 | 120 | 180 |
| 拍照 | 30 | 90 | 120 |
| Podcast錄製 | 60 | 120 | 150 |
| Podcast上稿 | 20 | 60 | 90 |
| Podcast設備 | 20 | 45 | 60 |
| 修Podcast照片 | 30 | 60 | 90 |
| 撰寫Podcast文案 | 60 | 90 | 120 |
| 撰寫修改輪播貼文 | 30 | 60 | 90 |
| 修改剪輯指令 | 15 | 30 | 45 |
| 生成文章重點 | 30 | 60 | 90 |
| 影片排程 | 15 | 30 | 45 |
| 試妝 | 30 | 60 | 90 |
| 巧睫新片素材 | 30 | 60 | 90 |

#### 分頁 3：`工作類型標準`
| A（工作類型） | B（最低影片數） |
|---|---|
| 工作類型 | 最低影片數 |
| 正常日 | 3 |
| 跟拍日 | 0 |
| 課程日 | 0 |
| 大型活動日（拍照組） | 0 |
| 大型活動日（限動組） | 0 |
| 大型活動日（剪輯組） | 1 |
| 拍攝日 | 1 |
| Podcast日 | 1 |
| 直播日 | 1 |
| 外拍半天 | 1 |
| 外拍一天 | 0 |

#### 分頁 4：`成員名單`
| A（姓名） | B（LINE_User_ID） |
|---|---|
| 姓名 | LINE_User_ID |
| 阿啾 | （部署後填入，見步驟七） |
| 小芯 | |
| 小柯 | |
| Fish | |
| 吻仔魚 | |
| +0 | |

#### 分頁 5：`工作記錄`
在 A1 填入以下標題（之後系統自動寫入）：
```
日期  時間  姓名  LINE_User_ID  工作類型  影片數量  時間記錄  狀態  異常說明  備註
```

---

### 步驟三：建立 Google 服務帳號

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案（或使用現有專案）
3. 左側選單 → **「API 和服務」→「啟用 API」**
   搜尋「Google Sheets API」→ 啟用
4. 左側選單 → **「API 和服務」→「憑證」**
5. 點「+ 建立憑證」→「服務帳號」
6. 填入名稱（例：`vlb-line-bot`）→ 建立完成
7. 點選剛建立的服務帳號 → 「金鑰」頁籤 → 「新增金鑰」→ 「建立新金鑰」→ **JSON 格式** → 下載
8. 回到 Google Sheets，點右上角「共用」，輸入服務帳號的 email（格式如 `vlb-line-bot@xxx.iam.gserviceaccount.com`），給予**編輯者**權限

---

### 步驟四：準備 Gmail 應用程式密碼

> 如不需要 Email 通知，可跳過此步驟（系統仍會透過 LINE 推播通知主管）

1. 登入 Gmail 帳號 → 右上角頭像 → 「管理 Google 帳戶」
2. 搜尋「應用程式密碼」
3. 選擇「郵件」與「Mac（或其他裝置）」→ 產生
4. 記錄產生的 16 碼密碼（格式：`xxxx xxxx xxxx xxxx`，去掉空格）

---

### 步驟五：部署到 Render.com

1. 前往 [Render.com](https://render.com/) 註冊帳號
2. 點「New +」→「Web Service」
3. 選擇「Deploy from a Git repository」→ 連結你的 GitHub（需先把專案上傳 GitHub）
   - 或選「Deploy from local directory」手動上傳
4. 設定如下：
   - **Name**：`vlb-line-bot`
   - **Runtime**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Plan**：Free
5. 點「Advanced」→「Add Environment Variable」，逐一填入下方所有環境變數
6. 點「Create Web Service」開始部署
7. 部署完成後，記錄你的網址，格式為：
   ```
   https://vlb-line-bot.onrender.com
   ```

---

### 步驟六：填入 LINE Webhook URL

1. 回到 LINE Developers Console
2. 進入你的 Messaging API channel
3. Webhook URL 填入：
   ```
   https://你的Render網址/webhook
   ```
4. 點「Verify」確認成功（會顯示 200 OK）
5. 開啟「Use webhook」開關

---

### 步驟七：取得主管與小編的 LINE User ID

1. 將 Bot 加為好友（掃描 channel 頁面的 QR Code）
2. 傳任意訊息給 Bot
3. 到 Render.com 的 Logs 頁面查看，會出現類似：
   ```
   userId: U1a2b3c4d5e6f...
   ```
4. 將此 ID 填入：
   - `ADMIN_LINE_USER_ID` 環境變數（主管 ID）
   - Google Sheets 「成員名單」的 LINE_User_ID 欄（各小編 ID）
5. 每位小編都需要先傳訊息給 Bot 才能取得 ID

---

## 環境變數清單

在 Render.com 的環境變數設定頁面填入以下所有值：

| 環境變數名稱 | 說明 | 取得位置 |
|---|---|---|
| `LINE_CHANNEL_SECRET` | LINE Bot 密鑰 | LINE Developers Console → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot 存取金鑰 | LINE Developers Console → Messaging API |
| `ADMIN_LINE_USER_ID` | 主管的 LINE User ID | 步驟七 |
| `ANTHROPIC_API_KEY` | Claude API 金鑰 | console.anthropic.com |
| `NOTIFY_EMAIL` | 接收警報的 Email | 你的信箱 |
| `GMAIL_USER` | 寄送警報的 Gmail 帳號 | 你的 Gmail |
| `GMAIL_APP_PASSWORD` | Gmail 應用程式密碼（16碼） | 步驟四 |
| `GOOGLE_SHEETS_ID` | Google Sheets 試算表 ID | 步驟二 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 服務帳號金鑰 JSON（全文單行） | 步驟三下載的 JSON 檔案內容 |
| `LINE_GROUP_ID` | 群組推播用的群組 ID（選填；在群組輸入「群組ID」取得） | 群組內指令 |
| `GROUP_NOTIFY_ENABLED` | 設 `true` 才會推播到群組，預設只推主管（選填） | 手動設定 |

> **GOOGLE_SERVICE_ACCOUNT_JSON 填法**：
> 用文字編輯器開啟下載的 JSON 檔，全選複製，貼入環境變數值欄位。
> 注意私鑰中的換行需為 `\n`（JSON 格式正確的話應已包含）。

---

## 使用說明

### 小編每日回報格式

在 LINE 與 Bot 的對話中，按以下格式傳送：

```
今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 剪輯短影音
10:30-11:00 發布影片含所有平台
11:00-11:30 Threads 發布
12:00-13:00 午休
13:00-14:30 剪輯短影音
14:30-15:30 留言回覆
備註：今天新增了兩篇貼文
```

**工作類型選項：**
- `正常日`
- `跟拍日`
- `課程日`
- `大型活動日（拍照組）`
- `大型活動日（限動組）`
- `大型活動日（剪輯組）`
- `Podcast日`
- `直播日`
- `外拍半天`
- `外拍一天`

### 小編請假 / 補休格式

**當天可請（臨時狀況）：**
```
今日病假
今日事假
```

**前一天預告（明日，計畫性請假一律前一天）：**
```
明日事假
明日特休
明日休假
```

**補休：**
```
明日補休
明日補休半天
明日早上補休半天
明日下午補休半天
明日補休 X 小時
```

**取消（改期或改假別皆先取消再重傳）：**
```
取消今日請假 / 取消今日病假 / 取消今日事假
取消明日請假 / 取消明日特休 / 取消明日補休 …
```

> 特休、事假、休假請一律前一天以「明日…」預告；病假可當天（今日病假）；臨時事假可當天（今日事假）。「明天／明日」兩種講法都接受。

### 主管查詢指令

| 指令 | 說明 |
|---|---|
| `今日狀況` | 顯示所有小編今日回報狀態 |
| `週報` | 顯示本週每人工作摘要 |
| `@小芯 狀況` | 查詢特定小編本週記錄 |
| `說明` | 顯示所有指令與格式 |

---

## 常見問題

**Q：Webhook Verify 失敗？**
A：確認 Render.com 已部署成功（服務狀態為 Live）、Webhook URL 末尾有 `/webhook`。

**Q：Bot 不回覆？**
A：檢查 Render.com Logs 是否有錯誤訊息；確認環境變數 `LINE_CHANNEL_ACCESS_TOKEN` 已填入。

**Q：Google Sheets 沒有記錄？**
A：確認服務帳號 email 已加為試算表的「編輯者」；確認 `GOOGLE_SHEETS_ID` 正確。

**Q：Render.com 免費方案會休眠怎麼辦？**
A：免費方案閒置 15 分鐘後會休眠，第一次訊息會慢一點。
可用 [UptimeRobot](https://uptimerobot.com/) 免費方案每 5 分鐘 ping 一次健康檢查網址（`https://你的網址/`）來保持喚醒。

**Q：如何調整 SOP 規則（例如改最低影片數）？**
A：直接修改 Google Sheets「SOP設定」或「工作類型標準」分頁的數值，系統 10 分鐘內自動更新，不需重新部署。
