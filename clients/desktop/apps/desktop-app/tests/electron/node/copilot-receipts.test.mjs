import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  copilotProcessAlive,
  copilotReceiptEvidence,
  priorCopilotReceipts,
  readCopilotReceipts,
} from '../fixtures/copilot-receipts.mjs';

const identity = { pid: 123, parent: 1, group: 123, started: 'prior' };
const old = { name: 'old.json', processes: [identity] };
const current = {
  name: 'new.json',
  processes: [{ ...identity, pid: 456, started: 'current' }],
};

test('recovery checks the prior boot, not an empty global directory', () => {
  assert.deepEqual(priorCopilotReceipts([old], [old, current]), [old]);
  assert.deepEqual(priorCopilotReceipts([old], [current]), []);
  assert.deepEqual(priorCopilotReceipts([], [current]), []);
  assert.deepEqual(priorCopilotReceipts([old], []), []);
});

test('detects retained filenames and old identities even under new filenames', () => {
  const renamed = { ...old, name: 'renamed.json' };
  const overwritten = { ...current, name: old.name };
  assert.deepEqual(priorCopilotReceipts([old], [renamed]), [renamed]);
  assert.deepEqual(priorCopilotReceipts([old], [overwritten]), [overwritten]);
});

test('does not attribute a reused PID to the old boot', () => {
  const reused = {
    ...current,
    processes: [{ ...identity, started: 'replacement' }],
  };
  assert.deepEqual(priorCopilotReceipts([old], [reused]), []);
});

test('reads named receipt identities and tolerates only concurrent removal', (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'copilot-receipt-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readCopilotReceipts(root), []);
  const directory = path.join(root, 'copilot-runtime-receipts');
  fs.mkdirSync(directory);
  const file = path.join(directory, old.name);
  fs.writeFileSync(file, JSON.stringify({ version: 1, processes: [identity] }));
  fs.writeFileSync(path.join(directory, '.temporary'), 'ignored');
  assert.deepEqual(readCopilotReceipts(root), [old]);

  const original = fs.readFileSync;
  const reader = t.mock.method(fs, 'readFileSync', (name, ...args) => {
    if (name === file) fs.rmSync(file, { force: true });
    return original(name, ...args);
  });
  assert.deepEqual(readCopilotReceipts(root), []);
  reader.mock.restore();
  fs.writeFileSync(file, 'invalid json');
  assert.throws(() => readCopilotReceipts(root), SyntaxError);
});

test('live-process evidence retains filenames and full saved identities', (t) => {
  t.mock.method(process, 'kill', () => true);
  assert.deepEqual(copilotReceiptEvidence([old]), [
    { ...old, livePids: [identity.pid] },
  ]);
});

test('absence means ESRCH, not an uninspectable process', (t) => {
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' });
  });
  assert.equal(copilotProcessAlive(identity.pid), false);
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  assert.throws(() => copilotProcessAlive(identity.pid), /denied/);
});
