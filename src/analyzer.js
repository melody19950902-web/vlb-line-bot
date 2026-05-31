'use strict';
// 薄包裝：向後相容，實作已移至 parser.js 和 analysis.js
const { parseWorkLog, detectSpecialDayType, VALID_DAY_TYPES } = require('./parser');
const { analyzeWorkLog, applyDeterministicBatchCheck, localFallbackAnalysis } = require('./analysis');

module.exports = { parseWorkLog, analyzeWorkLog, detectSpecialDayType, VALID_DAY_TYPES, applyDeterministicBatchCheck, localFallbackAnalysis };
