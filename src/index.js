'use strict';
require('dotenv').config();
const express = require('express');
const line    = require('@line/bot-sdk');
const { handleEvent } = require('./lineHandler');
const { sendDailySummary } = require('./notifier');
const { getTaiwanTimeString } = require('./sheets');

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
// LINE 客戶端
// ============================================================
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ============================================================
// Express 伺服器
// ============================================================
const app  = express();
const PORT = process.env.PORT || 3000;

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

app.get('/', (req, res) => {
  res.send('✅ VLB LINE Bot 工作查核系統運行中');
});

app.listen(PORT, () => {
  console.log(`✅ 伺服器已啟動，監聽連接埠 ${PORT}`);
  console.log(`🤖 VLB 設計部工作查核系統準備就緒`);
});

// ============================================================
// 每日 22:30 彙整排程（台灣時間）
// 每 60 秒檢查一次，同一天只發一次
// ============================================================
let lastSummaryDate = '';

setInterval(async () => {
  try {
    const now = getTaiwanTimeString();    // "HH:MM"
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });

    if (now >= '22:30' && lastSummaryDate !== today) {
      lastSummaryDate = today;
      console.log(`📊 發送每日彙整：${today}`);
      await sendDailySummary(client);
    }
  } catch (err) {
    console.error('每日彙整發送失敗：', err.message);
  }
}, 60 * 1000);
