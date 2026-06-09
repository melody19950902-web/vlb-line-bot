'use strict';

// ============================================================
// 有效工作類型清單
// ============================================================
const VALID_DAY_TYPES = [
  // 主要類型
  '正常日', '跟拍日', '課程日', '大型活動日',
  // 向後相容（舊格式繼續接受）
  '拍攝日', 'Podcast日', '直播日', '外拍半天', '外拍一天',
];

// 課程日判斷（含所有角色分組變體，用前綴比對）
function isCourseDay(dayType) {
  return typeof dayType === 'string' && dayType.startsWith('課程日');
}

// 向後相容：集合形式供 analysis.js 的本地備援使用
const COURSE_DAY_TYPES = new Set(['課程日']);

// ============================================================
// 時間工具
// ============================================================

function timeToMinutes(str) {
  const normalized = str.replace('：', ':');
  const parts = normalized.split(':');
  let h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  // 單位數小時（無補零）在工作日誌中視為下午時段：1→13, 2→14 ... 9→21
  if (parts[0].length === 1 && h >= 1 && h <= 9) h += 12;
  return h * 60 + m;
}

function durationMinutes(start, end) {
  return timeToMinutes(end) - timeToMinutes(start);
}

// ============================================================
// 限動數量偵測
// ============================================================
function extractLimitedStoryCount(entries) {
  let total = 0;
  for (const entry of entries) {
    const m = entry.task.match(/限[動時][動態]?\s*(\d+)\s*則/);
    if (m) total += parseInt(m[1]);
  }
  return total;
}

// ============================================================
// 批量剪輯：從任務描述中抓支數
// 例：「剪片 3 支」「剪輯 2 支」「短影音剪 4 支」
// ============================================================
function parseBatchCount(task) {
  const m = task.match(/(?:剪[片輯了編]|短影音剪)\s*(\d+)\s*支/);
  return m ? parseInt(m[1]) : null;
}

// ============================================================
// 非剪輯任務判斷（用於計算可剪輯時間）
// ============================================================
function isNonEditingTask(task) {
  const editing = /剪[片輯了編]|短影音剪|後製|剪接/;
  const nonEditing = /拍攝|拍照|直播|課程|會議|溝通|協調|設備|架設|外拍|外出|準備|整理|字幕排程|行政|現場|採購|場勘|巡場|簡報|討論|Podcast|podcast|試妝|妝面|輪播貼文|輪播私文|撰寫|修改指令|文章重點|影片排程|巧睫|修圖|修照片/;
  return nonEditing.test(task) && !editing.test(task);
}

// 依可剪輯時間計算最低影片數標準
function minVideosFromAvailableTime(availableMins) {
  if (availableMins >= 240) return 3;   // 4 小時以上 → 3 支
  if (availableMins >= 150) return 2;   // 2.5–4 小時 → 2 支
  if (availableMins >= 60)  return 1;   // 1–2.5 小時 → 1 支
  return 0;                             // 1 小時以下 → 0–1 支
}

// ============================================================
// 發布工時解析
// 支援新格式：已發布｜IG｜薇安職場女人說
// 支援舊格式：第一更 IG、Threads、FB 發布完成
// 每平台 9 分鐘
// ============================================================
const PLATFORM_KEYWORDS = ['IG', 'Instagram', 'Threads', 'FB', 'Facebook', 'LinkedIn', 'YouTube', 'YT', 'TikTok'];

function countPlatforms(text) {
  const found = new Set();
  for (const p of PLATFORM_KEYWORDS) {
    if (text.includes(p)) {
      const key = p === 'Instagram' ? 'IG' : p === 'Facebook' ? 'FB' : p;
      found.add(key);
    }
  }
  return found.size;
}

function parsePublishMinutes(timeLogRaw) {
  let totalPlatforms = 0;
  for (const line of timeLogRaw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^\d{1,2}[：:]\d{2}\s*[-–—]/.test(t)) continue;
    if (/發布|已發布/.test(t)) {
      totalPlatforms += countPlatforms(t);
    }
  }
  return totalPlatforms * 9;
}

