import type { PreferencesData } from '@canopy/desktop-shared/types';
import type { ChainCandidate, PromptCandidate } from '../clustering';
import {
  buildScanPrompt,
  chooseScanModel,
  validateScanOutput,
  type ScanModelInput,
} from '../clustering-generator';
import {
  chainMatchId,
  turnMatchId,
  type ChatChainFingerprint,
  type TurnFingerprint,
} from '../fingerprint-store';
import type { SkillSuggestionPartition } from '../partition';
import { storedSuggestion } from './fixtures';

const mockResolveLane = jest.fn();
const mockBlocked = jest.fn<Promise<boolean>, unknown[]>();
const mockMemoryModel = jest.fn();

jest.mock('../../lib/default-model-lane-resolver', () => ({
  resolveLaneAwareDefaultSelection: (...args: unknown[]): unknown =>
    mockResolveLane(...args),
}));
jest.mock('../../memory/local/model-policy', () => ({
  isLocalMemoryModelBlockedByPolicy: (...args: unknown[]): Promise<boolean> =>
    mockBlocked(...args),
}));
jest.mock('../../memory/local/helper-model', () => ({
  resolveLocalMemoryHelperModel: (...args: unknown[]): unknown =>
    mockMemoryModel(...args),
  helperModelForChatModel: (model: string, thinkingLevel: string): unknown => ({
    model,
    thinkingLevel,
  }),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(),
}));
jest.mock('../../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
}));

const personal: SkillSuggestionPartition = {
  key: 'personal',
  owner: { kind: 'personal' },
  privateWorkspaceId: null,
};
const privatePartition: SkillSuggestionPartition = {
  key: 'personal/private:ws',
  owner: { kind: 'personal' },
  privateWorkspaceId: 'ws',
};

let seq = 0;
function turn(
  chatId: string,
  day: string,
  excerpt = 'Summarize release notes',
): TurnFingerprint {
  seq += 1;
  return {
    kind: 'turn',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    userMessageId: `m${seq}`,
    partition: 'personal',
    createdAt: seq,
    day,
    excerpt,
    tokens: ['notes', 'release', 'summarize'],
    tools: [],
    status: 'success',
  };
}
function chainRow(chatId: string, day: string): ChatChainFingerprint {
  return {
    kind: 'chat_chain',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    partition: 'personal',
    skills: ['review', 'push-branch'],
    lastActivityAt: 1,
    day,
  };
}

const members = [
  turn('a', '2026-10-01'),
  turn('b', '2026-10-02'),
  turn('c', '2026-10-03'),
];
const promptCandidate: PromptCandidate = { kind: 'prompt', members };
const chainCandidate: ChainCandidate = {
  kind: 'chain',
  skills: ['review', 'push-branch'],
  chats: [
    chainRow('a', '2026-10-01'),
    chainRow('b', '2026-10-02'),
    chainRow('c', '2026-10-03'),
  ],
};

function input(partition = personal): ScanModelInput {
  return {
    partition,
    promptCandidates: [promptCandidate],
    chainCandidates: [chainCandidate],
    unclustered: [turn('d', '2026-10-04', 'Draft release notes summary')],
    inventory: [{ name: 'release-notes', description: 'Existing' }],
    priorSuggestions: [],
  };
}

function group(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    groupId: 'g1',
    memberIds: ['r1', 'r2', 'r3'],
    title: 'Summarize release notes',
    summary: 'Summarizes the latest release notes for a product.',
    proposedSkillName: 'summarize-release',
    description: 'Summarize release notes for a product.',
    parameters: ['product'],
    coveredByExistingSkill: false,
    ...overrides,
  };
}

function validate(
  groups: unknown[],
  overrides: {
    existing?: ReturnType<typeof storedSuggestion>[];
    partition?: SkillSuggestionPartition;
  } = {},
): ReturnType<typeof validateScanOutput> {
  const partition = overrides.partition ?? personal;
  const prepared = buildScanPrompt(input(partition));
  return validateScanOutput(
    { groups },
    {
      partition,
      prepared,
      inventoryNames: new Set(['release-notes']),
      existing: overrides.existing ?? [],
    },
  );
}

describe('skill suggestion scan prompt', () => {
  it('fences every input as JSON data and states the data rule', () => {
    const prepared = buildScanPrompt(input());
    expect(prepared.systemPrompt).toContain('never instructions');
    expect(prepared.userMessage).toContain('```json');
    expect(prepared.userMessage).toContain('"id": "g1"');
    expect(prepared.userMessage).toContain('"id": "c1"');
    expect(prepared.userMessage).toContain('"id": "u1"');
    expect(prepared.groupKinds.get('c1')).toBe('chain');
  });
});

