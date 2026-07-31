'use strict';
require('dotenv').config();
const { google } = require('googleapis');

// ============================================================
// 快取設定（10 分鐘有效期）
// ============================================================
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = {
  sopSettings:   { data: null, at: 0 },
  taskTimeRules: { data: null, at: 0 },
  dayTypeRules:  { data: null, at: 0 },
};

// ============================================================
// 預設值（Sheets 無法連線時的備援資料）
// ============================================================

const DEFAULT_SOP_SETTINGS = {
  '最低工時_小時':   '6',
  '空白時段上限_分': '120',
  '每週最低影片數':  '12',
  '每週最低輪播數':  '6',
};

const DEFAULT_TASK_TIME_RULES = [
  { 任務關鍵字: '剪輯',             最短時間_分: 60, 合理最長_分: 90,  異常上限_分: 120 },
  { 任務關鍵字: '發布影片',          最短時間_分: 20, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '留言回覆',          最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: 'Threads',          最短時間_分: 15, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '限時動態',          最短時間_分: 20, 合理最長_分: 40,  異常上限_分: 60  },
  { 任務關鍵字: '輪播',             最短時間_分: 30, 合理最長_分: 90,  異常上限_分: 150 },
  { 任務關鍵字: 'FAQ',              最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '直播設備',          最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '直播剪輯',          最短時間_分: 60, 合理最長_分: 90,  異常上限_分: 120 },
  { 任務關鍵字: 'waxTV',           最短時間_分: 60, 合理最長_分: 120, 異常上限_分: 180 },
  { 任務關鍵字: 'Podcast',          最短時間_分: 60, 合理最長_分: 120, 異常上限_分: 180 },
  { 任務關鍵字: '拍照',             最短時間_分: 30, 合理最長_分: 90,  異常上限_分: 120 },
  // 新增項目（依實際截圖盤點）
  { 任務關鍵字: 'Podcast錄製',       最短時間_分: 60, 合理最長_分: 120, 異常上限_分: 150 },
  { 任務關鍵字: 'Podcast上稿',       最短時間_分: 20, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: 'Podcast設備',       最短時間_分: 20, 合理最長_分: 45,  異常上限_分: 60  },
  { 任務關鍵字: '修Podcast照片',     最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '撰寫Podcast文案',   最短時間_分: 60, 合理最長_分: 90,  異常上限_分: 120 },
  { 任務關鍵字: '撰寫修改輪播貼文',   最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '修改剪輯指令',      最短時間_分: 15, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '生成文章重點',      最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '影片排程',          最短時間_分: 15, 合理最長_分: 30,  異常上限_分: 45  },
  { 任務關鍵字: '試妝',             最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
  { 任務關鍵字: '巧睫新片素材',      最短時間_分: 30, 合理最長_分: 60,  異常上限_分: 90  },
];

const DEFAULT_DAY_TYPE_RULES = [
  // 正式 11 列
  { 工作類型: '正常日',               最低影片數: 3 },
  { 工作類型: '跟拍日',               最低影片數: 0 },
  { 工作類型: '課程日',               最低影片數: 0 },
  { 工作類型: '大型活動日（拍照組）', 最低影片數: 0 },
  { 工作類型: '大型活動日（限動組）', 最低影片數: 0 },
  { 工作類型: '大型活動日（剪輯組）', 最低影片數: 1 },
  { 工作類型: '拍攝日',               最低影片數: 1 },
  { 工作類型: 'Podcast日',            最低影片數: 1 },
  { 工作類型: '直播日',               最低影片數: 1 },
  { 工作類型: '外拍半天',             最低影片數: 1 },
  { 工作類型: '外拍一天',             最低影片數: 0 },
  // 未分組大型活動日 fallback（用戶未指定角色組時）
  { 工作類型: '大型活動日',           最低影片數: 1 },
];

const DEFAULT_MEMBERS = ['阿啾', '小芯', '小柯', '吻仔魚', '佳玲'];

// ============================================================
// Google Sheets 認證與基本操作
// ============================================================

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

async function getMemberName(lineUserId) {
  if (!lineUserId) return null;
  const rows = await readRange('成員名單!A:B');
  if (!rows) return null;
  for (const row of rows.slice(1)) {
    if (row[1] && row[1].trim() === lineUserId) return row[0].trim();
  }
  return null;
}

async function getAllMemberNames() {
  const rows = await readRange('成員名單!A:B');
  if (!rows || rows.length < 2) return DEFAULT_MEMBERS;
  const names = rows.slice(1).map(row => row[0]?.trim()).filter(Boolean);
  return names.length > 0 ? names : DEFAULT_MEMBERS;
}

// 完整成員資料（姓名 + LINE_User_ID），供以 ID 為主鍵的比對使用
async function getAllMembers() {
  const rows = await readRange('成員名單!A:B');
  if (!rows || rows.length < 2) return DEFAULT_MEMBERS.map(name => ({ name, id: '' }));
  return rows.slice(1)
    .map(row => ({ name: (row[0] || '').trim(), id: (row[1] || '').trim() }))
    .filter(m => m.name);
}

// ============================================================
// 工作記錄讀寫
// 欄位：日期 | 時間 | 姓名 | LINE_User_ID | 工作類型 | 影片數量 | 時間記錄 | 狀態 | 異常說明 | 備註
// ============================================================

async function saveWorkLog({ date, time, name, lineUserId, dayType, videoCount, timeLog, status, anomalies, notes, carouselCount }) {
  const anomalyText = Array.isArray(anomalies) ? anomalies.join('；') : (anomalies || '');
  return appendRow('工作記錄', [
    date, time, name, lineUserId, dayType,
    String(videoCount), timeLog, status, anomalyText, notes || '',
    String(carouselCount != null ? carouselCount : 0),
  ]);
}

async function getTodayLogs() {
  const rows = await readRange('工作記錄!A:K');
  if (!rows || rows.length < 2) return [];
  const today = getTaiwanDateString();
  return rows.slice(1).filter(row => row[0] === today);
}

async function getWeeklyLogs(memberName = null) {
  const rows = await readRange('工作記錄!A:K');
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
// 請假記錄讀寫
// 欄位：請假日期 | 提交時間 | 姓名 | LINE_User_ID | 類型 | 時數
// ============================================================

// 儲存請假/補休記錄
async function saveLeaveRecord({ leaveDate, submitTime, name, lineUserId, leaveType, hours }) {
  return appendRow('請假記錄', [
    leaveDate, submitTime, name, lineUserId, leaveType, hours ? String(hours) : '',
  ]);
}

// ============================================================
// 發布回報讀寫（來自單獨傳入的「已發布｜平台｜帳號」訊息）
// 欄位：日期 | 時間 | 姓名 | LINE_User_ID | 原始文字
// ============================================================

async function savePublishReport({ date, time, name, lineUserId, rawText }) {
  return appendRow('發布記錄', [date, time, name, lineUserId, rawText]);
}

// 回傳今日發布回報，Map<姓名, string[]>
async function getTodayPublishReports() {
  const rows = await readRange('發布記錄!A:E');
  if (!rows || rows.length < 2) return new Map();
  const today = getTaiwanDateString();
  const byName = new Map();
  for (const row of rows.slice(1)) {
    if (row[0] !== today || !row[2]) continue;
    const name = row[2];
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row[4] || '');
  }
  return byName;
}

// 取得指定日期的請假名單
async function getLeaveRecordsForDate(dateStr) {
  const rows = await readRange('請假記錄!A:F');
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).filter(row => row[0] === dateStr);
}

