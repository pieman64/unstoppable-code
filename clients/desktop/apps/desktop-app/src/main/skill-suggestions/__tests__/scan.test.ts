import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  FingerprintStore,
  localDay,
  turnMatchId,
  type ChatChainFingerprint,
  type TurnFingerprint,
} from '../fingerprint-store';
import { normalizePromptTokens } from '../normalize';
import { SkillSuggestionsRegistry } from '../registry';
import type * as ClusteringGenerator from '../clustering-generator';
import { runScanPass, type ScanDeps, type ScanGenerator } from '../scan';
import { TimeSlicer } from '../time-slicer';
import { storedSuggestion } from './fixtures';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../lib/background-helper-queue', () => ({
  BACKGROUND_HELPER_PRIORITIES: { skillSuggestions: 5 },
  enqueueBackgroundHelperTask: (options: {
    task: () => Promise<unknown>;
  }): Promise<unknown> => options.task(),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);
const PROMPTS = [
  'Summarize the weekly release notes for the mobile app',
  'Summarize weekly release notes for the desktop app',
  'Please summarize this week release notes for the web app',
];

let seq = 0;
function turn(
  partition: string,
  text: string,
  chatId: string,
  daysAgo: number,
): TurnFingerprint {
  seq += 1;
  const createdAt = NOW - daysAgo * DAY + seq;
  return {
    kind: 'turn',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    userMessageId: `m${seq}`,
    partition,
    createdAt,
    day: localDay(createdAt),
    excerpt: text,
    tokens: normalizePromptTokens(text),
    tools: [],
    status: 'success',
  };
}

