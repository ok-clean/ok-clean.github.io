// Emulator-only prototype. No storage and no automatic retry on uncertain outcomes.
function createSubmissionController(send, options = {}) {
 const timeoutMs = options.timeoutMs ?? 15000;
 if (typeof send !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid configuration');
 let state = 'idle', pending = null, timer = null, requestId = null, checking = null;
 const listeners = new Set();
 function update(next) { state = next; for (const fn of listeners) fn(next); }
 function submit(id, form) {
  if (state !== 'idle') throw new Error('현재 접수 상태를 먼저 확인해 주세요.');
  requestId = id;
  update('pending');
  timer = setTimeout(() => { if (state === 'pending') update('unknown'); }, timeoutMs);
  pending = Promise.resolve().then(() => send(id,form)).then(result => {
    clearTimeout(timer); if (state !== 'unknown') update('success'); return result;
  }, error => {
    clearTimeout(timer); update('unknown'); throw error;
  });
  return pending;
 }
 async function reconcile(check) {
  if (state !== 'unknown') throw new Error('접수 확인을 진행할 수 없습니다.');
  if (checking) return checking;
  if (typeof check !== 'function') throw new Error('접수 확인 함수를 지정해 주세요.');
  checking = Promise.resolve().then(() => check(requestId)).then(result => {
   if (result !== 'confirmed' && result !== 'absent' && result !== 'unavailable') throw new Error('접수 확인 응답이 올바르지 않습니다.');
   if (result === 'confirmed') update('success');
   return result;
  }).finally(() => { checking = null; });
  return checking;
 }
 return {submit, reconcile, getState: () => state, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
}
module.exports = {createSubmissionController};
