'use strict';

jest.mock('../src/sheets', () => ({
  getSopSettings:   jest.fn().mockResolvedValue({ '最低工時_小時': '6', '空白時段上限_分': '120' }),
  getTaskTimeRules: jest.fn().mockResolvedValue([]),
  getDayTypeRules:  jest.fn().mockResolvedValue([
    { 工作類型: '正常日',   最低影片數: '3' },
    { 工作類型: '課程日',   最低影片數: '0' },
    { 工作類型: '拍攝日',   最低影片數: '1' },
  ]),
}));

// applyDeterministicBatchCheck 和 localFallbackAnalysis 在重構後從 analysis.js export
// 目前在 analyzer.js 內部，需補 export（Phase 3）
const { applyDeterministicBatchCheck, localFallbackAnalysis } = require('../src/analyzer');

// ============================================================
// applyDeterministicBatchCheck
// ============================================================

describe('applyDeterministicBatchCheck', () => {
  function makeEntry(task, effectiveMins, batchCount) {
    return { task, effectiveMins, batchCount, startTime: '09:00', endTime: '12:00', duration: effectiveMins };
  }

  test('per_video_mins ≤ 120：不加異常', () => {
    const parsedLog = { timeEntries: [makeEntry('剪片 3 支', 360, 3)] };
    const result = applyDeterministicBatchCheck({ status: 'normal', anomalies: [] }, parsedLog);
    expect(result.anomalies).toHaveLength(0);
    expect(result.status).toBe('normal');
  });

  test('per_video_mins > 120：強制加異常', () => {
    const parsedLog = { timeEntries: [makeEntry('剪片 2 支', 360, 2)] };
    const result = applyDeterministicBatchCheck({ status: 'normal', anomalies: [] }, parsedLog);
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.status).toBe('warning');
  });

  test('Claude 誤加批量異常：per_video_mins ≤ 120 時被移除', () => {
    const parsedLog = { timeEntries: [makeEntry('剪片 3 支', 300, 3)] };
    // per_video_mins = 100，Claude 卻加了異常
    const claudeResult = { status: 'warning', anomalies: ['剪片 3 支 耗時稍長'] };
    const result = applyDeterministicBatchCheck(claudeResult, parsedLog);
    expect(result.anomalies).toHaveLength(0);
  });

  test('無批量任務：不影響結果', () => {
    const parsedLog = { timeEntries: [makeEntry('外拍記錄', 240, null)] };
    const original = { status: 'normal', anomalies: [] };
    const result = applyDeterministicBatchCheck(original, parsedLog);
    expect(result.status).toBe('normal');
    expect(result.anomalies).toHaveLength(0);
  });
});

// ============================================================
// localFallbackAnalysis
// ============================================================

describe('localFallbackAnalysis', () => {
  test('課程日 0 支 → normal', async () => {
    const parsedLog = {
      dayType: '課程日', videoCount: 0,
      timeEntries: [], effectiveTotalHours: 7, effectiveTotalMinutes: 420, notes: '',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('normal');
    expect(result.anomalies).toHaveLength(0);
  });

  test('正常日 0 支 無備註 → alert', async () => {
    const parsedLog = {
      dayType: '正常日', videoCount: 0,
      timeEntries: [], effectiveTotalHours: 7, effectiveTotalMinutes: 420, notes: '',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('alert');
    expect(result.anomalies.some(a => a.includes('影片') || a.includes('0'))).toBe(true);
  });

  test('正常日 0 支 有備註 → normal（備註說明充分）', async () => {
    const parsedLog = {
      dayType: '正常日', videoCount: 0,
      timeEntries: [], effectiveTotalHours: 7, effectiveTotalMinutes: 420,
      notes: '今日全天拍攝，影片後天剪輯',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('normal');
  });

  test('工時不足（有時間記錄）→ warning', async () => {
    const parsedLog = {
      dayType: '正常日', videoCount: 3,
      timeEntries: [{ task: '剪輯', effectiveMins: 180, batchCount: null, startTime: '09:00', endTime: '12:00', duration: 180 }],
      effectiveTotalHours: 3, effectiveTotalMinutes: 180, notes: '',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('warning');
    expect(result.anomalies.some(a => a.includes('時數'))).toBe(true);
  });

  test('工時不足但有備註 → normal', async () => {
    const parsedLog = {
      dayType: '正常日', videoCount: 2,
      timeEntries: [{ task: '剪輯', effectiveMins: 180, batchCount: null, startTime: '09:00', endTime: '12:00', duration: 180 }],
      effectiveTotalHours: 3, effectiveTotalMinutes: 180,
      notes: '下午身體不適提早離開',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('normal');
  });

  test('批量超時（per_video_mins > 120）→ warning', async () => {
    const parsedLog = {
      dayType: '正常日', videoCount: 2,
      timeEntries: [{ task: '剪片 2 支', effectiveMins: 360, batchCount: 2, startTime: '09:00', endTime: '15:00', duration: 360 }],
      effectiveTotalHours: 6, effectiveTotalMinutes: 360, notes: '',
    };
    const result = await localFallbackAnalysis(parsedLog);
    expect(result.status).toBe('warning');
  });
});
