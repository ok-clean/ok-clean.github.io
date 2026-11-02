const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
const declaration = source.split('\n').find(line => line.startsWith('const won ='));
const context = vm.createContext({});
vm.runInContext(declaration + '\nthis.format = won;', context);
for (const [input, expected] of [[0,'0'],[499,'0'],[500,'1,000'],[999,'1,000'],[1000,'1,000'],[1499,'1,000'],[1500,'2,000'],[15000,'1.5만']]) {
  assert.equal(context.format(input), expected);
}
console.log('기존 1,000원 단위 반올림 표시 8개 통과');
