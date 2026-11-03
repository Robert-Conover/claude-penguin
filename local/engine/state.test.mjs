import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState, writeState } from './state.mjs';

test('private state survives an atomic round trip and no temporary files remain', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readState(dir), { version: 1, revision: 0, projects: [], workers: [] });
  const state = { version: 1, revision: 7, projects: [{ id: 'project' }], workers: [{ sessionId: 'persistent-id' }] };
  writeState(dir, state);
  assert.deepEqual(readState(dir), state);
  assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('corrupt or unsupported saved state is preserved and refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'penguin-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readState(dir), /invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [], workers: [] }));
  assert.throws(() => readState(dir), /Unsupported/);
});
