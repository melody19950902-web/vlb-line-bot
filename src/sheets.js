'use strict';
require('dotenv').config();
const { google } = require('googleapis');

// ============================================================
// 快取設定（避免頻繁呼叫 Sheets API，設定 10 分鐘有效期）
// ============================================================
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = {
  sopSettings:      { data: null, at: 0 },
  taskTimeRules:    { data: null, at: 0 },
  dayTypeRules:     { data: null, at: 0 },
};

// ============================================================
// 預設值（Sheets 無法連線時的備援資料）
// ============================================================

const DEFAULT_SOP_SETTINGS = {
  '正常日最低影片數': '3',
  '最低工時_小時':    '6',
  '空白時段上限_分':  '60',
};

const DEFAULT_TASK_TIME_RULES = [
  { 任務關鍵字: '剪輯',    最短時間_分: 60, 合理最長_分: 90,  異常上限_分: 120 },
  { 任務關鍵字: '發布影片', 最短時間_分: 20, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '留言回覆', 最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: 'Threads', 最短時間_分: 15, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '限時動態', 最短時間_分: 20, 合理最長_分: 40,  異常上限_分: 60  },
  { 任務關鍵字: '直播設備', 最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '直播剪輯', 最短時間_分: 60, 合理最長_分: 90,  異常上限_分: 120 },
  { 任務關鍵字: 'waxTV',   最短時間_分: 60, 合理最長_分: 120, 異常上限_分: 180 },
  { 任務關鍵字: 'Podcast', 最短時間_分: 60, 合理最長_分: 120, 異常上限_分: 180 },
  { 任務關鍵字: '輪播圖',  最短時間_分: 45, 合理最長_分: 90,  異常上限_分: 120 },
];

const DEFAULT_DAY_TYPE_RULES = [
  { 工作類型: '正常日',              最低影片數: 3 },
  { 工作類型: '外拍日',              最低影片數: 1 },
  { 工作類型: '直播日',              最低影片數: 2 },
  { 工作類型: '大型活動日（拍照組）', 最低影片數: 0 },
  { 工作類型: '大型活動日（限動組）', 最低影片數: 0 },
  { 工作類型: '大型活動日（剪輯組）', 最低影片數: 1 },
];

// 全部小編名單（用於今日狀況顯示，實際 LINE ID 請填入成員名單分頁）
const DEFAULT_MEMBERS = ['阿啾', '小芯', '小柯', 'Fish', '吻仔魚', '+0'];

// ============================================================
// Google Sheets 認證與基本操作
// ============================================================

// 取得已認證的 Sheets 客戶端
async function getSheets() {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (err) {
    console.error('Google Sheets 認證失敗：', err.message);
    return null;
  }
}

// 讀取試算表指定範圍
async function readRange(range) {
  const sheets = await getSheets();
  if (!sheets) return null;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range,
    });
    return res.data.values || [];
  } catch (err) {
    console.error(`讀取範圍 ${range} 失敗：`, err.message);
    return null;
  }
}

// 追加一列資料到指定分頁
async function appendRow(sheetName, values) {
  const sheets = await getSheets();
  if (!sheets) return false;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
    return true;
  } catch (err) {
    console.error(`寫入 ${sheetName} 失敗：`, err.message);
    return false;
  }
}

// ============================================================
// SOP 規則讀取（含快取）
// ============================================================

// 取得 SOP 基本設定（key-value 格式）
// Sheets 分頁：SOP設定（欄位：設定名稱 | 值）
async function getSopSettings() {
  const now = Date.now();
  if (cache.sopSettings.data && now - cache.sopSettings.at < CACHE_TTL_MS) {
    return cache.sopSettings.data;
  }

  const rows = await readRange('SOP設定!A:B');
  if (!rows || rows.length < 2) {
    console.warn('SOP設定讀取失敗，使用預設值');
    return DEFAULT_SOP_SETTINGS;
  }

  const settings = {};
  for (const row of rows.slice(1)) {
    if (row[0] && row[1] !== undefined) settings[row[0].trim()] = row[1].trim();
  }

  const result = Object.keys(settings).length > 0 ? settings : DEFAULT_SOP_SETTINGS;
  cache.sopSettings = { data: result, at: now };
  return result;
}

// 取得各任務時間標準
// Sheets 分頁：任務時間標準（欄位：任務關鍵字 | 最短時間_分 | 合理最長_分 | 異常上限_分）
async function getTaskTimeRules() {
  const now = Date.now();
  if (cache.taskTimeRules.data && now - cache.taskTimeRules.at < CACHE_TTL_MS) {
    return cache.taskTimeRules.data;
  }

  const rows = await readRange('任務時間標準!A:D');
  if (!rows || rows.length < 2) {
    console.warn('任務時間標準讀取失敗，使用預設值');
    return DEFAULT_TASK_TIME_RULES;
  }

  const rules = rows.slice(1)
    .filter(row => row[0])
    .map(row => ({
      任務關鍵字: row[0].trim(),
      最短時間_分: parseInt(row[1]) || 0,
      合理最長_分: parseInt(row[2]) || 0,
      異常上限_分: parseInt(row[3]) || 0,
    }));

  const result = rules.length > 0 ? rules : DEFAULT_TASK_TIME_RULES;
  cache.taskTimeRules = { data: result, at: now };
  return result;
}

