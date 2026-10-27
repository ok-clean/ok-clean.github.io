// Test prototype: represent a selected Korean calendar day by its last millisecond.
function koreanDayEnd(value) {
 if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('희망 날짜를 확인해 주세요.');
 const [year, month, day] = value.split('-').map(Number);
 if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('희망 날짜를 확인해 주세요.');
 const midnight = new Date(Date.UTC(year, month - 1, day));
 if (midnight.getUTCFullYear() !== year || midnight.getUTCMonth() !== month - 1 || midnight.getUTCDate() !== day) throw new Error('희망 날짜를 확인해 주세요.');
 return new Date(midnight.getTime() + 15 * 3600000 - 1);
}
module.exports = { koreanDayEnd };
