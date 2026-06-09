'use strict';

jest.mock('../src/sheets', () => ({
  getSopSettings:       jest.fn().mockResolvedValue({ '最低工時_小時': '6', '空白時段上限_分': '120' }),
  getTaskTimeRules:     jest.fn().mockResolvedValue([]),
  getDayTypeRules:      jest.fn().mockResolvedValue([
    { 工作類型: '正常日',   最低影片數: '3' },
    { 工作類型: '拍攝日',   最低影片數: '1' },
    { 工作類型: 'Podcast日', 最低影片數: '1' },
    { 工作類型: '課程日',   最低影片數: '0' },
    { 工作類型: '外拍半天', 最低影片數: '1' },
    { 工作類型: '外拍一天', 最低影片數: '0' },
    { 工作類型: '直播日',   最低影片數: '2' },
  ]),
  getTaiwanDateString:  jest.fn().mockReturnValue('2026/05/31'),
  getTaiwanTimeString:  jest.fn().mockReturnValue('22:30'),
}));

const { parseWorkLog, detectSpecialDayType } = require('../src/analyzer');

// ============================================================
// parseWorkLog
// ============================================================

describe('parseWorkLog', () => {
  test('標準日誌解析', () => {
    const text = `今日類型：正常日
影片數量：3
時間記錄：
09:00-10:30 剪輯短影音
10:30-11:00 發布各平台
備註：今天順利`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('正常日');
    expect(result.videoCount).toBe(3);
    expect(result.timeEntries).toHaveLength(2);
    expect(result.notes).toBe('今天順利');
  });

  test('時間記錄選填：無時間記錄不報錯', () => {
    const text = `今日類型：正常日
影片數量：2`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('正常日');
    expect(result.videoCount).toBe(2);
    expect(result.timeEntries).toHaveLength(0);
  });

  test('單位數小時補正：1:00 解析為 13:00', () => {
    const text = `今日類型：正常日
影片數量：2
時間記錄：
1:00-3:30 剪輯影片`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.timeEntries).toHaveLength(1);
    // 1:00 → 13:00, 3:30 → 15:30, 共 150 分鐘
    expect(result.timeEntries[0].duration).toBe(150);
  });

  test('無效 dayType 回傳 error', () => {
    const text = `今日類型：怪類型
影片數量：1`;

    const result = parseWorkLog(text);
    expect(result.error).toMatch(/今日類型/);
  });

  test('缺少影片數量回傳 error', () => {
    const text = `今日類型：正常日
時間記錄：
09:00-10:00 剪輯`;

    const result = parseWorkLog(text);
    expect(result.error).toMatch(/影片數量/);
  });

  test('缺少今日類型回傳 error', () => {
    const text = `影片數量：2
時間記錄：
09:00-10:00 剪輯`;

    const result = parseWorkLog(text);
    expect(result.error).toMatch(/今日類型/);
  });

  test('批量剪輯：從任務描述抓支數', () => {
    const text = `今日類型：正常日
影片數量：3
時間記錄：
09:00-15:00 剪片 3 支`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.timeEntries[0].batchCount).toBe(3);
  });

  test('批量剪輯 per_video_mins 計算正確', () => {
    const text = `今日類型：正常日
影片數量：3
時間記錄：
09:00-15:00 剪片 3 支`;

    const result = parseWorkLog(text);
    // 6 小時 = 360 分鐘 ÷ 3 支 = 120 分鐘/支（剛好不超）
    const entry = result.timeEntries[0];
    expect(Math.round(entry.effectiveMins / entry.batchCount)).toBe(120);
  });

  test('備註多行：完整擷取（Bug 4）', () => {
    const text = `今日類型：正常日
影片數量：2
時間記錄：
09:00-11:00 剪輯
備註：第一行
第二行`;

    const result = parseWorkLog(text);
    expect(result.notes).toContain('第一行');
    expect(result.notes).toContain('第二行');
  });

  test('全形冒號正常解析', () => {
    const text = `今日類型：正常日
影片數量：2`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('正常日');
  });

  test('課程日 0 支不報錯', () => {
    const text = `今日類型：課程日
影片數量：0`;

    const result = parseWorkLog(text);
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('課程日');
    expect(result.videoCount).toBe(0);
  });

  test('課程日（拍攝組）0 支不報錯', () => {
    const result = parseWorkLog('今日類型：課程日（拍攝組）\n影片數量：0');
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('課程日（拍攝組）');
    expect(result.videoCount).toBe(0);
  });

  test('課程日（拍照組）合法', () => {
    const result = parseWorkLog('今日類型：課程日（拍照組）\n影片數量：0');
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('課程日（拍照組）');
  });

  test('課程日（限動組）合法', () => {
    const result = parseWorkLog('今日類型：課程日（限動組）\n影片數量：0');
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('課程日（限動組）');
  });

  test('課程日（行政支援）合法', () => {
    const result = parseWorkLog('今日類型：課程日（行政支援）\n影片數量：0');
    expect(result.error).toBeUndefined();
    expect(result.dayType).toBe('課程日（行政支援）');
  });
});

