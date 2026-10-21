// Protocol/auth regressions with a private executable; no provider calls or local credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import oc from '../dist/adapters/opencode.js';

for (const version of ['1.2.0', 'opencode v2.1.1']) {
  test(`OpenCode ${version}: missing auth.json is not evidence of missing login`, { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ab-oc-compat-'));
    const calls = path.join(dir, 'calls');
    writeFileSync(path.join(dir, 'opencode'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});
else { console.error('MOCK_SERVE_REACHED'); process.exit(42); }
`, { mode: 0o755 });
    try {
      const it = oc.run({ prompt: 'x', model: 'opencode/free', cwd: dir, timeoutMs: 5000,
        // Explicit provider configuration can work without auth.json.
        env: { PATH: dir, OPENCODE_DATA_DIR: dir } });
      await assert.rejects(it.next(), (e) => {
        if (version.includes('v2')) {
          assert.equal(e.code, 'BAD_OPTION');
          assert.match(e.message, /OpenCode v2.*not supported/i);
          assert.match(e.message, /auth\.json.*login/i);
          assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['--version']);
        } else {
          assert.equal(e.code, 'AGENT_FAILED');
          assert.match(e.message, /MOCK_SERVE_REACHED/);
          assert.match(readFileSync(calls, 'utf8'), /serve --port/);
        }
        return true;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