// ============================================================
// 解析完整工作日誌格式
// ============================================================
function parseWorkLog(text) {
  if (!text || typeof text !== 'string') {
    return { error: '訊息內容為空' };
  }

  const normalized = text.replace(/\r\n/g, '\n').replace(/：/g, ':').trim();

  // --- 今日類型 ---
  const typeMatch = normalized.match(/今日類型:\s*(.+)/);
  if (!typeMatch) return { error: '缺少「今日類型」欄位' };
  const dayType = typeMatch[1].trim();

  // 課程日（含任意角色分組）或其他有效類型
  if (!VALID_DAY_TYPES.includes(dayType) && !isCourseDay(dayType)) {
    return {
      error: `「今日類型」填寫有誤（填入：${dayType}）\n` +
             `可填：正常日、跟拍日、課程日、大型活動日等`,
    };
  }

  // --- 影片數量 ---
  const videoMatch = normalized.match(/影片數量:\s*(\d+)/);
  if (!videoMatch) return { error: '缺少「影片數量」欄位，或數量非數字' };
  const videoCount = parseInt(videoMatch[1]);

  // --- 時間記錄（選填）---
  // 有時間 → 用時間輔助計算；沒有或格式不標準 → 忽略時間，不拒絕日誌
  const timeLogMatch = normalized.match(/時間記錄:\s*\n([\s\S]+?)(?=備註:|$)/);
  const timeLogRaw = timeLogMatch ? timeLogMatch[1].trim() : '';

  const timeEntries = [];
  if (timeLogRaw) {
    const linePattern = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s+(.+)/g;
    let m;
    while ((m = linePattern.exec(timeLogRaw)) !== null) {
      const startTime = m[1];
      const endTime   = m[2];
      const task      = m[3].trim();
      const rawDuration = durationMinutes(startTime, endTime);
      if (rawDuration <= 0) continue;

      const effectiveMins = rawDuration;
      let batchCount = parseBatchCount(task);
      if (!batchCount && /剪[片輯了編]|短影音剪/.test(task) && videoCount > 0) {
        batchCount = videoCount;
      }

      timeEntries.push({ startTime, endTime, task, duration: rawDuration, effectiveMins, batchCount });
    }
  }

  // --- 備註（選填，可多行）---
  const notesMatch = normalized.match(/備註:\s*([\s\S]+)/);
  const notes = notesMatch ? notesMatch[1].trim() : '';

  // --- 發布工時（非時間段行）---
  const publishMinutes = parsePublishMinutes(timeLogRaw);

  // --- 有效總工時（任務時段直接加總 + 發布工時）---
  const effectiveTotalMinutes = timeEntries.reduce((sum, e) => sum + e.effectiveMins, 0) + publishMinutes;
  const effectiveTotalHours   = Math.round(effectiveTotalMinutes / 6) / 10;

  // --- 原始總工時（任務時段加總，不含發布工時）---
  const totalMinutes = timeEntries.reduce((sum, e) => sum + e.duration, 0);
  const totalHours   = Math.round(totalMinutes / 6) / 10;

  // --- 空白時段（超過 120 分鐘才標記異常）---
  const gaps = [];
  for (let i = 1; i < timeEntries.length; i++) {
    const prevEndMin   = timeToMinutes(timeEntries[i - 1].endTime);
    const currStartMin = timeToMinutes(timeEntries[i].startTime);
    const gapMin = currStartMin - prevEndMin;
    if (gapMin <= 0) continue;
    gaps.push({ from: timeEntries[i - 1].endTime, to: timeEntries[i].startTime, minutes: gapMin });
  }

  // --- 限動數量 ---
  const limitedStoryCount = extractLimitedStoryCount(timeEntries);

  return {
    dayType, videoCount, timeEntries, timeLogRaw,
    totalMinutes, totalHours,
    effectiveTotalMinutes, effectiveTotalHours,
    publishMinutes,
    gaps, notes, limitedStoryCount,
  };
}

// ============================================================
// 特殊工作日簡短格式
// ============================================================

function detectSpecialDayType(text) {
  if (!text) return null;
  const t = text.trim();

  // 課程日（含任意角色分組，如「課程日（拍攝組）」）
  if (t.startsWith('課程日')) return { dayType: t, hours: null };

  // 其他主要類型直接關鍵字
  const DIRECT_KEYWORDS = ['跟拍日', '大型活動日', 'Podcast日', '直播日', '外拍半天', '外拍一天'];
  if (DIRECT_KEYWORDS.includes(t)) return { dayType: t, hours: null };

  // 舊格式相容
  const courseMatch = t.match(/^課程拍攝\s*(\d+)\s*小時/);
  if (courseMatch) return { dayType: `課程拍攝 ${courseMatch[1]} 小時`, hours: parseInt(courseMatch[1]) };

  const liveMatch = t.match(/^直播\s*(\d+)\s*小時/);
  if (liveMatch) return { dayType: `直播 ${liveMatch[1]} 小時`, hours: parseInt(liveMatch[1]) };

  const eventMatch = t.match(/^(活動外拍|課程拍攝)｜(.+)/);
  if (eventMatch) return { dayType: `${eventMatch[1]}｜${eventMatch[2]}`, hours: null };

  return null;
}

module.exports = {
  VALID_DAY_TYPES, COURSE_DAY_TYPES, isCourseDay,
  timeToMinutes, durationMinutes,
  isNonEditingTask, minVideosFromAvailableTime,
  parseWorkLog, detectSpecialDayType,
};
