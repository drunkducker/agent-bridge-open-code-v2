import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnProc, runCollect } from '../dist/core/spawn.js';

const N = process.execPath;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('spawnProc refuses to exceed AGENTBRIDGE_MAX_PROCS with RATE_LIMITED', async () => {
  const prev = process.env.AGENTBRIDGE_MAX_PROCS;
  process.env.AGENTBRIDGE_MAX_PROCS = '2';
  const held = [];
  try {
    for (let i = 0; i < 2; i++) held.push(spawnProc(N, ['-e', 'setTimeout(()=>{},30000)'], { keepStdinOpen: true }));
    assert.throws(() => spawnProc(N, ['-e', '0']), (e) => e.code === 'RATE_LIMITED' && e.retryAfterMs > 0);
  } finally {
    for (const h of held) h.kill();
    await Promise.all(held.map((h) => h.wait().catch(() => {})));
    if (prev === undefined) delete process.env.AGENTBRIDGE_MAX_PROCS;
    else process.env.AGENTBRIDGE_MAX_PROCS = prev;
  }
});

test('AGENTBRIDGE_MAX_PROCS=0 disables the cap', async () => {
  const prev = process.env.AGENTBRIDGE_MAX_PROCS;
  process.env.AGENTBRIDGE_MAX_PROCS = '0';
  try {
    const r = await runCollect(N, ['-e', 'console.log("ok")']);
    assert.equal(r.stdout.trim(), 'ok');
  } finally {
    if (prev === undefined) delete process.env.AGENTBRIDGE_MAX_PROCS;
    else process.env.AGENTBRIDGE_MAX_PROCS = prev;
  }
});

test('background children left behind by a CLI that exits are reaped', { skip: process.platform === 'win32' }, async () => {
  const code = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});c.unref();console.log(c.pid);`;
  const r = await runCollect(N, ['-e', code]);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((s) => setTimeout(s, 100));
  assert.equal(alive(pid), false);
});
