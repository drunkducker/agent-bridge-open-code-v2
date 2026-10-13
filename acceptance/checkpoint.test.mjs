import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCheckpoint, listCheckpoints, rollbackCheckpoint, diffCheckpoint } from '../dist/extras/checkpoint.js';

test('createCheckpoint and rollbackCheckpoint restore exact working directory state', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ab-cp-test-'));
  execSync('git init && git config user.name test && git config user.email test@test.com && git commit --allow-empty -m init', { cwd: repo });
  
  writeFileSync(path.join(repo, 'file.txt'), 'version 1 original\n');
  const cp1 = createCheckpoint(repo, { message: 'before changes' });
  
  assert.ok(cp1.id);
  assert.ok(cp1.ref.startsWith('refs/agentbridge/checkpoints/'));
  assert.ok(cp1.commitOid);

  // List should contain cp1
  const list = listCheckpoints(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, cp1.id);
  assert.equal(list[0].message, 'before changes');

  // Modify file and add new unwanted file
  writeFileSync(path.join(repo, 'file.txt'), 'version 2 corrupted\n');
  writeFileSync(path.join(repo, 'unwanted.txt'), 'delete me\n');
  writeFileSync(path.join(repo, 'staged-after.txt'), 'staged after snapshot\n');
  execSync('git add staged-after.txt', { cwd: repo });

  // Diff should show changes
  const diff = diffCheckpoint(repo, cp1.id);
  assert.match(diff, /version 2 corrupted/);

  // Rollback to cp1
  const rb = rollbackCheckpoint(repo, cp1.id);
  assert.ok(rb.restoredOid);
  assert.ok(rb.removedFiles.includes('staged-after.txt'));

  // File should be back to version 1
  const content = readFileSync(path.join(repo, 'file.txt'), 'utf8');
  assert.equal(content, 'version 1 original\n');
  assert.equal(existsSync(path.join(repo, 'unwanted.txt')), false);
  assert.equal(existsSync(path.join(repo, 'staged-after.txt')), false);

  rmSync(repo, { recursive: true, force: true });
});

test('checkpoint list round-trips nested session ids and delimiter characters in messages', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ab-cp-parse-test-'));
  try {
    execSync('git init && git config user.name test && git config user.email test@test.com && git commit --allow-empty -m init', { cwd: repo });
    const cp = createCheckpoint(repo, { sessionId: 'team/session', message: 'state | stable' });
    createCheckpoint(repo, { sessionId: 'team/child', message: 'another checkpoint' });
    const all = listCheckpoints(repo);
    const filtered = listCheckpoints(repo, 'team/session');
    assert.equal(all.length, 2);
    const nestedSession = all.find((entry) => entry.id === cp.id);
    assert.equal(nestedSession.sessionId, 'team/session');
    assert.equal(nestedSession.message, 'state | stable');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, cp.id);
    assert.equal(filtered[0].sessionId, 'team/session');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rollback removes staged Unicode and leading-space paths while preserving checkpoint paths', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ab-cp-path-test-'));
  const originalName = ` caf${String.fromCharCode(233)}-original.txt`;
  const addedUnicodeName = `caf${String.fromCharCode(233)}-added.txt`;
  const addedSpaceName = ' staged-after.txt';
  try {
    execSync('git init && git config user.name test && git config user.email test@test.com', { cwd: repo });
    writeFileSync(path.join(repo, originalName), 'original checkpoint contents\n');
    execSync('git add -A && git commit -q -m initial', { cwd: repo });
    const cp = createCheckpoint(repo, { message: 'before unicode additions' });

    writeFileSync(path.join(repo, originalName), 'changed after checkpoint\n');
    writeFileSync(path.join(repo, addedUnicodeName), 'unicode addition\n');
    writeFileSync(path.join(repo, addedSpaceName), 'space addition\n');
    execSync('git add -A', { cwd: repo });
    execSync('git config diff.external nonexistent-ab-checkpoint-diff-command', { cwd: repo });
    const diff = diffCheckpoint(repo, cp.id);
    assert.match(diff, /changed after checkpoint/);

    const result = rollbackCheckpoint(repo, cp.id);
    assert.equal(readFileSync(path.join(repo, originalName), 'utf8'), 'original checkpoint contents\n');
    assert.equal(existsSync(path.join(repo, addedUnicodeName)), false);
    assert.equal(existsSync(path.join(repo, addedSpaceName)), false);
    assert.ok(result.removedFiles.includes(addedUnicodeName));
    assert.ok(result.removedFiles.includes(addedSpaceName));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