describe('skill suggestion scan validator', () => {
  it('accepts a well-formed prompt group with deterministic exemplars', () => {
    const [accepted] = validate([group()]);
    expect(accepted).toMatchObject({
      kind: 'prompt',
      proposedSkillName: 'summarize-release',
      reuseId: null,
    });
    expect(accepted?.matchedTurnIds).toEqual(
      members.map((row) => turnMatchId(row)),
    );
    expect(accepted?.exemplars).toHaveLength(3);
    expect(accepted?.exemplars[0]).toBe(members[2]?.excerpt);
  });

  it('keeps no exemplars for private partitions', () => {
    const [accepted] = validate([group()], { partition: privatePartition });
    expect(accepted?.exemplars).toEqual([]);
  });

  it('accepts a chain group and records chat-level matches', () => {
    const [accepted] = validate([group({ groupId: 'c1', memberIds: [] })]);
    expect(accepted?.kind).toBe('chain');
    expect(accepted?.chainSkills).toEqual(['review', 'push-branch']);
    expect(accepted?.matchedTurnIds).toEqual(
      chainCandidate.chats.map((row) => chainMatchId(row)),
    );
  });

  it('rejects unknown ids, too-small groups and ids from another group', () => {
    expect(validate([group({ memberIds: ['r1', 'r2', 'zz'] })])).toEqual([]);
    expect(validate([group({ memberIds: ['r1', 'r2'] })])).toEqual([]);
    expect(validate([group({ groupId: 'g9' })])).toEqual([]);
  });

  it('lets unclustered prompts join a group', () => {
    const [accepted] = validate([group({ memberIds: ['r1', 'r2', 'u1'] })]);
    expect(accepted?.members).toHaveLength(3);
  });

  it('counts an unclustered prompt toward one group only', () => {
    const second: PromptCandidate = {
      kind: 'prompt',
      members: [
        turn('e', '2026-10-05', 'Summarize release notes again'),
        turn('f', '2026-10-06', 'Summarize release notes once more'),
      ],
    };
    const prepared = buildScanPrompt({
      ...input(),
      promptCandidates: [promptCandidate, second],
    });
    const accepted = validateScanOutput(
      {
        groups: [
          group({ memberIds: ['r1', 'r2', 'u1'] }),
          group({
            groupId: 'g2',
            memberIds: ['r4', 'r5', 'u1'],
            proposedSkillName: 'release-again',
          }),
        ],
      },
      {
        partition: personal,
        prepared,
        inventoryNames: new Set(['release-notes']),
        existing: [],
      },
    );
    // Without the shared prompt the second group is too small.
    expect(accepted.map((entry) => entry.proposedSkillName)).toEqual([
      'summarize-release',
    ]);
  });

  it('rejects groups covered by an existing skill', () => {
    expect(validate([group({ coveredByExistingSkill: true })])).toEqual([]);
  });

  it('rejects injection-shaped and oversized fields', () => {
    expect(validate([group({ title: 'See https://evil.example' })])).toEqual(
      [],
    );
    expect(validate([group({ summary: '```rm -rf```' })])).toEqual([]);
    expect(validate([group({ title: 'x'.repeat(61) })])).toEqual([]);
    expect(validate([group({ summary: 'x'.repeat(241) })])).toEqual([]);
    expect(
      validate([group({ parameters: ['a', 'b', 'c', 'd', 'e', 'f'] })]),
    ).toEqual([]);
    expect(validate([group({ parameters: ['x'.repeat(41)] })])).toEqual([]);
  });

  it('rejects malformed or colliding skill names', () => {
    expect(validate([group({ proposedSkillName: 'Bad Name' })])).toEqual([]);
    expect(validate([group({ proposedSkillName: 'release-notes' })])).toEqual(
      [],
    );
    expect(
      validate([group({ proposedSkillName: 'taken' })], {
        existing: [storedSuggestion({ proposedSkillName: 'taken' })],
      }),
    ).toEqual([]);
    for (const state of ['accepted', 'dismissed'] as const) {
      expect(
        validate([group({ proposedSkillName: 'taken' })], {
          existing: [storedSuggestion({ state, proposedSkillName: 'taken' })],
        }),
      ).toEqual([]);
    }
  });

  it('rejects overlap with accepted or dismissed suggestions', () => {
    const ids = members.map((row) => turnMatchId(row));
    for (const state of ['accepted', 'dismissed'] as const) {
      expect(
        validate([group()], {
          existing: [
            storedSuggestion({
              state,
              matchedTurnIds: ids.slice(0, 2),
              proposedSkillName: 'old',
            }),
          ],
        }),
      ).toEqual([]);
    }
  });

  it('lets only one accepted group reuse an expired id', () => {
    const ids = [
      ...members.map((row) => turnMatchId(row)),
      ...chainCandidate.chats.map((row) => chainMatchId(row)),
    ];
    const accepted = validate(
      [
        group(),
        group({
          groupId: 'c1',
          memberIds: [],
          proposedSkillName: 'review-and-push',
        }),
      ],
      {
        existing: [
          storedSuggestion({
            id: 'expired-1',
            state: 'expired',
            matchedTurnIds: ids,
            proposedSkillName: 'old',
          }),
        ],
      },
    );
    expect(accepted.map((entry) => entry.reuseId)).toEqual(['expired-1', null]);
  });

  it('sends only the newest resolved suggestions to the model', () => {
    const prepared = buildScanPrompt({
      ...input(),
      priorSuggestions: Array.from({ length: 60 }, (_, i) =>
        storedSuggestion({
          id: `p${i}`,
          state: 'dismissed',
          proposedSkillName: `prior-${i}`,
          resolvedAt: i,
        }),
      ),
    });
    expect(prepared.userMessage).toContain('prior-59');
    expect(prepared.userMessage).not.toContain('"prior-9"');
  });

  it('reuses an expired suggestion id for a re-proposal', () => {
    const ids = members.map((row) => turnMatchId(row));
    const [accepted] = validate([group()], {
      existing: [
        storedSuggestion({
          id: 'expired-1',
          state: 'expired',
          matchedTurnIds: ids,
          proposedSkillName: 'old',
        }),
      ],
    });
    expect(accepted?.reuseId).toBe('expired-1');
  });
});

