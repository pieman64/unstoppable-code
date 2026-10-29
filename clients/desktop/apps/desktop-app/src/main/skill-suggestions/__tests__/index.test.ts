import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSuggestionChangedEvent } from '@canopy/desktop-shared/lib/skill-suggestions';
import { normalizePromptTokens } from '../normalize';
import { storedSuggestion } from './fixtures';

const mockState = {
  dir: '',
  flag: true,
  snapshotListener: null as (() => void) | null,
};

jest.mock('../../lib/paths', () => ({
  getSkillSuggestionFingerprintsFilePath: (): string =>
    `${mockState.dir}/derived/fingerprints.jsonl`,
  getSkillSuggestionsStateFilePath: (): string =>
    `${mockState.dir}/skill-suggestions.json`,
  getSkillSuggestionsHelperDir: (): string => `${mockState.dir}/helper`,
  getWorkspacesRootDir: (): string => `${mockState.dir}/workspaces`,
  getWorkspaceChatTabsFilePath: (): string => `${mockState.dir}/tabs.json`,
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({
    isEnabled: (): boolean => mockState.flag,
    onSnapshotChanged: (listener: () => void): (() => void) => {
      mockState.snapshotListener = listener;
      return () => {
        mockState.snapshotListener = null;
      };
    },
  }),
}));
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({
  getAllActiveSessionInfos: (): unknown[] => [
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat-1' },
  ],
  hasActiveChatTurns: (): boolean => false,
  subscribeChatSessionActivity: (): (() => void) => () => undefined,
}));
jest.mock('../../agents/skill-share-nudge-state', () => ({
  skillShareNudgeState: { hasPending: (): boolean => false },
}));
jest.mock('../../lib/desktop-telemetry', () => ({
  recordSkillSuggestionTelemetry: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve({ skillSuggestionsEnabled: true }),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: () => ({ organizations: [] }),
  }),
}));
jest.mock('../partition', () => ({
  ...jest.requireActual<object>('../partition'),
  resolveTurnPartition: (): Promise<unknown> =>
    Promise.resolve({
      key: 'personal',
      owner: { kind: 'personal' },
      privateWorkspaceId: null,
    }),
}));
jest.mock('../../lib/background-helper-queue', () => ({
  BACKGROUND_HELPER_PRIORITIES: { skillSuggestions: 5 },
  enqueueBackgroundHelperTask: jest.fn(),
}));

import { resetSkillSuggestionsGateForTests } from '../feature-gate';
import { getFingerprintStore } from '../fingerprint-store';
import {
  applySkillSuggestionsPreference,
  handleRecordedTurn,
  purgeSkillSuggestionsForWorkspace,
  skillSuggestionSurfacing,
  startSkillSuggestions,
  stopSkillSuggestions,
} from '../index';
import { getSkillSuggestionsRegistry } from '../registry';
import { skillSuggestionTurnRecorder } from '../turn-recorder';

const PROMPT = 'Summarize the weekly release notes for the mobile app';
const origin = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat-1' };

