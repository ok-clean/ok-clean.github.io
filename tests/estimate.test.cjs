const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const calculator = source.slice(source.indexOf('const isQuote ='), source.indexOf('function summary()'));
function calculate(id, state = {}) {
  const service = config.services.find(s => s.id === id);
  const cur = {v: 0, t: 0, qty: 1, opts: [], ...state};
  const ctx = vm.createContext({svc: () => service, cur});
  vm.runInContext(calculator + '\nthis.result = estimate();', ctx);
  return ctx.result;
}
function prices(result) { return result && [result.lo, result.hi]; }
assert.deepEqual(prices(calculate('move-in')), [150000, 150000]);
assert.deepEqual(prices(calculate('move-in', {opts: [0]})), [180000, 200000]);
assert.deepEqual(prices(calculate('move-in', {v: 1})), [150000, null]);
assert.equal(calculate('move-in', {t: 5}), null);
assert.deepEqual(prices(calculate('regular', {qty: 1})), [150000, 150000]);
assert.deepEqual(prices(calculate('regular', {qty: 20})), [200000, 260000]);
assert.deepEqual(prices(calculate('aircon', {qty: 2})), [200000, null]);
assert.equal(calculate('window'), null);
const line = source.split('\n').find(s => s.startsWith('$("qQty").addEventListener("input"'));
let handler, changes = 0;
const cur = {};
vm.runInNewContext(line, {$: () => ({addEventListener: (_, f) => handler = f}), cur, calc: () => changes++});
for (const [raw, expected] of [['1000', 999], ['0', 1], ['-5', 1], ['42', 42]]) {
  const e = {target: {value: raw}}; handler(e);
  assert.equal(cur.qty, expected); assert.equal(Number(e.target.value), expected);
}
assert.equal(changes, 4);
console.log('견적 예시 8건과 수량 경계 4건 통과');
const dateCode = source.slice(source.indexOf('const today = new Date();'), source.indexOf('\n\n// 가격 방식'));
function restoredDate(saved) {
  const element = {min: '', value: ''};
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-27T12:00:00Z'])); } }
  vm.runInNewContext(dateCode, {Date: FixedDate, Q: {date: saved}, $: () => element});
  return element.value;
}
assert.equal(restoredDate('2026-10-26'), '');
assert.equal(restoredDate('2026-10-27'), '2026-10-27');
assert.equal(restoredDate('2026-11-01'), '2026-11-01');
console.log('과거·당일·미래 날짜 복원 검사 통과');
const dateHandlerCode = source.slice(source.indexOf('$("qDate").addEventListener("change"'), source.indexOf('window.goSms'));
let changeDate, notices = [], recalculations = 0;
const dateInput = {min: '', value: ''};
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-27T12:00:00Z'])); } static now() { return Date.parse('2026-10-27T12:00:00Z'); } }
vm.runInNewContext(dateHandlerCode, {$: () => Object.assign(dateInput, {addEventListener: (_, cb) => changeDate = cb}), Date: FixedDate, toast: msg => notices.push(msg), calc: () => recalculations++});
dateInput.value = '2026-10-26'; changeDate(); assert.equal(dateInput.value, ''); assert.equal(notices.length, 1);
dateInput.value = '2026-10-28'; changeDate(); assert.equal(dateInput.value, '2026-10-28'); assert.equal(recalculations, 2);
console.log('수동 과거 날짜 입력 차단 및 유효 날짜 유지 통과');