// 取得各工作類型的最低影片數標準
// Sheets 分頁：工作類型標準（欄位：工作類型 | 最低影片數）
async function getDayTypeRules() {
  const now = Date.now();
  if (cache.dayTypeRules.data && now - cache.dayTypeRules.at < CACHE_TTL_MS) {
    return cache.dayTypeRules.data;
  }

  const rows = await readRange('工作類型標準!A:B');
  if (!rows || rows.length < 2) {
    console.warn('工作類型標準讀取失敗，使用預設值');
    return DEFAULT_DAY_TYPE_RULES;
  }

  const rules = rows.slice(1)
    .filter(row => row[0])
    .map(row => ({
      工作類型:   row[0].trim(),
      最低影片數: parseInt(row[1]) || 0,
    }));

  const result = rules.length > 0 ? rules : DEFAULT_DAY_TYPE_RULES;
  cache.dayTypeRules = { data: result, at: now };
  return result;
}

// ============================================================
// 成員名單
// ============================================================

// 依 LINE User ID 查詢小編姓名
// Sheets 分頁：成員名單（欄位：姓名 | LINE_User_ID）
async function getMemberName(lineUserId) {
  if (!lineUserId) return null;
  const rows = await readRange('成員名單!A:B');
  if (!rows) return null;
  for (const row of rows.slice(1)) {
    if (row[1] && row[1].trim() === lineUserId) return row[0].trim();
  }
  return null;
}

// 取得所有小編姓名清單（用於今日狀況顯示）
async function getAllMemberNames() {
  const rows = await readRange('成員名單!A:B');
  if (!rows || rows.length < 2) return DEFAULT_MEMBERS;
  const names = rows.slice(1).map(row => row[0]?.trim()).filter(Boolean);
  return names.length > 0 ? names : DEFAULT_MEMBERS;
}

// ============================================================
// 工作記錄讀寫
// ============================================================

// 儲存一筆工作日誌到「工作記錄」分頁
// 欄位順序：日期 | 時間 | 姓名 | LINE_User_ID | 工作類型 | 影片數量 | 時間記錄 | 狀態 | 異常說明 | 備註
async function saveWorkLog({ date, time, name, lineUserId, dayType, videoCount, timeLog, status, anomalies, notes }) {
  const anomalyText = Array.isArray(anomalies) ? anomalies.join('；') : (anomalies || '');
  return appendRow('工作記錄', [
    date,
    time,
    name,
    lineUserId,
    dayType,
    String(videoCount),
    timeLog,
    status,
    anomalyText,
    notes || '',
  ]);
}

// 取得今日所有工作日誌（用於主管查詢「今日狀況」）
async function getTodayLogs() {
  const rows = await readRange('工作記錄!A:J');
  if (!rows || rows.length < 2) return [];
  const today = getTaiwanDateString();
  return rows.slice(1).filter(row => row[0] === today);
}

// 取得本週工作日誌，可依姓名過濾（用於「週報」與「@姓名 狀況」）
async function getWeeklyLogs(memberName = null) {
  const rows = await readRange('工作記錄!A:J');
  if (!rows || rows.length < 2) return [];

  const { start, end } = getThisWeekRange();
  return rows.slice(1).filter(row => {
    if (!row[0]) return false;
    const inRange = row[0] >= start && row[0] <= end;
    if (!inRange) return false;
    return memberName ? row[2] === memberName : true;
  });
}

// ============================================================
// 日期工具函數
// ============================================================

// 取得台灣時間今日日期字串（格式：YYYY/MM/DD）
function getTaiwanDateString(date = new Date()) {
  return date.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// 取得台灣時間現在時刻字串（格式：HH:MM）
function getTaiwanTimeString(date = new Date()) {
  return date.toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 取得本週（週一到週日）的日期範圍字串
function getThisWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=週日
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const diffToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;

  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);

  const sunday = new Date(now);
  sunday.setDate(now.getDate() + diffToSunday);

  return {
    start: getTaiwanDateString(monday),
    end:   getTaiwanDateString(sunday),
  };
}

module.exports = {
  getSopSettings,
  getTaskTimeRules,
  getDayTypeRules,
  getMemberName,
  getAllMemberNames,
  saveWorkLog,
  getTodayLogs,
  getWeeklyLogs,
  getTaiwanDateString,
  getTaiwanTimeString,
  DEFAULT_MEMBERS,
};
