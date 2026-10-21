// A machine with no agent CLIs: every surface must say so clearly (and say how to fix it), never fail silently.
// PATH holds only node; nothing is spawned except node itself. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js');
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ready-')));
mkdirSync(path.join(home, 'proj'));
// PATH must hold node and nothing else. node's own directory can also hold globally installed agent CLIs
// (nvm, npm prefix, /usr/local/bin), so expose only a link to the node binary in a private directory.
const bin = path.join(home, 'bin');
mkdirSync(bin);
const nodeLink = path.join(bin, path.basename(process.execPath));
try { symlinkSync(process.execPath, nodeLink); } catch { copyFileSync(process.execPath, nodeLink); }
const env = { ...process.env, PATH: bin, Path: bin, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'la'), APPDATA: path.join(home, 'ad'), CODEX_HOME: path.join(home, 'cx'), PI_CODING_AGENT_DIR: path.join(home, 'pi') };
const node = (args, { wait = 0 } = {}) => new Promise((res) => {
  const p = spawn(process.execPath, args, { env, cwd: path.join(home, 'proj') });
  let o = '', e = '';
  p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (e += b));
  if (wait) setTimeout(() => p.kill(), wait);
  p.on('close', (c) => res({ c, o, e }));
});

test('run with a missing agent: NOT_INSTALLED with an install hint, exit 1', async () => {
  for (const [a, hint] of [['claude', 'npm i -g @anthropic-ai/claude-code'], ['codex', 'codex login'], ['opencode', 'opencode']]) {
    const r = await node([MAIN, 'run', a, 'hi']);
    assert.equal(r.c, 1, a);
    assert.match(r.e + r.o, /NOT_INSTALLED|not installed|not found/i, a);
    assert.ok((r.e + r.o).includes(hint), `${a}: ${r.e}${r.o}`);
  }
});

test('install all with nothing installed says so and exits non-zero', async () => {
  const r = await node([MAIN, 'install', 'all', '--cwd', path.join(home, 'proj')]);
  assert.equal(r.c, 1);
  assert.match(r.o + r.e, /skipped claude: not installed/);
  assert.match(r.o + r.e, /nothing installed/);
});

test('serve prints which agents are missing and how to install them', async () => {
  const r = await node([MAIN, 'serve', '--port', '0'], { wait: 3000 });
  assert.match(r.e, /\[missing\] claude/);
  assert.match(r.e, /npm i -g @anthropic-ai\/claude-code/);
});

test('/v1/models does not list agents that are not installed', async () => {
  const code = `const { listModels } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist', 'server', 'common.js')).href)}); console.log(JSON.stringify(await listModels()));`;
  const r = await node(['--input-type=module', '-e', code]);
  const list = JSON.parse(r.o.trim().split('\n').pop());
  assert.ok(!list.some((m) => /^(claude|codex|opencode)\//.test(m)), JSON.stringify(list));
});

test('bridge ask_* with a missing callee returns isError with the reason and hint', async () => {
  const { rpc } = await import('./_rpc.mjs');
  const c = rpc(env);
  try {
    await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    c.notify('notifications/initialized', {});
    const r = await c.tool('ask_codex', { prompt: 'hi' });
    assert.equal(r.result.isError, true, JSON.stringify(r));
    const txt = JSON.stringify(r.result);
    assert.match(txt, /NOT_INSTALLED|not found|not installed/i);
    assert.ok(txt.includes('codex login'), txt);
  } finally { c.close(); }
});
