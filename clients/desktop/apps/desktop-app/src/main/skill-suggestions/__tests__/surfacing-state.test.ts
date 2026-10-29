import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSuggestionOrigin } from '@canopy/desktop-shared/lib/skill-suggestions';
import { chainMatchId, turnMatchId } from '../fingerprint-store';
import { normalizePromptTokens } from '../normalize';
import {
  SkillSuggestionsRegistry,
  type StoredSkillSuggestion,
} from '../registry';
import {
  BANNER_COOLDOWN_MS,
  SkillSuggestionSurfacingState,
  SUGGESTION_IDLE_EXPIRY_MS,
  type SurfacingTurn,
} from '../surfacing-state';
import { storedSuggestion } from './fixtures';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const PROMPT = 'Summarize the weekly release notes for the mobile app';

let dir: string;
let registry: SkillSuggestionsRegistry;
let now: number;
let enabled: boolean;
let sharePending: boolean;
let organizations: Map<string, string>;
let actions: Array<[string, number]>;
let state: SkillSuggestionSurfacingState;

function origin(chatId: string): SkillSuggestionOrigin {
  return { projectId: 'ws', worktreeId: 'wt', chatId };
}

function turn(
  chatId: string,
  text = PROMPT,
  messageId = `${chatId}-m`,
): SurfacingTurn {
  return {
    origin: origin(chatId),
    partition: 'personal',
    turnId: turnMatchId({ projectId: 'ws', chatId, userMessageId: messageId }),
    chainId: chainMatchId({ projectId: 'ws', chatId }),
    shape: { tokens: normalizePromptTokens(text), tools: [] },
    chain: null,
  };
}

