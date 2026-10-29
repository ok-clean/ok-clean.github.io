'use strict';
// Prototype only. No persistence, automatic retry, or reopening uncertain submissions.
function createSubmissionController(send, options = {}) {
 const timeoutMs = options?.timeoutMs ?? 15000;
 const checkTimeoutMs = options?.checkTimeoutMs ?? timeoutMs;
 const validTimeout = n => Number.isSafeInteger(n) && n >= 1 && n <= 120000;
 if (typeof send !== 'function' || !validTimeout(timeoutMs) || !validTimeout(checkTimeoutMs)) throw new TypeError('Invalid configuration');
 let state = 'idle', requestId = null, checking = null;
 const listeners = new Set();
 function reportListenerError() {
  // UI failures must never alter a committed receipt or prevent the write. No form data is logged.
  try { Promise.resolve(options?.onListenerError?.()).catch(() => {}); } catch {}
 }
 function update(next) {
  if (state === 'success' && next !== 'success') return;
  if (state === next) return;
  state = next;
  for (const fn of [...listeners]) {
   try { Promise.resolve(fn(next)).catch(reportListenerError); } catch { reportListenerError(); }
  }
 }
 function submit(id, form) {
  if (state !== 'idle') throw new Error('현재 접수 상태를 먼저 확인해 주세요.');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('접수 식별자를 확인해 주세요.');
  requestId = id;
  update('pending');
  const timer = setTimeout(() => { if (state === 'pending') update('unknown'); }, timeoutMs);
  return Promise.resolve().then(() => send(id, form)).then(result => {
   if (!result || result.id !== requestId) throw new Error('접수 응답의 식별자가 일치하지 않습니다.');
   if (state === 'pending') update('success');
   return result;
  }).catch(error => {
   update('unknown'); // A verified success is terminal, even if the original write rejects late.
   throw error;
  }).finally(() => clearTimeout(timer));
 }
 function reconcile(check) {
  if (checking) return checking;
  if (state !== 'unknown' || typeof check !== 'function') return Promise.reject(new Error('접수 확인을 진행할 수 없습니다.'));
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('unavailable'), checkTimeoutMs); });
  checking = Promise.race([Promise.resolve().then(() => check(requestId)), deadline]).then(result => {
   if (!['confirmed', 'absent', 'unavailable'].includes(result)) throw new Error('접수 확인 응답이 올바르지 않습니다.');
   if (result === 'confirmed') update('success');
   return result;
  }).finally(() => { clearTimeout(timer); checking = null; });
  return checking;
 }
 function onChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('Listener must be a function');
  listeners.add(fn);
  return () => listeners.delete(fn);
 }
 return {submit, reconcile, getState: () => state, onChange};
}
module.exports = {createSubmissionController};
