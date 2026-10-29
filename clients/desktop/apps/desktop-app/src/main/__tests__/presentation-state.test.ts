import {
  acceptTerminalPresentationTurn,
  cancelTerminalPresentationTurn,
  capturePresentationTurn,
  clearPresentationTurn,
  presentationChatKey,
  recordPresentationTurn,
  showFilesPresentationPolicy,
  resolvePresentationSource,
  stageTerminalPresentationTurn,
} from '../canopy-tools/presentation-state';
import type { UsageInitiationSource } from '@canopy/desktop-shared/types';

const origin = { projectId: 'project', worktreeId: 'tree', chatTabId: 'chat' };
const key = presentationChatKey(origin);

afterEach(() => clearPresentationTurn(key));

describe('trusted file presentation', () => {
  const sources: (UsageInitiationSource | undefined)[] = [
    'user',
    'portal',
    'automation',
    'hook',
    'app_advisor',
    undefined,
  ];
  it.each(sources)(
    'explicit user interaction wins over %s and a pin',
    (source) => {
      expect(
        showFilesPresentationPolicy({
          intent: 'user',
          source,
          handoffId: 'pin',
        }),
      ).toEqual({ presentation: 'foreground' });
    },
  );
  it.each(['automation', 'hook'] as const)(
    '%s deferral wins over handoff background placement',
    (source) => {
      expect(
        showFilesPresentationPolicy({
          intent: 'agent',
          source,
          handoffId: 'pin',
        }),
      ).toEqual({ presentation: 'deferred', reason: 'automation_turn' });
    },
  );
  it.each(['user', 'portal', 'app_advisor'] as const)(
    '%s follows handoff policy',
    (source) => {
      expect(
        showFilesPresentationPolicy({
          intent: 'agent',
          source,
          handoffId: 'pin',
        }),
      ).toEqual({
        presentation: 'background',
        reason: 'browser_handoff',
        handoffId: 'pin',
      });
      expect(showFilesPresentationPolicy({ intent: 'agent', source })).toEqual({
        presentation: 'foreground',
      });
    },
  );
  it('recognizes trusted automation markers even when legacy turn metadata is absent', () => {
    expect(
      resolvePresentationSource({ automationName: 'Scheduled run' }, 'user'),
    ).toBe('automation');
    expect(resolvePresentationSource({}, 'portal')).toBe('portal');
  });

  it('captures provenance immutably across replacement and stale cleanup', () => {
    recordPresentationTurn(key, 'scheduled', 'automation');
    const captured = capturePresentationTurn(origin);
    recordPresentationTurn(key, 'user-reply', 'user');
    clearPresentationTurn(key, 'scheduled');
    expect(captured?.source).toBe('automation');
    expect(capturePresentationTurn(origin)?.source).toBe('user');
    clearPresentationTurn(key, 'user-reply');
    expect(
      showFilesPresentationPolicy({
        intent: 'agent',
        source: capturePresentationTurn(origin)?.source,
      }).presentation,
    ).toBe('deferred');
  });
  it('does not let human input consume a queued or dropped scheduled admission', () => {
    stageTerminalPresentationTurn(key, 'scheduled', 'automation');
    expect(acceptTerminalPresentationTurn(key, 'human').source).toBe('user');
    expect(acceptTerminalPresentationTurn(key, 'scheduled').source).toBe(
      'automation',
    );
    stageTerminalPresentationTurn(key, 'dropped', 'automation');
    expect(acceptTerminalPresentationTurn(key, 'next-human').source).toBe(
      'user',
    );
    cancelTerminalPresentationTurn(key, 'dropped');
  });

  it('keeps consecutive accepted terminal schedules in order through relaunch cleanup', () => {
    stageTerminalPresentationTurn(key, 'first', 'automation');
    stageTerminalPresentationTurn(key, 'second', 'automation');
    clearPresentationTurn(key);
    expect(acceptTerminalPresentationTurn(key, 'first')).toEqual({
      turnId: 'first',
      source: 'automation',
    });
    clearPresentationTurn(key, 'first');
    expect(acceptTerminalPresentationTurn(key, 'second')).toEqual({
      turnId: 'second',
      source: 'automation',
    });
    expect(acceptTerminalPresentationTurn(key, 'human').source).toBe('user');
  });

  it('retains scheduled terminal admission across old-runtime cleanup, consumes it once, and returns to user input', () => {
    stageTerminalPresentationTurn(key, 'scheduled', 'automation');
    clearPresentationTurn(key);
    expect(acceptTerminalPresentationTurn(key, 'scheduled')).toEqual({
      turnId: 'scheduled',
      source: 'automation',
    });
    clearPresentationTurn(key, 'scheduled');
    expect(acceptTerminalPresentationTurn(key, 'human')).toEqual({
      turnId: 'human',
      source: 'user',
    });
    stageTerminalPresentationTurn(key, 'failed', 'automation');
    cancelTerminalPresentationTurn(key, 'failed');
    expect(acceptTerminalPresentationTurn(key, 'next-human').source).toBe(
      'user',
    );
  });
});
