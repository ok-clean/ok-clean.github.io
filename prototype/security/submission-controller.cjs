// Emulator-only prototype. No storage and no automatic retry on uncertain outcomes.
function createSubmissionController(send, options = {}) {
 const timeoutMs = options.timeoutMs ?? 15000;
 if (typeof send !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid configuration');
 let state = 'idle', pending = null, timer = null;
 const listeners = new Set();
 function update(next) { state = next; for (const fn of listeners) fn(next); }
 function submit(id, form) {
  if (state !== 'idle') throw new Error('현재 접수 상태를 먼저 확인해 주세요.');
  update('pending');
  timer = setTimeout(() => { if (state === 'pending') update('unknown'); }, timeoutMs);
  pending = Promise.resolve().then(() => send(id,form)).then(result => {
    clearTimeout(timer); update('success'); return result;
  }, error => {
    clearTimeout(timer); update('unknown'); throw error;
  });
  return pending;
 }
 return {submit, getState: () => state, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
}
module.exports = {createSubmissionController};
