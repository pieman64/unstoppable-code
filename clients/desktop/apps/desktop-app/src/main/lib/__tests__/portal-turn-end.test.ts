import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { projectPortalLastTurnEnd } from '../portal-turn-end';

function tab(fields: Partial<PersistedChatTab>): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    ...fields,
  };
}

describe('projectPortalLastTurnEnd', () => {
  it('projects the latest accepted turn end', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-2',
          turnEnds: {
            'user-1': { outcome: 'completed', endedAt: 1_000 },
            'user-2': { outcome: 'cancelled', endedAt: 1_792_521_096_000 },
          },
        }),
      ),
    ).toEqual({
      userMessageId: 'user-2',
      outcome: 'cancelled',
      endedAt: '2026-10-20T18:31:36.000Z',
    });
  });

  it('names a later prompt that ended before any provider accepted it', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-1',
          unacceptedTurnEnds: { 'user-0': 'failed', 'user-2': 'failed' },
          turnEnds: {
            'user-0': { outcome: 'failed', endedAt: 500 },
            'user-1': { outcome: 'completed', endedAt: 1_000 },
            'user-2': { outcome: 'failed', endedAt: 2_000 },
          },
        }),
      ),
    ).toEqual({
      userMessageId: 'user-2',
      outcome: 'failed',
      endedAt: new Date(2_000).toISOString(),
    });
  });

  it('names the later of prompts that ended at the same time', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-1',
          unacceptedTurnEnds: { 'user-2': 'failed', 'user-3': 'failed' },
          turnEnds: {
            'user-1': { outcome: 'completed', endedAt: 1_000 },
            'user-2': { outcome: 'failed', endedAt: 2_000 },
            'user-3': { outcome: 'failed', endedAt: 2_000 },
          },
        }),
      ),
    ).toMatchObject({ userMessageId: 'user-3', outcome: 'failed' });
  });

  it('keeps the accepted turn over an earlier unaccepted end', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-1',
          unacceptedTurnEnds: { 'user-0': 'cancelled' },
          turnEnds: {
            'user-0': { outcome: 'cancelled', endedAt: 500 },
            'user-1': { outcome: 'completed', endedAt: 1_000 },
          },
        }),
      ),
    ).toMatchObject({ userMessageId: 'user-1', outcome: 'completed' });
  });

  it('names a first prompt that ended before any provider accepted it', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          unacceptedTurnEnds: { 'user-1': 'cancelled' },
          turnEnds: { 'user-1': { outcome: 'cancelled', endedAt: 1_000 } },
        }),
      ),
    ).toMatchObject({ userMessageId: 'user-1', outcome: 'cancelled' });
  });

  it('omits an end while the accepted turn has none, since it may still run', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-3',
          unacceptedTurnEnds: { 'user-2': 'failed' },
          turnEnds: { 'user-2': { outcome: 'failed', endedAt: 2_000 } },
        }),
      ),
    ).toBeUndefined();
  });

  it('omits an end that belongs to an earlier turn or is missing', () => {
    expect(
      projectPortalLastTurnEnd(
        tab({
          lastAcceptedUserMessageId: 'user-2',
          turnEnds: { 'user-1': { outcome: 'failed', endedAt: 1_000 } },
        }),
      ),
    ).toBeUndefined();
    expect(projectPortalLastTurnEnd(tab({}))).toBeUndefined();
  });
});