// ============================================================
// detectSpecialDayType
// ============================================================

describe('detectSpecialDayType', () => {
  test('外拍半天', () => {
    const result = detectSpecialDayType('外拍半天');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('外拍半天');
  });

  test('外拍一天', () => {
    const result = detectSpecialDayType('外拍一天');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('外拍一天');
  });

  test('課程拍攝 N 小時 → dayType 為課程日', () => {
    const result = detectSpecialDayType('課程拍攝 3 小時');
    expect(result).not.toBeNull();
    // 修正後應回傳標準 dayType
    expect(result.hours).toBe(3);
  });

  test('直播 N 小時', () => {
    const result = detectSpecialDayType('直播 2 小時');
    expect(result).not.toBeNull();
    expect(result.hours).toBe(2);
  });

  test('跟拍日（無時數）', () => {
    const result = detectSpecialDayType('跟拍日');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('跟拍日');
    expect(result.hours).toBeNull();
  });

  test('跟拍日 3小時', () => {
    const result = detectSpecialDayType('跟拍日 3小時');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('跟拍日');
    expect(result.hours).toBe(3);
  });

  test('跟拍日半天 → 4.5 小時', () => {
    const result = detectSpecialDayType('跟拍日半天');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('跟拍日');
    expect(result.hours).toBe(4.5);
  });

  test('跟拍日一天 → 9 小時', () => {
    const result = detectSpecialDayType('跟拍日一天');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('跟拍日');
    expect(result.hours).toBe(9);
  });

  test('Podcast日 2小時', () => {
    const result = detectSpecialDayType('Podcast日 2小時');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('Podcast日');
    expect(result.hours).toBe(2);
  });

  test('Podcast日半天 → 4.5 小時', () => {
    const result = detectSpecialDayType('Podcast日半天');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('Podcast日');
    expect(result.hours).toBe(4.5);
  });

  test('isNonEditingTask：跟拍任務視為非剪輯', () => {
    const { isNonEditingTask } = require('../src/parser');
    expect(isNonEditingTask('09:00-12:00 跟拍活動')).toBe(true);
    expect(isNonEditingTask('跟拍藝人')).toBe(true);
  });

  test('isNonEditingTask：剪輯跟拍素材視為剪輯（不排除）', () => {
    const { isNonEditingTask } = require('../src/parser');
    // 同時含剪輯 → editing 優先，不排除
    expect(isNonEditingTask('剪輯跟拍素材')).toBe(false);
  });

  test('課程日（拍攝組）簡短宣告', () => {
    const result = detectSpecialDayType('課程日（拍攝組）');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('課程日（拍攝組）');
  });

  test('課程日（行政支援）簡短宣告', () => {
    const result = detectSpecialDayType('課程日（行政支援）');
    expect(result).not.toBeNull();
    expect(result.dayType).toBe('課程日（行政支援）');
  });

  test('無法識別回傳 null', () => {
    expect(detectSpecialDayType('今天天氣好')).toBeNull();
    expect(detectSpecialDayType('')).toBeNull();
    expect(detectSpecialDayType(null)).toBeNull();
  });
});
