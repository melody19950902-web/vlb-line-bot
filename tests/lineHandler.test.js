'use strict';

jest.mock('../src/sheets', () => ({
  getMemberName:        jest.fn().mockResolvedValue(null),
  saveWorkLog:          jest.fn().mockResolvedValue(undefined),
  savePublishReport:    jest.fn().mockResolvedValue(undefined),
  saveLeaveRecord:      jest.fn().mockResolvedValue(undefined),
  getTaiwanDateString:  jest.fn().mockReturnValue('2026/05/31'),
  getTaiwanTimeString:  jest.fn().mockReturnValue('10:00'),
}));

jest.mock('../src/analyzer', () => ({
  parseWorkLog:         jest.fn().mockReturnValue({ dayType: '正常日', videoCount: 2 }),
  detectSpecialDayType: jest.fn().mockReturnValue(null),
  VALID_DAY_TYPES:      ['正常日', '拍攝日', 'Podcast日', '課程日', '外拍半天', '外拍一天', '直播日'],
}));

jest.mock('../src/commands', () => ({
  handleCommand: jest.fn().mockResolvedValue(null),
}));

// lineHandler 只 export handleEvent，但我們要測試內部 helper。
// 在 Phase 3 重構後，這些 helper 會從 lineHandler 直接 export。
// 目前透過模組自身取得（需要在 lineHandler.js 補 export）。
const lineHandler = require('../src/lineHandler');
const { isWorkLog, isPublishReport, parseLeaveRequest } = lineHandler;

// ============================================================
// isWorkLog
// ============================================================

describe('isWorkLog', () => {
  test('含今日類型 + 影片數量 → true', () => {
    expect(isWorkLog('今日類型：正常日\n影片數量：3')).toBe(true);
  });

  test('只有今日類型 → false', () => {
    expect(isWorkLog('今日類型：正常日')).toBe(false);
  });

  test('只有影片數量 → false', () => {
    expect(isWorkLog('影片數量：3')).toBe(false);
  });

  test('空字串 → false', () => {
    expect(isWorkLog('')).toBe(false);
  });

  test('null → false', () => {
    expect(isWorkLog(null)).toBe(false);
  });
});

// ============================================================
// isPublishReport
// ============================================================

describe('isPublishReport', () => {
  test('標準格式 → true', () => {
    expect(isPublishReport('已發布｜IG｜薇安職場女人說')).toBe(true);
  });

  test('半形 | → true', () => {
    expect(isPublishReport('已發布|FB|VLB')).toBe(true);
  });

  test('普通訊息 → false', () => {
    expect(isPublishReport('今天發布了一些東西')).toBe(false);
  });

  test('null → false', () => {
    expect(isPublishReport(null)).toBe(false);
  });
});

// ============================================================
// parseLeaveRequest
// ============================================================

describe('parseLeaveRequest', () => {
  // --- 明天系列（原有功能）---
  test('明天請假', () => {
    const r = parseLeaveRequest('明天請假');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('請假');
    expect(r.isToday).toBe(false);
  });

  test('明天休假', () => {
    const r = parseLeaveRequest('明天休假');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('休假');
    expect(r.isToday).toBe(false);
  });

  test('明天補休', () => {
    const r = parseLeaveRequest('明天補休');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('補休');
    expect(r.isToday).toBe(false);
  });

  test('明天補休半天', () => {
    const r = parseLeaveRequest('明天補休半天');
    expect(r).not.toBeNull();
    expect(r.hours).toBe(4);
    expect(r.isToday).toBe(false);
  });

  test('明天補休 2 小時', () => {
    const r = parseLeaveRequest('明天補休 2 小時');
    expect(r).not.toBeNull();
    expect(r.hours).toBe(2);
    expect(r.isToday).toBe(false);
  });

  test('明天早上補休半天', () => {
    const r = parseLeaveRequest('明天早上補休半天');
    expect(r).not.toBeNull();
    expect(r.session).toBe('早上');
    expect(r.isToday).toBe(false);
  });

  // --- 今日系列（Bug 1 修正後應通過）---
  test('今日病假', () => {
    const r = parseLeaveRequest('今日病假');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('病假');
    expect(r.isToday).toBe(true);
  });

  test('今日事假', () => {
    const r = parseLeaveRequest('今日事假');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('事假');
    expect(r.isToday).toBe(true);
  });

  test('今日請假', () => {
    const r = parseLeaveRequest('今日請假');
    expect(r).not.toBeNull();
    expect(r.leaveType).toBe('請假');
    expect(r.isToday).toBe(true);
  });

  // --- 無法識別 ---
  test('隨便文字 → null', () => {
    expect(parseLeaveRequest('隨便文字')).toBeNull();
  });

  test('null → null', () => {
    expect(parseLeaveRequest(null)).toBeNull();
  });
});
