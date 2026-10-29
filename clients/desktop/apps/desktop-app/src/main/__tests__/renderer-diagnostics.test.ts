import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsSummary } from '@canopy/desktop-shared/types/observability';

const ipcMain = new EventEmitter();
jest.mock('electron', () => ({ ipcMain }));

import {
  registerRendererDiagnosticsHandler,
  validateRendererDiagnosticsSummary,
} from '../ipc/renderer-diagnostics';

const valid: RendererDiagnosticsSummary = {
  windowMs: 30_000,
  remoteWindow: false,
  frames: {
    count: 2,
    p95Ms: 75,
    maxMs: 80,
    blockingMs: 20,
    invokers: { userCallback: 1, eventListener: 1, promise: 0, script: 0 },
  },
  chatState: {
    onScreenChanges: 3,
    offScreenChanges: 2,
    scopeChanges: 1,
    onScreenMessages: 1,
    offScreenMessages: 1,
    mixedMessages: 1,
    onScreenApplyMs: 2,
    offScreenApplyMs: 3,
    mixedApplyMs: 4,
  },
  chatEvent: {
    onScreenEvents: 2,
    offScreenEvents: 1,
    delegationEvents: 1,
    onScreenApplyMs: 2,
    offScreenApplyMs: 3,
    delegationApplyMs: 4,
  },
  terminal: { deliveries: 2, applyMs: 1 },
};

describe('renderer diagnostics IPC', () => {
  it('accepts an exact content-free summary', () => {
    expect(validateRendererDiagnosticsSummary(valid)).toEqual(valid);
  });

  it.each([
    ['non-numeric', { ...valid, windowMs: '30000' }],
    ['negative', { ...valid, terminal: { ...valid.terminal, deliveries: -1 } }],
    ['NaN', { ...valid, frames: { ...valid.frames, maxMs: NaN } }],
    [
      'Infinity',
      {
        ...valid,
        chatEvent: { ...valid.chatEvent, offScreenApplyMs: Infinity },
      },
    ],
    ['oversized window', { ...valid, windowMs: 120_001 }],
    [
      'oversized count',
      {
        ...valid,
        chatState: { ...valid.chatState, onScreenChanges: 10_000_001 },
      },
    ],
    [
      'oversized duration',
      { ...valid, terminal: { ...valid.terminal, applyMs: 300_001 } },
    ],
    ['missing nested field', { ...valid, terminal: { deliveries: 2 } }],
    ['extra top-level field', { ...valid, chatId: 'chat-secret' }],
    [
      'extra nested field',
      { ...valid, frames: { ...valid.frames, sourceUrl: 'secret' } },
    ],
    ['non-boolean remote flag', { ...valid, remoteWindow: 1 }],
    ['fractional count', { ...valid, frames: { ...valid.frames, count: 1.5 } }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRendererDiagnosticsSummary(value)).toThrow();
  });

  it('records the validated local diagnostic and drops malformed sends', () => {
    const recordAppDiagnostic = jest.fn();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    const dispose = registerRendererDiagnosticsHandler({ recordAppDiagnostic });
    try {
      ipcMain.emit(IPC_CHANNELS.observabilityRecordRendererSummary, {}, valid);
      ipcMain.emit(
        IPC_CHANNELS.observabilityRecordRendererSummary,
        {},
        { ...valid, chatId: 'secret' },
      );
      expect(recordAppDiagnostic).toHaveBeenCalledTimes(1);
      expect(recordAppDiagnostic).toHaveBeenCalledWith({
        version: 1,
        timestamp: '2026-10-14T00:00:00.000Z',
        kind: 'renderer_frame_summary',
        rendererSummary: valid,
      });
    } finally {
      dispose();
      jest.useRealTimers();
    }
  });
});