let dir: string;
let store: FingerprintStore;
let registry: SkillSuggestionsRegistry;
let allowed: boolean;
let organizations: Map<string, string>;
let generator: jest.Mocked<ScanGenerator>;
let finalize: jest.Mock;
let outcomes: string[];

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    store,
    registry,
    slicer: new TimeSlicer({ yieldToEventLoop: () => Promise.resolve() }),
    now: () => NOW,
    isAllowed: () => allowed,
    readPreferences: () =>
      Promise.resolve({
        localMemoryEnabled: true,
      } as unknown as PreferencesData),
    readOrganizations: () => Promise.resolve(organizations),
    loadInventory: () => Promise.resolve([]),
    loadGenerator: () => Promise.resolve(generator),
    liveProjectIds: () => Promise.resolve(null),
    onPartitionScanned: (outcome) => outcomes.push(outcome),
    notifyChanged: jest.fn(),
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-scan-'));
  store = new FingerprintStore(() => join(dir, 'fp.jsonl'));
  registry = new SkillSuggestionsRegistry(() => join(dir, 'state.json'));
  allowed = true;
  organizations = new Map([['org-1', 'Acme']]);
  outcomes = [];
  finalize = jest.fn();
  const actual = jest.requireActual<typeof ClusteringGenerator>(
    '../clustering-generator',
  );
  generator = {
    chooseScanModel: jest.fn().mockResolvedValue({
      kind: 'run',
      helperModel: { model: 'sonnet', thinkingLevel: 'high' },
      localMemoryEnabled: true,
      workspaceId: 'cowork-default',
    }),
    buildScanPrompt: jest.fn(actual.buildScanPrompt),
    runSkillSuggestionScanModel: jest.fn().mockResolvedValue({
      output: {
        groups: [
          {
            groupId: 'g1',
            memberIds: ['r1', 'r2', 'r3'],
            title: 'Summarize release notes',
            summary: 'Summarizes weekly release notes for an app.',
            proposedSkillName: 'release-summary',
            description: 'Summarize weekly release notes.',
            parameters: ['app'],
            coveredByExistingSkill: false,
          },
        ],
      },
      finalize,
    }),
    validateScanOutput: jest.fn(actual.validateScanOutput),
    MAX_UNCLUSTERED_PROMPTS: 40,
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedRepeats(partition = 'personal', extra = 0): Promise<void> {
  await store.append([
    ...PROMPTS.map((text, i) => turn(partition, text, `c${i}`, 3 - i)),
    ...Array.from({ length: extra }, (_, i) =>
      turn(
        partition,
        `Unrelated request number ${i} about deployment logs`,
        `x${i}`,
        1,
      ),
    ),
  ]);
}

describe('skill suggestion scan pass', () => {
  it('confirms a group, records the scan and finalizes the helper task', async () => {
    await seedRepeats();
    expect(await runScanPass(deps(), { waiveMinimum: true })).toBe('done');
    const state = await registry.read();
    expect(state.suggestions).toHaveLength(1);
    expect(state.suggestions[0]).toMatchObject({
      state: 'confirmed',
      partition: 'personal',
      proposedSkillName: 'release-summary',
    });
    expect(state.suggestions[0]?.matchedTurnIds).toHaveLength(3);
    expect(state.lastScanAt.personal).toBe(NOW);
    expect(finalize).toHaveBeenCalledWith('success');
    expect(outcomes).toEqual(['confirmed']);
  });

  it('never calls the model without candidates', async () => {
    await store.append([turn('personal', PROMPTS[0] ?? '', 'c0', 1)]);
    await runScanPass(deps(), { waiveMinimum: true });
    expect(generator.chooseScanModel).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['no_candidates']);
    expect((await registry.read()).lastScanAt.personal).toBe(NOW);
  });

  it('prunes rows for chats that no longer exist before clustering', async () => {
    await seedRepeats('personal');
    const liveChatIds = jest.fn(() => Promise.resolve(new Set(['c0', 'c1'])));
    await runScanPass(deps({ liveChatIds }), { waiveMinimum: true });
    expect(liveChatIds).toHaveBeenCalledWith(NOW);
    expect((await store.read()).map((row) => row.chatId).sort()).toEqual([
      'c0',
      'c1',
    ]);
    // Two requests left: not enough for a candidate, so no model call.
    expect(generator.chooseScanModel).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['no_candidates']);
  });

  it('waits a day per partition and for ten new requests once backfill is done', async () => {
    await seedRepeats();
    await registry.update((draft) => {
      draft.lastScanAt.personal = NOW - DAY / 2;
      return true;
    });
    await runScanPass(deps(), { waiveMinimum: true });
    expect(outcomes).toEqual([]);
    await registry.update((draft) => {
      draft.lastScanAt.personal = NOW - 2 * DAY;
      return true;
    });
    await runScanPass(deps(), { waiveMinimum: false });
    expect(outcomes).toEqual([]);
    await store.append(
      Array.from({ length: 10 }, (_, i) =>
        turn(
          'personal',
          `Fresh request ${i} about something new entirely`,
          `n${i}`,
          0,
        ),
      ),
    );
    await runScanPass(deps(), { waiveMinimum: false });
    expect(outcomes).toHaveLength(1);
  });

  it('skips compaction and chat enumeration when no partition is due', async () => {
    await seedRepeats();
    await registry.update((draft) => {
      draft.lastScanAt.personal = NOW - DAY / 2;
      return true;
    });
    const liveChatIds = jest.fn(() => Promise.resolve(null));
    const compact = jest.spyOn(store, 'compact');
    expect(
      await runScanPass(deps({ liveChatIds }), { waiveMinimum: false }),
    ).toBe('done');
    expect(liveChatIds).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it('does not rebuild candidates from accepted or dismissed suggestions', async () => {
    await seedRepeats();
    const ids = (await store.read()).map((row) =>
      row.kind === 'turn' ? turnMatchId(row) : '',
    );
    for (const state of ['accepted', 'dismissed'] as const) {
      await registry.update((draft) => {
        draft.lastScanAt = {};
        draft.suggestions = [
          storedSuggestion({ state, matchedTurnIds: ids, exemplars: [] }),
        ];
        return true;
      });
      await runScanPass(deps(), { waiveMinimum: true });
    }
    expect(generator.chooseScanModel).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['no_candidates', 'no_candidates']);
  });

  it('lets an expired chain suggestion be proposed again', async () => {
    const chainRow = (
      chatId: string,
      daysAgo: number,
    ): ChatChainFingerprint => {
      const at = NOW - daysAgo * DAY;
      return {
        kind: 'chat_chain',
        projectId: 'ws',
        worktreeId: 'wt',
        chatId,
        partition: 'personal',
        skills: ['review', 'push-branch'],
        lastActivityAt: at,
        day: localDay(at),
      };
    };
    // Chain rows are kept only for chats that still have turn rows.
    await store.append([
      turn('personal', 'Review the open pull request', 'k1', 3),
      turn('personal', 'Push the feature branch upstream', 'k2', 2),
      turn('personal', 'Check the deployment dashboard metrics', 'k3', 1),
      chainRow('k1', 3),
      chainRow('k2', 2),
      chainRow('k3', 1),
    ]);
    await registry.update((draft) => {
      draft.suggestions = [
        storedSuggestion({
          kind: 'chain',
          state: 'expired',
          chainSkills: ['review', 'push-branch'],
          members: [],
          exemplars: [],
        }),
      ];
      return true;
    });
    await runScanPass(deps(), { waiveMinimum: true });
    const [input] = generator.buildScanPrompt.mock.calls[0] ?? [];
    expect(input?.chainCandidates.map((candidate) => candidate.skills)).toEqual(
      [['review', 'push-branch']],
    );
  });

  it('writes nothing when the gate closes after the model call', async () => {
    await seedRepeats();
    let loads = 0;
    const loadInventory = (): Promise<[]> => {
      loads += 1;
      // The second load runs after the model call, just before the write.
      if (loads === 2) allowed = false;
      return Promise.resolve([]);
    };
    expect(
      await runScanPass(deps({ loadInventory }), { waiveMinimum: true }),
    ).toBe('cancelled');
    expect((await registry.read()).suggestions).toEqual([]);
    expect(finalize).toHaveBeenCalledWith('failure', expect.any(String));
  });

  it('waives the new-request minimum for a partition never scanned', async () => {
    await seedRepeats();
    await runScanPass(deps(), { waiveMinimum: false });
    expect(outcomes).toEqual(['confirmed']);
  });

  it('does not compact for a partition of an organization the user left', async () => {
    await seedRepeats('org:org-2', 10);
    const compact = jest.spyOn(store, 'compact');
    await runScanPass(deps(), { waiveMinimum: true });
    expect(compact).not.toHaveBeenCalled();
  });

  it('never sends a group whose newest request is past the idle expiry', async () => {
    await store.append(
      PROMPTS.map((text, i) => turn('personal', text, `c${i}`, 40 - i)),
    );
    await runScanPass(deps(), { waiveMinimum: true });
    expect(generator.chooseScanModel).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['no_candidates']);
  });

  it('drops a workspace deleted during the model call from the write', async () => {
    await seedRepeats();
    const liveProjectIds = jest
      .fn<Promise<ReadonlySet<string> | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Set<string>());
    await runScanPass(deps({ liveProjectIds }), { waiveMinimum: true });
    expect((await registry.read()).suggestions).toEqual([]);
  });

  it('records a failed scan but not a cancelled one', async () => {
    await seedRepeats();
    generator.runSkillSuggestionScanModel.mockRejectedValueOnce(
      new Error('refused'),
    );
    await runScanPass(deps(), { waiveMinimum: true });
    expect(outcomes).toEqual(['failed']);
    expect((await registry.read()).lastScanAt.personal).toBe(NOW);

    await registry.update((draft) => {
      draft.lastScanAt = {};
      return true;
    });
    const stopped = new TimeSlicer({ shouldStop: (): boolean => true });
    expect(
      await runScanPass(deps({ slicer: stopped }), { waiveMinimum: true }),
    ).toBe('cancelled');
    expect((await registry.read()).lastScanAt.personal).toBeUndefined();
  });

  it('throws away the result when the gate closes during the model call', async () => {
    await seedRepeats();
    generator.runSkillSuggestionScanModel.mockImplementationOnce(() => {
      allowed = false;
      return Promise.resolve({ output: { groups: [] }, finalize });
    });
    expect(await runScanPass(deps(), { waiveMinimum: true })).toBe('cancelled');
    expect((await registry.read()).suggestions).toEqual([]);
    expect(finalize).toHaveBeenCalledWith('failure', expect.any(String));
  });

  it('skips a partition whose model is refused', async () => {
    await seedRepeats();
    generator.chooseScanModel.mockResolvedValueOnce({
      kind: 'skip',
      reason: 'model-blocked',
    });
    await runScanPass(deps(), { waiveMinimum: true });
    expect(outcomes).toEqual(['skipped']);
    expect(generator.runSkillSuggestionScanModel).not.toHaveBeenCalled();
  });

  it('skips and expires partitions for organizations the user left', async () => {
    await seedRepeats('org:org-2');
    await registry.update((draft) => {
      draft.suggestions.push(
        storedSuggestion({ partition: 'org:org-2', lastMatchedAt: NOW }),
      );
      return true;
    });
    await runScanPass(deps(), { waiveMinimum: true });
    expect(generator.chooseScanModel).not.toHaveBeenCalled();
    expect((await registry.read()).suggestions[0]?.state).toBe('expired');
  });

  it('keeps org suggestions open when membership reads empty', async () => {
    // An empty read means unknown (rollout off, signed out, still loading).
    organizations = new Map();
    await registry.update((draft) => {
      draft.suggestions.push(
        storedSuggestion({ partition: 'org:org-1', lastMatchedAt: NOW }),
      );
      return true;
    });
    await runScanPass(deps(), { waiveMinimum: true });
    expect((await registry.read()).suggestions[0]?.state).toBe('confirmed');
  });

  it('scans each partition separately', async () => {
    await seedRepeats('personal');
    await seedRepeats('org:org-1');
    await runScanPass(deps(), { waiveMinimum: true });
    const partitions = generator.buildScanPrompt.mock.calls.map(
      ([input]) => input.partition.key,
    );
    expect(partitions.sort()).toEqual(['org:org-1', 'personal']);
    for (const [input] of generator.buildScanPrompt.mock.calls) {
      for (const candidate of input.promptCandidates) {
        expect(
          candidate.members.every(
            (row) => row.partition === input.partition.key,
          ),
        ).toBe(true);
      }
    }
  });
});
