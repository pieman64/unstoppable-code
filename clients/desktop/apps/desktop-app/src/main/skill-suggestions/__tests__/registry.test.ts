import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnMatchId } from '../fingerprint-store';
import {
  addMatchedTurn,
  emptySkillSuggestionsFile,
  parseSkillSuggestionsFile,
  purgeWorkspaceFromState,
  resetForPreferenceOff,
  resolveStoredSuggestion,
  SkillSuggestionsRegistry,
} from '../registry';
import { storedSuggestion } from './fixtures';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-suggestions-'));
  path = join(dir, 'skill-suggestions.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('skill suggestions registry', () => {
  it('replaces a corrupt or unknown-version file with the empty default', async () => {
    await writeFile(path, '{nope');
    expect(await new SkillSuggestionsRegistry(() => path).read()).toEqual(
      emptySkillSuggestionsFile(),
    );
    await writeFile(path, JSON.stringify({ version: 2, suggestions: [] }));
    expect(await new SkillSuggestionsRegistry(() => path).read()).toEqual(
      emptySkillSuggestionsFile(),
    );
  });

  it('writes atomically and persists the backfill cursor', async () => {
    const registry = new SkillSuggestionsRegistry(() => path);
    await registry.update((draft) => {
      draft.backfill = {
        done: false,
        nextChatIndex: 7,
        chatIdsSnapshot: ['a'],
      };
      draft.suggestions.push(storedSuggestion());
      return true;
    });
    const persisted: unknown = JSON.parse(await readFile(path, 'utf8'));
    const reread = parseSkillSuggestionsFile(persisted);
    expect(reread?.backfill).toEqual({
      done: false,
      nextChatIndex: 7,
      chatIdsSnapshot: ['a'],
    });
    expect(reread?.suggestions).toHaveLength(1);
  });

  it('leaves the cache untouched when a write fails', async () => {
    const registry = new SkillSuggestionsRegistry(() => path);
    await registry.update((draft) => {
      draft.suggestions.push(storedSuggestion());
      return true;
    });
    await rm(path);
    await mkdir(path);
    await expect(
      registry.update((draft) => {
        draft.suggestions = [];
        return true;
      }),
    ).rejects.toThrow();
    expect((await registry.read()).suggestions).toHaveLength(1);
  });

  it('skips the write when the mutator returns false', async () => {
    const registry = new SkillSuggestionsRegistry(() => path);
    expect(await registry.update(() => false)).toBe(false);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('never counts a matched turn twice', () => {
    const suggestion = storedSuggestion();
    const id = turnMatchId({
      projectId: 'ws',
      chatId: 'c',
      userMessageId: 'm',
    });
    expect(addMatchedTurn(suggestion, id, 5)).toBe(true);
    expect(addMatchedTurn(suggestion, id, 6)).toBe(false);
    expect(suggestion.matchedTurnIds).toEqual([id]);
    expect(suggestion.lastMatchedAt).toBe(5);
    const parsed = parseSkillSuggestionsFile({
      version: 1,
      suggestions: [{ ...storedSuggestion(), matchedTurnIds: [id, id] }],
    });
    expect(parsed?.suggestions[0]?.matchedTurnIds).toEqual([id]);
  });

  it('strips examples on resolution and for private partitions', () => {
    const suggestion = storedSuggestion();
    resolveStoredSuggestion(suggestion, 'dismissed', 9);
    expect(suggestion).toMatchObject({
      state: 'dismissed',
      resolvedAt: 9,
      exemplars: [],
      members: [],
    });
    const parsed = parseSkillSuggestionsFile({
      version: 1,
      suggestions: [storedSuggestion({ partition: 'personal/private:ws-1' })],
    });
    expect(parsed?.suggestions[0]?.exemplars).toEqual([]);
  });

  it('drops open suggestions and resets the cursor when the preference turns off', () => {
    const state = emptySkillSuggestionsFile();
    state.suggestions = [
      storedSuggestion({ id: 'open' }),
      storedSuggestion({ id: 'shown', state: 'shown' }),
      storedSuggestion({ id: 'dismissed', state: 'dismissed' }),
      storedSuggestion({ id: 'accepted', state: 'accepted' }),
    ];
    state.backfill = { done: true, nextChatIndex: 300 };
    state.lastScanAt = { personal: 1 };
    expect(resetForPreferenceOff(state)).toBe(true);
    expect(state.suggestions.map((entry) => entry.id)).toEqual([
      'dismissed',
      'accepted',
    ]);
    expect(state.backfill).toEqual({ done: false, nextChatIndex: 0 });
    expect(state.lastScanAt).toEqual({});
    // An already-reset state reports no change, so startup skips the write.
    expect(resetForPreferenceOff(state)).toBe(false);
  });

  it('purges a deleted workspace from suggestions and their matches', () => {
    const state = emptySkillSuggestionsFile();
    const kept = turnMatchId({
      projectId: 'ws-1',
      chatId: 'c',
      userMessageId: 'm',
    });
    const dropped = turnMatchId({
      projectId: 'ws-2',
      chatId: 'c2',
      userMessageId: 'm2',
    });
    const others = [
      turnMatchId({ projectId: 'ws-1', chatId: 'c', userMessageId: 'm3' }),
      turnMatchId({ projectId: 'ws-3', chatId: 'c3', userMessageId: 'm4' }),
    ];
    state.suggestions = [
      storedSuggestion({ id: 'a', matchedTurnIds: [kept, dropped, ...others] }),
      storedSuggestion({ id: 'b', partition: 'org:o/private:ws-2' }),
    ];
    expect(purgeWorkspaceFromState(state, 'ws-2', 5)).toEqual({
      suggestionsRemoved: 1,
      matchesRemoved: 1,
    });
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0]?.matchedTurnIds).toEqual([kept, ...others]);
    // Examples may have come from the deleted workspace.
    expect(state.suggestions[0]?.exemplars).toEqual([]);
  });

  it('drops an open suggestion the purge leaves below its group rule', () => {
    const state = emptySkillSuggestionsFile();
    const fromDeleted = ['m1', 'm2', 'm3'].map((userMessageId, index) =>
      turnMatchId({ projectId: 'ws-2', chatId: `c${index}`, userMessageId }),
    );
    const survivor = turnMatchId({
      projectId: 'ws-1',
      chatId: 'c',
      userMessageId: 'm',
    });
    state.suggestions = [
      storedSuggestion({ id: 'open', matchedTurnIds: fromDeleted }),
      storedSuggestion({
        id: 'partial',
        proposedSkillName: 'partial',
        matchedTurnIds: [survivor, ...fromDeleted],
      }),
      storedSuggestion({
        id: 'resolved',
        proposedSkillName: 'resolved',
        state: 'dismissed',
        matchedTurnIds: fromDeleted,
      }),
    ];
    expect(purgeWorkspaceFromState(state, 'ws-2', 5)).toEqual({
      suggestionsRemoved: 2,
      matchesRemoved: 9,
    });
    // A resolved suggestion stays so dismissed work is not proposed again.
    expect(state.suggestions.map((entry) => entry.id)).toEqual(['resolved']);
  });

  it('clears member tokens of a suggestion that lost matches and spares others', () => {
    const state = emptySkillSuggestionsFile();
    const ids = (projectId: string): string[] =>
      ['m1', 'm2', 'm3'].map((userMessageId, index) =>
        turnMatchId({ projectId, chatId: `c${index}`, userMessageId }),
      );
    const member = { tokens: ['weekly', 'report'], tools: [] };
    state.suggestions = [
      storedSuggestion({
        id: 'touched',
        members: [member],
        matchedTurnIds: [...ids('ws-1'), ...ids('ws-2')],
      }),
      // Below the rule already, but untouched by this purge.
      storedSuggestion({
        id: 'untouched',
        proposedSkillName: 'untouched',
        members: [member],
        matchedTurnIds: ids('ws-3').slice(0, 1),
      }),
    ];
    purgeWorkspaceFromState(state, 'ws-2', 5);
    expect(state.suggestions.map((entry) => entry.id)).toEqual([
      'touched',
      'untouched',
    ]);
    // Member tokens may have come from the deleted workspace, so a surviving
    // open suggestion expires; the next scan can re-propose it with fresh ones.
    expect(state.suggestions[0]).toMatchObject({
      state: 'expired',
      resolvedAt: 5,
      members: [],
    });
    expect(state.suggestions[1]?.members).toEqual([member]);
    expect(state.suggestions[1]?.state).toBe('confirmed');
  });
});
