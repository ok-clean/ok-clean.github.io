const assert = require('node:assert/strict');
const { koreanDayEnd } = require('./kst-date.cjs');
assert.equal(koreanDayEnd('2026-10-27').toISOString(), '2026-10-27T14:59:59.999Z');
assert.equal(koreanDayEnd('2024-02-29').toISOString(), '2024-02-29T14:59:59.999Z');
assert.equal(koreanDayEnd('2026-01-01').toISOString(), '2026-01-01T14:59:59.999Z');
for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '', null]) assert.throws(() => koreanDayEnd(date));
console.log('PASS Korean calendar-day conversion and invalid dates');
