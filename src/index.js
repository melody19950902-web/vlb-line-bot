'use strict';
require('dotenv').config();
const express = require('express');
const line    = require('@line/bot-sdk');
const { handleEvent } = require('./lineHandler');

// ============================================================
// 啟動前驗證必要環境變數
// ============================================================
const REQUIRED_ENV = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ 缺少必要環境變數：${key}，請檢查 .env 設定`);
    process.exit(1);
  }
}

// ============================================================
// LINE 設定與客戶端初始化
// ============================================================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};

// LINE Messaging API 客戶端（用於回覆與推播）
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ============================================================
// Express 伺服器設定
// ============================================================
const app  = express();
const PORT = process.env.PORT || 3000;

// LINE Webhook 端點
// line.middleware 負責驗證簽章（防止偽造請求）並解析 body
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    try {
      await Promise.all(req.body.events.map(event => handleEvent(event, client)));
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook 處理錯誤：', err);
      res.status(500).end();
    }
  }
);

// 健康檢查端點（Render.com 免費方案會定期 ping 防止休眠）
app.get('/', (req, res) => {
  res.send('✅ VLB LINE Bot 工作查核系統運行中');
});

app.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動，監聽連接埠 ${PORT}`);
  console.log(`🤖 VLB 設計部工作查核系統準備就緒`);
});