function recorded(messageId: string): Parameters<typeof handleRecordedTurn>[0] {
  return {
    ...origin,
    userMessageId: messageId,
    auditEntryId: `audit-${messageId}`,
    promptText: PROMPT,
    startedAt: 1,
    completedAt: Date.now(),
    tools: [],
    status: 'success',
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('skill suggestions wiring', () => {
  let events: SkillSuggestionChangedEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    mockState.dir = await mkdtemp(join(tmpdir(), 'skill-index-'));
    mockState.flag = true;
    resetSkillSuggestionsGateForTests();
    getSkillSuggestionsRegistry().resetCacheForTests();
    await getFingerprintStore().clear();
    startSkillSuggestions();
    await getSkillSuggestionsRegistry().update((draft) => {
      draft.backfill = { done: true, nextChatIndex: 0 };
      draft.suggestions = [
        storedSuggestion({
          members: [{ tokens: normalizePromptTokens(PROMPT), tools: [] }],
          matchedTurnIds: ['a', 'b', 'c'],
          lastMatchedAt: Date.now(),
        }),
        storedSuggestion({
          id: 'resolved',
          state: 'dismissed',
          proposedSkillName: 'old',
        }),
      ];
      return true;
    });
    events = [];
    unsubscribe = skillSuggestionSurfacing.subscribe((event) =>
      events.push(event),
    );
  });
  afterEach(async () => {
    unsubscribe();
    stopSkillSuggestions();
    await rm(mockState.dir, { recursive: true, force: true });
  });

  it('records a live turn and surfaces its banner', async () => {
    await handleRecordedTurn(recorded('m1'));
    expect(
      skillSuggestionSurfacing.getPending(origin, 1)?.suggestion
        .occurrenceCount,
    ).toBe(4);
    const raw = await readFile(
      `${mockState.dir}/derived/fingerprints.jsonl`,
      'utf8',
    );
    expect(raw).toContain('"userMessageId":"m1"');
  });

  it('applies a live kill switch without losing stored state', async () => {
    await handleRecordedTurn(recorded('m1'));
    events = [];
    mockState.flag = false;
    mockState.snapshotListener?.();
    expect(events).toEqual([{ origin }, {}]);
    expect(skillSuggestionSurfacing.getPending(origin, 1)).toBeNull();
    expect(await skillSuggestionSurfacing.list()).toEqual([]);

    // Recording stops at begin.
    const sink = jest.spyOn(getFingerprintStore(), 'append');
    skillSuggestionTurnRecorder.begin('chat:ws/wt/chat-1', 'audit-x', {
      ...origin,
      userMessageId: 'm2',
      originalUserText: PROMPT,
      skillSuggestionEligible: true,
    });
    skillSuggestionTurnRecorder.complete(
      'chat:ws/wt/chat-1',
      'audit-x',
      'success',
    );
    await flush();
    expect(sink).not.toHaveBeenCalled();
    sink.mockRestore();

    // Resolution retries still drain.
    expect(
      await skillSuggestionSurfacing.resolve(
        {
          source: 'suggestions_modal',
          suggestionId: 'suggestion-1',
          resolution: 'dismissed',
        },
        1,
      ),
    ).toBe(true);

    // Data is kept and the backfill does not re-run when the flag returns.
    mockState.flag = true;
    mockState.snapshotListener?.();
    const state = await getSkillSuggestionsRegistry().read();
    expect(state.backfill.done).toBe(true);
    expect(state.suggestions).toHaveLength(2);
  });

  it('purges local data when the preference turns off', async () => {
    await handleRecordedTurn(recorded('m1'));
    applySkillSuggestionsPreference(false);
    const fingerprintsPresent = (): Promise<boolean> =>
      readFile(`${mockState.dir}/derived/fingerprints.jsonl`, 'utf8').then(
        () => true,
        () => false,
      );
    // The purge runs on real files; poll rather than race it under load.
    for (let i = 0; i < 50 && (await fingerprintsPresent()); i += 1) {
      await flush();
    }
    expect(await fingerprintsPresent()).toBe(false);
    let state = await getSkillSuggestionsRegistry().read();
    for (let i = 0; i < 50 && state.backfill.done; i += 1) {
      await flush();
      state = await getSkillSuggestionsRegistry().read();
    }
    expect(state.suggestions.map((entry) => entry.id)).toEqual(['resolved']);
    expect(state.backfill).toEqual({ done: false, nextChatIndex: 0 });
    expect(skillSuggestionSurfacing.getPending(origin, 1)).toBeNull();
  });

  it('does not extend the chat chain again for a re-recorded turn', async () => {
    const withSkill = { ...recorded('m-skill'), tools: ['skill:review'] };
    await handleRecordedTurn(withSkill);
    await handleRecordedTurn(withSkill);
    const chains = (await getFingerprintStore().read()).filter(
      (row) => row.kind === 'chat_chain' && row.chatId === origin.chatId,
    );
    expect(chains.at(-1)).toMatchObject({ skills: ['review'] });
  });

  it('writes no chain row once the preference turns off mid-turn', async () => {
    const store = getFingerprintStore();
    const append = store.append.bind(store);
    jest.spyOn(store, 'append').mockImplementationOnce(async (rows) => {
      const written = await append(rows);
      applySkillSuggestionsPreference(false);
      return written;
    });
    await handleRecordedTurn({
      ...recorded('m-off'),
      tools: ['skill:review'],
    });
    let state = await getSkillSuggestionsRegistry().read();
    for (let i = 0; i < 50 && state.backfill.done; i += 1) {
      await flush();
      state = await getSkillSuggestionsRegistry().read();
    }
    await flush();
    expect(
      (await store.read()).filter((row) => row.kind === 'chat_chain'),
    ).toEqual([]);
  });

  it('still purges suggestions when the fingerprint purge fails', async () => {
    const failure = new Error('EIO');
    jest
      .spyOn(getFingerprintStore(), 'purgeWorkspace')
      .mockRejectedValueOnce(failure);
    await getSkillSuggestionsRegistry().update((draft) => {
      draft.suggestions.push(
        storedSuggestion({
          id: 'private',
          proposedSkillName: 'private-one',
          partition: 'personal/private:ws-gone',
        }),
      );
      return true;
    });
    await expect(purgeSkillSuggestionsForWorkspace('ws-gone')).rejects.toBe(
      failure,
    );
    const state = await getSkillSuggestionsRegistry().read();
    expect(state.suggestions.map((entry) => entry.id)).not.toContain('private');
  });

  it('still clears open suggestions when the fingerprint delete fails', async () => {
    const fingerprints = `${mockState.dir}/derived/fingerprints.jsonl`;
    // A non-empty directory in its place makes the delete throw.
    await mkdir(`${fingerprints}/locked`, { recursive: true });
    applySkillSuggestionsPreference(false);
    let state = await getSkillSuggestionsRegistry().read();
    for (let i = 0; i < 50 && state.backfill.done; i += 1) {
      await flush();
      state = await getSkillSuggestionsRegistry().read();
    }
    expect(state.suggestions.map((entry) => entry.id)).toEqual(['resolved']);
    expect(state.backfill).toEqual({ done: false, nextChatIndex: 0 });
  });
});
