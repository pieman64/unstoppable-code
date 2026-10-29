import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DEFAULT_MOCK_BASE_URL } from '../electron/seeders/index.mjs';
import {
  PERFORMANCE_MOCK_BASE_URL,
  resetOwnedMockServer,
} from './mock-server.mjs';

test('performance verification does not share the Playwright mock-server origin', () => {
  assert.notEqual(PERFORMANCE_MOCK_BASE_URL, DEFAULT_MOCK_BASE_URL);
});

test('owned mock servers are stopped when scenario reset fails', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit'));
  };
  const failure = new Error('reset failed');

  await assert.rejects(
    resetOwnedMockServer(child, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(child.signalCode, 'SIGTERM');
});