// 本週（週一~週日）的請假記錄
async function getLeaveRecordsThisWeek() {
  const rows = await readRange('請假記錄!A:F');
  if (!rows || rows.length < 2) return [];
  const { start, end } = getThisWeekRange();
  return rows.slice(1).filter(r => r[0] && r[0] >= start && r[0] <= end);
}

// 指定月份（YYYY/MM）的請假記錄
async function getLeaveRecordsForMonth(monthStr) {
  const rows = await readRange('請假記錄!A:F');
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).filter(r => r[0] && r[0].startsWith(monthStr));
}

// 查某人在某日是否已有請假記錄（用於重複偵測）
async function getLeaveRecordForUserOnDate(lineUserId, dateStr) {
  const rows = await readRange('請假記錄!A:F');
  if (!rows || rows.length < 2) return null;
  const found = rows.slice(1).find(r => r[0] === dateStr && r[3] === lineUserId);
  if (!found) return null;
  return {
    leaveDate: found[0], submitTime: found[1], name: found[2],
    lineUserId: found[3], leaveType: found[4] || '', hours: found[5] || '',
  };
}

// 取得分頁的 numeric sheetId（刪除列時需要）
async function getSheetIdByTitle(title) {
  const sheets = await getSheets();
  if (!sheets) return null;
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      fields: 'sheets.properties(sheetId,title)',
    });
    const s = (res.data.sheets || []).find(x => x.properties.title === title);
    return s ? s.properties.sheetId : null;
  } catch (err) {
    console.error('取得分頁 ID 失敗：', err.message);
    return null;
  }
}

