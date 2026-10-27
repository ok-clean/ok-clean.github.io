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