describe('skill suggestion scan model choice', () => {
  const preferences = {
    localMemoryEnabled: true,
  } as unknown as PreferencesData;
  beforeEach(() => {
    mockResolveLane.mockReset();
    mockBlocked.mockReset().mockResolvedValue(false);
    mockMemoryModel.mockReset();
  });

  it('uses the Memory model with the owner default workspace when memory is on', async () => {
    mockMemoryModel.mockReturnValue({ model: 'sonnet', thinkingLevel: 'high' });
    const choice = await chooseScanModel(preferences, {
      key: 'org:o1',
      owner: { kind: 'organization', organizationId: 'o1' },
      privateWorkspaceId: null,
    });
    expect(choice).toMatchObject({ kind: 'run', localMemoryEnabled: true });
    expect(mockResolveLane).not.toHaveBeenCalled();
    expect(mockBlocked).toHaveBeenCalledWith(
      'sonnet',
      expect.stringContaining('o1'),
      {
        workOwner: { kind: 'organization', organizationId: 'o1' },
      },
    );
  });

  it('uses the lane default without stamping the projection when memory is off', async () => {
    mockResolveLane.mockResolvedValue({
      outcome: 'resolved',
      selection: { model: 'gpt-5', thinkingLevel: 'medium' },
    });
    const choice = await chooseScanModel(
      { localMemoryEnabled: false } as unknown as PreferencesData,
      personal,
    );
    expect(choice).toMatchObject({ kind: 'run', localMemoryEnabled: false });
    expect(mockResolveLane).toHaveBeenCalledWith(
      expect.anything(),
      'chat',
      { workspaceId: 'cowork-default' },
      undefined,
      undefined,
      false,
    );
  });

  it('skips when no model can dispatch, the model is unavailable or blocked', async () => {
    mockResolveLane.mockResolvedValue({ outcome: 'no-dispatchable-model' });
    expect(
      await chooseScanModel(
        { localMemoryEnabled: false } as unknown as PreferencesData,
        personal,
      ),
    ).toEqual({ kind: 'skip', reason: 'no-dispatchable-model' });
    mockMemoryModel.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(await chooseScanModel(preferences, personal)).toEqual({
      kind: 'skip',
      reason: 'unavailable',
    });
    mockMemoryModel
      .mockReset()
      .mockReturnValue({ model: 'sonnet', thinkingLevel: 'high' });
    mockBlocked.mockResolvedValue(true);
    expect(await chooseScanModel(preferences, personal)).toEqual({
      kind: 'skip',
      reason: 'model-blocked',
    });
  });
});