// 刪除某人某日的請假記錄；回傳被刪的記錄物件，或 null（找不到/失敗）
async function deleteLeaveRecordForUserOnDate(lineUserId, dateStr) {
  const sheets = await getSheets();
  if (!sheets) return null;
  const rows = await readRange('請假記錄!A:F');
  if (!rows || rows.length < 2) return null;
  let idx = -1;                                  // rows 陣列索引 = 試算表 0-based 列索引
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === dateStr && rows[i][3] === lineUserId) { idx = i; break; }
  }
  if (idx === -1) return null;
  const removed = {
    leaveDate: rows[idx][0], submitTime: rows[idx][1], name: rows[idx][2],
    lineUserId: rows[idx][3], leaveType: rows[idx][4] || '', hours: rows[idx][5] || '',
  };
  const sheetId = await getSheetIdByTitle('請假記錄');
  if (sheetId == null) return null;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
      } }] },
    });
    return removed;
  } catch (err) {
    console.error('刪除請假記錄失敗：', err.message);
    return null;
  }
}

// ============================================================
// 月度異常記錄
// 欄位：月份 | 小編名稱 | 異常日期 | 異常類型
// ============================================================

async function saveMonthlyRecord({ month, name, date, anomalyType }) {
  const rows = await readRange('月度記錄!A:D');
  if (rows && rows.length > 1) {
    const dup = rows.slice(1).some(r =>
      r[0] === month && r[1] === name && r[2] === date && r[3] === anomalyType);
    if (dup) return true;
  }
  return appendRow('月度記錄', [month, name, date, anomalyType]);
}

// 取得指定月份的異常記錄（可依姓名過濾）
async function getMonthlyAnomalies(month, name = null) {
  const rows = await readRange('月度記錄!A:D');
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).filter(r =>
    r[0] === month && (name ? r[1] === name : true)
  );
}

// 台灣時間當月字串，格式 YYYY/MM
function getTaiwanMonthString(date = new Date()) {
  return getTaiwanDateString(date).substring(0, 7);
}

// ============================================================
// 日期工具函數
// ============================================================

function getTaiwanDateString(date = new Date()) {
  return date.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function getTaiwanTimeString(date = new Date()) {
  return date.toLocaleTimeString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getThisWeekRange() {
  const now = new Date();
  const taiwanNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dayOfWeek = taiwanNow.getDay();
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

// ============================================================
// 剪輯進度記錄
// 欄位：日期 | 時間 | 姓名 | LINE_User_ID | 影片標題 | 狀態
// ============================================================

async function saveEditProgress({ date, time, name, lineUserId, title, status }) {
  return appendRow('剪輯進度', [date, time, name, lineUserId, title, status]);
}

// ============================================================
// 內容指紋（查重）
// 欄位：日期 | 姓名 | 類型 | 雜湊 | 雲端連結
// ============================================================

async function saveFingerprint({ date, name, fileType, hash, driveLink }) {
  return appendRow('內容指紋', [date, name, fileType, hash, driveLink || '']);
}

async function getFingerprints(fileType) {
  const rows = await readRange('內容指紋!A:E');
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).filter(r => r[2] === fileType);
}

// ============================================================
// 月度影片記錄
// 欄位：月份 | 姓名 | 類型 | 數量
// ============================================================

async function getMonthLogs(month) {
  const rows = await readRange('工作記錄!A:K');
  if (!rows || rows.length < 2) return [];
  return rows.slice(1).filter(row => row[0] && row[0].startsWith(month));
}

async function saveMonthlyVideoStats({ month, name, videoCount }) {
  return appendRow('月度記錄', [month, name, '影片統計', String(videoCount)]);
}

module.exports = {
  getSopSettings,
  getTaskTimeRules,
  getDayTypeRules,
  getMemberName,
  getAllMemberNames,
  getAllMembers,
  saveWorkLog,
  getTodayLogs,
  getWeeklyLogs,
  saveLeaveRecord,
  getLeaveRecordsForDate,
  getLeaveRecordsThisWeek,
  getLeaveRecordsForMonth,
  getLeaveRecordForUserOnDate,
  deleteLeaveRecordForUserOnDate,
  getSheetIdByTitle,
  savePublishReport,
  getTodayPublishReports,
  saveMonthlyRecord,
  getMonthlyAnomalies,
  saveEditProgress,
  saveFingerprint,
  getFingerprints,
  getMonthLogs,
  saveMonthlyVideoStats,
  getTaiwanDateString,
  getTaiwanTimeString,
  getTaiwanMonthString,
  DEFAULT_MEMBERS,
};