async function seed(...suggestions: StoredSkillSuggestion[]): Promise<void> {
  await registry.update((draft) => {
    draft.suggestions = suggestions;
    return true;
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-surfacing-'));
  registry = new SkillSuggestionsRegistry(() => join(dir, 'state.json'));
  now = 100 * DAY;
  enabled = true;
  sharePending = false;
  organizations = new Map([['org-1', 'Acme']]);
  actions = [];
  state = new SkillSuggestionSurfacingState({
    registry,
    isEnabled: (): boolean => enabled,
    now: (): number => now,
    isShareNudgePending: (): boolean => sharePending,
    memberOrganizations: (): Map<string, string> => organizations,
    onAction: (action, count): void => {
      actions.push([action, count]);
    },
  });
  await seed(
    storedSuggestion({
      members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
      matchedTurnIds: ['a', 'b', 'c'],
      lastMatchedAt: now,
    }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('skill suggestion surfacing', () => {
  it('surfaces a repeat and counts it once', async () => {
    const events: unknown[] = [];
    state.subscribe((event) => events.push(event));
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    expect(pending?.suggestion.occurrenceCount).toBe(4);
    expect(events).toEqual([{ origin: origin('chat-1') }]);
    await state.matchTurn(turn('chat-1'));
    expect((await registry.read()).suggestions[0]?.matchedTurnIds).toHaveLength(
      4,
    );
  });

  it('needs the score threshold and three shared content tokens', async () => {
    await state.matchTurn(turn('chat-1', 'Write a haiku about autumn leaves'));
    await state.matchTurn(turn('chat-2', 'summarize release'));
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
    expect(state.getPending(origin('chat-2'), 1)).toBeNull();
    expect((await registry.read()).suggestions[0]?.matchedTurnIds).toHaveLength(
      3,
    );
  });

  it('matches a chain suggestion on the chat chain suffix', async () => {
    await seed(
      storedSuggestion({
        kind: 'chain',
        chainSkills: ['review', 'push-branch'],
        members: [],
        lastMatchedAt: now,
      }),
    );
    await state.matchTurn({
      ...turn('chat-1'),
      chain: ['lint', 'review', 'push-branch'],
    });
    expect(state.getPending(origin('chat-1'), 1)?.suggestion.kind).toBe(
      'chain',
    );
    await state.matchTurn({
      ...turn('chat-2'),
      chain: ['review', 'push-branch', 'lint'],
    });
    expect(state.getPending(origin('chat-2'), 1)).toBeNull();
  });

  it('does not surface a chain again for a chat already counted', async () => {
    await seed(
      storedSuggestion({
        kind: 'chain',
        chainSkills: ['review', 'push-branch'],
        members: [],
        lastMatchedAt: now,
      }),
    );
    const chainTurn = { ...turn('chat-1'), chain: ['review', 'push-branch'] };
    await state.matchTurn(chainTurn);
    expect(state.getPending(origin('chat-1'), 1)).not.toBeNull();
    state.clear(origin('chat-1'));
    await state.matchTurn(chainTurn);
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('drops unrendered banners in other chats once one is shown', async () => {
    await state.matchTurn(turn('chat-1'));
    await state.matchTurn(turn('chat-2'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    expect(state.getPending(origin('chat-2'), 1)).not.toBeNull();
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    expect(state.getPending(origin('chat-2'), 1)).toBeNull();
    expect(state.getPending(origin('chat-1'), 1)?.state).toBe('shown');
  });

  it('records a decision on the third banner after it expired by shows', async () => {
    await seed(
      storedSuggestion({
        members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
        showCount: 2,
        lastMatchedAt: now,
      }),
    );
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    const banner = {
      ...origin('chat-1'),
      source: 'banner' as const,
      pendingId: pending.id,
      suggestionId: pending.suggestion.id,
    };
    await state.resolve({ ...banner, resolution: 'shown' }, 1);
    // Another turn expires the suggestion while its banner is on screen.
    await state.matchTurn(turn('chat-2'));
    expect((await registry.read()).suggestions[0]?.state).toBe('expired');
    await state.resolve({ ...banner, resolution: 'dismissed' }, 1);
    expect((await registry.read()).suggestions[0]?.state).toBe('dismissed');
  });

  it('does not count a dismissal of a deleted suggestion toward the pause', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await seed();
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'dismissed',
      },
      1,
    );
    expect((await registry.read()).consecutiveBannerDismissals).toBe(0);
  });

  it('does not count a banner dismissal of a suggestion resolved elsewhere', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await registry.update((draft) => {
      const stored = draft.suggestions[0];
      if (stored) stored.state = 'accepted';
      return true;
    });
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'dismissed',
      },
      1,
    );
    expect((await registry.read()).consecutiveBannerDismissals).toBe(0);
  });

  it('does not spend the daily banner slot on a resolved suggestion', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await registry.update((draft) => {
      const stored = draft.suggestions[0];
      if (stored) stored.state = 'dismissed';
      return true;
    });
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    expect((await registry.read()).lastBannerShownAt).toBeNull();
  });

  it('records no decision for a suggestion that no longer exists', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await registry.update((draft) => {
      draft.consecutiveBannerDismissals = 2;
      draft.suggestions = [];
      return true;
    });
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'accepted',
      },
      1,
    );
    expect(actions).toEqual([]);
    expect((await registry.read()).consecutiveBannerDismissals).toBe(2);
  });

  it('drops even a shown banner for a removed suggestion', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    state.dropPendingForSuggestions([pending.suggestion.id]);
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('keeps one pending suggestion per chat', async () => {
    await state.matchTurn(turn('chat-1'));
    const first = state.getPending(origin('chat-1'), 1);
    await state.matchTurn(turn('chat-1', PROMPT, 'second'));
    expect(state.getPending(origin('chat-1'), 1)?.id).toBe(first?.id);
  });

  it('shows at most one banner a day', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    await state.matchTurn(turn('chat-2'));
    expect(state.getPending(origin('chat-2'), 1)).toBeNull();
    now += BANNER_COOLDOWN_MS;
    await state.matchTurn(turn('chat-3'));
    expect(state.getPending(origin('chat-3'), 1)).not.toBeNull();
    expect(actions).toEqual([['shown', 4]]);
  });

  it('counts a repeated shown report from the same window once', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    const shown = {
      ...origin('chat-1'),
      source: 'banner' as const,
      pendingId: pending.id,
      suggestionId: pending.suggestion.id,
      resolution: 'shown' as const,
    };
    expect(await state.resolve(shown, 1)).toBe(true);
    expect(await state.resolve(shown, 1)).toBe(true);
    expect((await registry.read()).suggestions[0]?.showCount).toBe(1);
  });

  it('claims a shown banner for one window', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    expect(state.getPending(origin('chat-1'), 2)).toBeNull();
    expect(state.getPending(origin('chat-1'), 1)?.state).toBe('shown');
  });

  it('does not surface while a share nudge is pending', async () => {
    sharePending = true;
    await state.matchTurn(turn('chat-1'));
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('expires after three shows or thirty idle days', async () => {
    await seed(
      storedSuggestion({
        id: 'shown-out',
        members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
        showCount: 3,
        lastMatchedAt: now,
      }),
      storedSuggestion({
        id: 'idle',
        proposedSkillName: 'idle',
        lastMatchedAt: now - SUGGESTION_IDLE_EXPIRY_MS - 1,
      }),
    );
    await state.matchTurn(turn('chat-1'));
    const stored = (await registry.read()).suggestions;
    expect(stored.map((entry) => entry.state)).toEqual(['expired', 'expired']);
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('broadcasts an expiry so open lists drop the suggestion', async () => {
    await seed(
      storedSuggestion({
        id: 'idle',
        proposedSkillName: 'idle',
        lastMatchedAt: now - SUGGESTION_IDLE_EXPIRY_MS - 1,
      }),
    );
    const events: unknown[] = [];
    state.subscribe((event) => events.push(event));
    await state.matchTurn(turn('chat-unrelated', 'something else entirely'));
    expect((await registry.read()).suggestions[0]?.state).toBe('expired');
    expect(events).toContainEqual({});
  });

  it('a stale shown report has no side effects', async () => {
    await state.matchTurn(turn('chat-1'));
    const pending = state.getPending(origin('chat-1'), 1);
    if (!pending) throw new Error('expected a pending suggestion');
    await registry.update((draft) => {
      const stored = draft.suggestions[0];
      if (stored) stored.state = 'expired';
      return true;
    });
    await state.resolve(
      {
        ...origin('chat-1'),
        source: 'banner',
        pendingId: pending.id,
        suggestionId: pending.suggestion.id,
        resolution: 'shown',
      },
      1,
    );
    expect(actions).toEqual([]);
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('pauses only the banner after three consecutive banner dismissals', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed(
        storedSuggestion({
          id: `s${i}`,
          members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
          lastMatchedAt: now,
        }),
      );
      await registry.update((draft) => {
        draft.lastBannerShownAt = null;
        return true;
      });
      await state.matchTurn(turn(`chat-${i}`));
      const pending = state.getPending(origin(`chat-${i}`), 1);
      if (!pending) throw new Error('expected a pending suggestion');
      await state.resolve(
        {
          ...origin(`chat-${i}`),
          source: 'banner',
          pendingId: pending.id,
          suggestionId: pending.suggestion.id,
          resolution: 'dismissed',
        },
        1,
      );
    }
    const paused = await registry.read();
    expect(paused.bannerPausedUntil).toBeGreaterThan(now);
    await seed(
      storedSuggestion({
        id: 'later',
        members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
        lastMatchedAt: now,
      }),
    );
    await state.matchTurn(turn('chat-9'));
    expect(state.getPending(origin('chat-9'), 1)).toBeNull();
    expect(await state.list()).toHaveLength(1);
  });

  it('resets the dismissal counter on accept and ignores modal dismissals', async () => {
    await registry.update((draft) => {
      draft.consecutiveBannerDismissals = 2;
      return true;
    });
    await state.resolve(
      {
        source: 'suggestions_modal',
        suggestionId: 'suggestion-1',
        resolution: 'dismissed',
      },
      1,
    );
    expect((await registry.read()).consecutiveBannerDismissals).toBe(2);
    await seed(storedSuggestion({ id: 'next', lastMatchedAt: now }));
    await state.resolve(
      {
        source: 'suggestions_modal',
        suggestionId: 'next',
        resolution: 'accepted',
      },
      1,
    );
    expect((await registry.read()).consecutiveBannerDismissals).toBe(0);
  });

  it('resolves globally from the modal and clears every chat', async () => {
    await state.matchTurn(turn('chat-1'));
    const events: unknown[] = [];
    state.subscribe((event) => events.push(event));
    expect(
      await state.resolve(
        {
          source: 'suggestions_modal',
          suggestionId: 'suggestion-1',
          resolution: 'dismissed',
        },
        7,
      ),
    ).toBe(true);
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
    expect(events).toEqual([{ origin: origin('chat-1') }, {}]);
    expect(await state.list()).toEqual([]);
  });

  it('lists open suggestions without examples for private work and hides left orgs', async () => {
    await seed(
      storedSuggestion({ id: 'open', lastMatchedAt: 3 }),
      storedSuggestion({
        id: 'private',
        partition: 'personal/private:ws',
        lastMatchedAt: 2,
      }),
      storedSuggestion({ id: 'org', partition: 'org:org-1', lastMatchedAt: 1 }),
      storedSuggestion({ id: 'left', partition: 'org:org-2' }),
      storedSuggestion({ id: 'done', state: 'dismissed' }),
    );
    const listed = await state.list();
    expect(listed.map((entry) => entry.id)).toEqual(['open', 'private', 'org']);
    expect(listed[1]).toMatchObject({ isPrivate: true, examples: [] });
    expect(listed[2]?.ownerLabel).toBe('Acme');
  });

  it('returns nothing while the gate is closed and clears on request', async () => {
    await state.matchTurn(turn('chat-1'));
    enabled = false;
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
    expect(await state.list()).toEqual([]);
    const events: unknown[] = [];
    state.subscribe((event) => events.push(event));
    state.clearAll();
    expect(events).toEqual([{ origin: origin('chat-1') }, {}]);
    enabled = true;
    expect(state.getPending(origin('chat-1'), 1)).toBeNull();
  });

  it('still resolves while the gate is closed', async () => {
    enabled = false;
    expect(
      await state.resolve(
        {
          source: 'suggestions_modal',
          suggestionId: 'suggestion-1',
          resolution: 'accepted',
        },
        1,
      ),
    ).toBe(true);
  });
});
