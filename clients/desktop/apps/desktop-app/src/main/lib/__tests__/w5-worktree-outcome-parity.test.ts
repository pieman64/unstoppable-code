import { z } from 'zod';
import {
  decodeW5WorktreeBranchRenameOutcome,
  decodeW5WorktreeHooksPausedOutcome,
  decodeW5WorktreeOutcome,
  decodeW5WorktreeUpdateOutcome,
  W5OutcomeDecodeError,
} from '@canopy/core-runtime/node/w5/worktree-outcome';
import {
  decodeW5CompositionOutcome,
  w5CombineOutcomeParser,
  w5ExistingCombineOutcomeParser,
  w5PromoteOutcomeParser,
  type W5OutcomeParser,
} from '@canopy/core-runtime/node/w5/composition-outcome';

/*
 * CAN-5199 and CAN-5200 reference oracle: the zod schemas the core decoders
 * replaced, copied verbatim. Test-only; production readers decode through core.
 */
const zodWorktree = z.object({
  id: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  label: z.string().optional(),
  hidden: z.boolean().optional(),
  pinned: z.boolean().optional(),
  branchGroupingOverride: z.enum(['group', 'ungroup']).optional(),
  branchGroupingParentWorktreeId: z.string().optional(),
  trackedBaseBranch: z.string().nullable().optional(),
  trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
  includedRepoIds: z.array(z.string()).optional(),
  setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
});
const zodUpdate = z.object({ worktree: zodWorktree, changed: z.boolean() });
const zodRename = z.object({
  branchName: z.string(),
  worktree: zodWorktree.nullable(),
});
const zodPaused = z.object({
  worktree: zodWorktree.extend({
    pausedHookKeys: z.array(z.string()).optional(),
  }),
  pausedHookKeys: z.array(z.string()),
  changed: z.boolean(),
});
const zodWorkspace = z.object({
  id: z.string(),
  type: z.literal('multi-repo'),
  name: z.string(),
  color: z.string(),
  order: z.number(),
  collapsed: z.boolean().optional(),
  temporary: z.boolean().optional(),
  repos: z.array(z.object({ id: z.string(), name: z.string() })),
  worktrees: z.array(zodWorktree),
});
const zodMigration = z.object({
  repoMappings: z.array(
    z.object({
      sourceRepoId: z.string().optional(),
      destinationRepoId: z.string(),
      repoName: z.string(),
    }),
  ),
  selectedRepoIdRewrites: z.record(z.string(), z.string()),
  sourceRootRepoIdRewrite: z.string().optional(),
  removedTemporaryWorkspaceId: z.string().optional(),
});
const zodCombine = zodMigration.extend({
  sourceWorkspaceId: z.string(),
  sourceWorktreeId: z.string(),
  destinationWorkspaceId: z.string(),
  destinationWorktreeId: z.string(),
  destinationWorkspace: zodWorkspace,
  destinationWorktree: zodWorktree,
  createdTemporaryWorkspace: z.boolean(),
  reusedWorkspace: z.boolean(),
  removedSourceWorktree: z.boolean(),
});
const zodExistingCombine = zodCombine.extend({
  joinedWorktree: zodMigration.extend({
    workspaceId: z.string(),
    worktreeId: z.string(),
  }),
});

/** Every own key, in order, at every depth, so key order and presence must match. */
function ownKeyPaths(value: unknown, path = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Reflect.ownKeys(value).flatMap((key) => {
    const child = `${path}/${String(key)}`;
    return [child, ...ownKeyPaths(Reflect.get(value, key), child)];
  });
}

type Outcome =
  | { accepted: true; value: unknown }
  | { accepted: false; error: unknown };

function attempt(decode: (value: unknown) => unknown, value: unknown): Outcome {
  try {
    return { accepted: true, value: decode(value) };
  } catch (error) {
    return { accepted: false, error };
  }
}

function expectParity(
  oracle: (value: unknown) => unknown,
  decode: (value: unknown) => unknown,
  input: unknown,
  refusal: new (...args: never[]) => Error,
): void {
  const expected = attempt(oracle, input);
  const actual = attempt(decode, input);
  expect(actual.accepted).toBe(expected.accepted);
  if (expected.accepted && actual.accepted) {
    expect(actual.value).toStrictEqual(expected.value);
    expect(ownKeyPaths(actual.value)).toEqual(ownKeyPaths(expected.value));
    expect(JSON.stringify(actual.value)).toBe(JSON.stringify(expected.value));
    // A fresh projection, never the caller's object.
    expect(actual.value).not.toBe(input);
  }
  if (!actual.accepted) expect(actual.error).toBeInstanceOf(refusal);
}

const createdAt = '2026-10-01T12:00:00.000Z';

/** Stored worktree rows as receipts save them, including unknown host fields. */
const storedRows: ReadonlyArray<[string, string]> = [
  ['minimal', `{"id":"wt-1","branchName":"main","createdAt":"${createdAt}"}`],
  [
    'every field, out of order, with unknown host fields',
    `{"setupPhase":"git-ready","includedRepoIds":["r-1","r-2"],"trackedRepoBaseBranches":{"r-1":"main","r-2":"develop"},"trackedBaseBranch":"main","branchGroupingParentWorktreeId":"wt-0","branchGroupingOverride":"group","pinned":true,"hidden":false,"label":"Fix","createdAt":"${createdAt}","branchName":"mike/fix","id":"wt-2","creation":{"kind":"local"},"replica":{"state":"present"},"status":"active","lastTouchedAt":"${createdAt}","pausedHookKeys":["setup"],"chatBadges":{"unread":2},"pendingArchiveBranchDeletion":null}`,
  ],
  [
    'empty strings and lists',
    `{"id":"","branchName":"","createdAt":"","label":"","includedRepoIds":[],"trackedRepoBaseBranches":{}}`,
  ],
  [
    'null tracked base branch',
    `{"id":"wt-3","branchName":"b","createdAt":"${createdAt}","trackedBaseBranch":null}`,
  ],
  [
    'ungroup and git-pending',
    `{"id":"wt-4","branchName":"b","createdAt":"${createdAt}","branchGroupingOverride":"ungroup","setupPhase":"git-pending"}`,
  ],
  [
    'record keys that look special or numeric',
    `{"id":"wt-5","branchName":"b","createdAt":"${createdAt}","trackedRepoBaseBranches":{"10":"a","2":"b","constructor":"c","toString":"d","__proto__":"e","z":"f"}}`,
  ],
  [
    'an own non-string __proto__ record key, which the schema skipped',
    `{"id":"wt-5","branchName":"b","createdAt":"${createdAt}","trackedRepoBaseBranches":{"__proto__":{"r":1},"r":"main"}}`,
  ],
  [
    'own __proto__ row key',
    `{"__proto__":{"id":"x"},"id":"wt-6","branchName":"b","createdAt":"${createdAt}"}`,
  ],
  // Refused: explicit null optional fields, other than trackedBaseBranch.
  ...[
    'label',
    'hidden',
    'pinned',
    'branchGroupingOverride',
    'branchGroupingParentWorktreeId',
    'trackedRepoBaseBranches',
    'includedRepoIds',
    'setupPhase',
  ].map((key): [string, string] => [
    `null ${key}`,
    `{"id":"wt-n","branchName":"b","createdAt":"${createdAt}","${key}":null}`,
  ]),
  // Refused: unaccepted enum values.
  [
    'unknown grouping override',
    `{"id":"wt-e","branchName":"b","createdAt":"${createdAt}","branchGroupingOverride":"auto"}`,
  ],
  [
    'grouping override in another case',
    `{"id":"wt-e","branchName":"b","createdAt":"${createdAt}","branchGroupingOverride":"Group"}`,
  ],
  [
    'unknown setup phase',
    `{"id":"wt-e","branchName":"b","createdAt":"${createdAt}","setupPhase":"git-done"}`,
  ],
  // Refused: missing or wrong required and optional types.
  ['missing id', `{"branchName":"b","createdAt":"${createdAt}"}`],
  ['missing createdAt', `{"id":"wt-m","branchName":"b"}`],
  [
    'null branchName',
    `{"id":"wt-m","branchName":null,"createdAt":"${createdAt}"}`,
  ],
  ['numeric id', `{"id":7,"branchName":"b","createdAt":"${createdAt}"}`],
  [
    'string hidden',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","hidden":"true"}`,
  ],
  [
    'numeric pinned',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","pinned":1}`,
  ],
  [
    'numeric tracked base branch',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","trackedBaseBranch":1}`,
  ],
  [
    'non-string included repo',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","includedRepoIds":["r",1]}`,
  ],
  [
    'string included repos',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","includedRepoIds":"r"}`,
  ],
  [
    'non-string record value',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","trackedRepoBaseBranches":{"r":1}}`,
  ],
  [
    'null record value',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","trackedRepoBaseBranches":{"r":null}}`,
  ],
  [
    'array record',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","trackedRepoBaseBranches":["main"]}`,
  ],
  [
    'non-object label',
    `{"id":"wt-t","branchName":"b","createdAt":"${createdAt}","label":{"text":"x"}}`,
  ],
  ['null row', 'null'],
  ['array row', `[{"id":"wt-a","branchName":"b","createdAt":"${createdAt}"}]`],
  ['string row', '"wt-1"'],
  ['numeric row', '1'],
  ['boolean row', 'true'],
];

const minimalRow = { id: 'wt-min', branchName: 'main', createdAt };

function withPrototype<T extends object>(
  value: T,
  prototype: object | null,
): T {
  Reflect.setPrototypeOf(value, prototype);
  return value;
}

class RepoBranches {
  r = 'main';
}

/** In-memory results a boundary returns before its outcome is saved. */
const liveRows: ReadonlyArray<[string, () => unknown]> = [
  [
    'explicitly undefined optional fields',
    (): unknown => ({
      ...minimalRow,
      label: undefined,
      hidden: undefined,
      trackedBaseBranch: undefined,
      trackedRepoBaseBranches: undefined,
      setupPhase: undefined,
    }),
  ],
  [
    'undefined required field',
    (): unknown => ({ ...minimalRow, id: undefined }),
  ],
  [
    'sparse included repos',
    (): unknown => {
      const includedRepoIds: string[] = ['r'];
      includedRepoIds[2] = 's';
      return { ...minimalRow, includedRepoIds };
    },
  ],
  [
    'inherited fields',
    (): unknown =>
      withPrototype({ pinned: true }, { ...minimalRow, label: 'inherited' }),
  ],
  [
    'null-prototype row and record',
    (): unknown =>
      withPrototype(
        {
          ...minimalRow,
          trackedRepoBaseBranches: withPrototype({ r: 'main' }, null),
        },
        null,
      ),
  ],
  [
    'class-instance record',
    (): unknown => ({
      ...minimalRow,
      trackedRepoBaseBranches: new RepoBranches(),
    }),
  ],
  [
    'map record',
    (): unknown => ({
      ...minimalRow,
      trackedRepoBaseBranches: new Map([['r', 'main']]),
    }),
  ],
  [
    'symbol record key',
    (): unknown => ({
      ...minimalRow,
      trackedRepoBaseBranches: { r: 'main', [Symbol('s')]: 'x' },
    }),
  ],
  [
    'non-enumerable record key',
    (): unknown => ({
      ...minimalRow,
      trackedRepoBaseBranches: Object.defineProperty({ r: 'main' }, 'hidden', {
        value: 'x',
        enumerable: false,
      }),
    }),
  ],
  [
    'non-enumerable non-string record value',
    (): unknown => ({
      ...minimalRow,
      trackedRepoBaseBranches: Object.defineProperty({ r: 'main' }, 'hidden', {
        value: 1,
        enumerable: false,
      }),
    }),
  ],
  ['date row', (): unknown => new Date(0)],
  ['undefined row', (): unknown => undefined],
];

const rows: ReadonlyArray<[string, () => unknown]> = [
  ...storedRows.map(([name, json]): [string, () => unknown] => [
    `stored ${name}`,
    (): unknown => JSON.parse(json),
  ]),
  ...liveRows.map(([name, row]): [string, () => unknown] => [
    `live ${name}`,
    row,
  ]),
];

describe('core outcome decoding matches the replaced zod schemas', () => {
  it.each(rows)('%s row', (_name, row) => {
    expectParity(
      (value) => zodWorktree.parse(value),
      decodeW5WorktreeOutcome,
      row(),
      W5OutcomeDecodeError,
    );
  });

  it.each(rows)('%s row in a worktree update outcome', (_name, row) => {
    expectParity(
      (value): unknown => zodUpdate.parse(value),
      decodeW5WorktreeUpdateOutcome,
      { changed: true, worktree: row(), receipt: 'unknown' },
      W5OutcomeDecodeError,
    );
  });

  it.each(rows)('%s row in a branch rename outcome', (_name, row) => {
    expectParity(
      (value): unknown => zodRename.parse(value),
      decodeW5WorktreeBranchRenameOutcome,
      { worktree: row(), branchName: 'mike/next', previous: 'mike/old' },
      W5OutcomeDecodeError,
    );
  });

  it.each(rows)('%s row in a paused-hook outcome', (_name, row) => {
    const worktree = row();
    expectParity(
      (value): unknown => zodPaused.parse(value),
      decodeW5WorktreeHooksPausedOutcome,
      { changed: false, pausedHookKeys: ['setup'], worktree, hostOnly: '/w' },
      W5OutcomeDecodeError,
    );
    if (typeof worktree === 'object' && worktree !== null)
      for (const pausedHookKeys of [
        ['setup', 'run'],
        [],
        undefined,
        null,
        ['setup', 1],
        'setup',
      ])
        expectParity(
          (value) => zodPaused.parse(value),
          decodeW5WorktreeHooksPausedOutcome,
          {
            changed: false,
            pausedHookKeys: [],
            worktree: { ...worktree, pausedHookKeys },
          },
          W5OutcomeDecodeError,
        );
  });

  const workspace = (worktrees: unknown[]): Record<string, unknown> => ({
    id: 'ws-1',
    type: 'multi-repo',
    name: 'Workspace',
    color: '#000',
    order: 0,
    repos: [{ id: 'r-1', name: 'repo' }],
    worktrees,
  });
  const combine = (destinationWorktree: unknown): Record<string, unknown> => ({
    repoMappings: [{ destinationRepoId: 'r-1', repoName: 'repo' }],
    selectedRepoIdRewrites: {},
    sourceWorkspaceId: 'ws-0',
    sourceWorktreeId: 'wt-0',
    destinationWorkspaceId: 'ws-1',
    destinationWorktreeId: 'wt-1',
    destinationWorkspace: workspace([minimalRow]),
    destinationWorktree,
    createdTemporaryWorkspace: false,
    reusedWorkspace: true,
    removedSourceWorktree: true,
    sourceCheckoutPath: '/Users/me/checkout',
  });

  const joinedWorktree = (): Record<string, unknown> => ({
    repoMappings: [],
    selectedRepoIdRewrites: {},
    workspaceId: 'ws-2',
    worktreeId: 'wt-2',
  });
  const existingCombine = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...combine(minimalRow),
    joinedWorktree: joinedWorktree(),
    ...overrides,
  });

  function expectCompositionParity(
    oracle: z.ZodType,
    parser: W5OutcomeParser<unknown>,
    outcome: unknown,
  ): void {
    expectParity(
      (value) => decodeW5CompositionOutcome(oracle, value),
      (value) => decodeW5CompositionOutcome(parser, value),
      outcome,
      W5OutcomeDecodeError,
    );
    expectParity(
      (value) => oracle.parse(value),
      (value) => parser.parse(value),
      outcome,
      W5OutcomeDecodeError,
    );
  }

  it.each(rows)('%s row in composition outcomes', (_name, row) => {
    expectCompositionParity(
      zodWorkspace,
      w5PromoteOutcomeParser,
      workspace([minimalRow, row(), minimalRow]),
    );
    expectCompositionParity(zodCombine, w5CombineOutcomeParser, combine(row()));
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      existingCombine({ destinationWorkspace: workspace([row()]) }),
    );
  });

  /** Field variants at each composition level, against all three oracles. */
  const workspaceFields: ReadonlyArray<[string, () => unknown]> = [
    ['minimal', (): unknown => workspace([])],
    [
      'every field, out of order, with unknown host fields',
      (): unknown =>
        JSON.parse(
          `{"worktrees":[],"repos":[{"name":"repo","id":"r-1","repoPath":"/r"}],"temporary":true,"collapsed":false,"order":2,"color":"#fff","name":"W","type":"multi-repo","id":"ws-9","path":"/w","rootRepoId":"r-1"}`,
        ),
    ],
    [
      'explicitly undefined optional flags',
      (): unknown => ({
        ...workspace([]),
        collapsed: undefined,
        temporary: undefined,
      }),
    ],
    ['null collapsed', (): unknown => ({ ...workspace([]), collapsed: null })],
    ['string temporary', (): unknown => ({ ...workspace([]), temporary: 'y' })],
    ['negative zero order', (): unknown => ({ ...workspace([]), order: -0 })],
    ['fractional order', (): unknown => ({ ...workspace([]), order: 1.5 })],
    ['NaN order', (): unknown => ({ ...workspace([]), order: Number.NaN })],
    [
      'infinite order',
      (): unknown => ({ ...workspace([]), order: Number.POSITIVE_INFINITY }),
    ],
    [
      'negative infinite order',
      (): unknown => ({ ...workspace([]), order: Number.NEGATIVE_INFINITY }),
    ],
    ['string order', (): unknown => ({ ...workspace([]), order: '1' })],
    ['bigint order', (): unknown => ({ ...workspace([]), order: BigInt(1) })],
    ['single-repo type', (): unknown => ({ ...workspace([]), type: 'single' })],
    [
      'differently cased type',
      (): unknown => ({ ...workspace([]), type: 'Multi-Repo' }),
    ],
    ['missing type', (): unknown => ({ ...workspace([]), type: undefined })],
    ['numeric color', (): unknown => ({ ...workspace([]), color: 0 })],
    ['missing repos', (): unknown => ({ ...workspace([]), repos: undefined })],
    ['object repos', (): unknown => ({ ...workspace([]), repos: {} })],
    [
      'repo without a name',
      (): unknown => ({ ...workspace([]), repos: [{ id: 'r' }] }),
    ],
    ['null repo', (): unknown => ({ ...workspace([]), repos: [null] })],
    [
      'sparse repos',
      (): unknown => {
        const repos: unknown[] = [{ id: 'r', name: 'n' }];
        repos[2] = { id: 's', name: 'm' };
        return { ...workspace([]), repos };
      },
    ],
    [
      'missing worktrees',
      (): unknown => ({ ...workspace([]), worktrees: undefined }),
    ],
    [
      'inherited fields',
      (): unknown => withPrototype({ order: 3 }, workspace([minimalRow])),
    ],
    ['array workspace', (): unknown => [workspace([])]],
    ['null workspace', (): unknown => null],
  ];

  it.each(workspaceFields)(
    'promote and nested workspace with %s',
    (_name, value) => {
      expectCompositionParity(zodWorkspace, w5PromoteOutcomeParser, value());
      expectCompositionParity(zodCombine, w5CombineOutcomeParser, {
        ...combine(minimalRow),
        destinationWorkspace: value(),
      });
      expectCompositionParity(
        zodExistingCombine,
        w5ExistingCombineOutcomeParser,
        existingCombine({ destinationWorkspace: value() }),
      );
    },
  );

  /** Migration variants, applied at the top level and in the joined worktree. */
  const migrationFields: ReadonlyArray<
    [string, () => Record<string, unknown>]
  > = [
    [
      'every field with unknown host fields',
      (): Record<string, unknown> => ({
        repoMappings: [
          {
            repoPath: '/r',
            repoName: 'repo',
            destinationRepoId: 'r-2',
            sourceRepoId: 'r-1',
          },
          { destinationRepoId: 'r-3', repoName: 'other' },
        ],
        selectedRepoIdRewrites: { 'r-1': 'r-2', __proto__: 'x' },
        sourceRootRepoIdRewrite: 'r-2',
        removedTemporaryWorkspaceId: 'ws-t',
        checkoutPaths: ['/a'],
      }),
    ],
    [
      'explicitly undefined optional fields',
      (): Record<string, unknown> => ({
        repoMappings: [
          {
            sourceRepoId: undefined,
            destinationRepoId: 'r-2',
            repoName: 'repo',
          },
        ],
        sourceRootRepoIdRewrite: undefined,
        removedTemporaryWorkspaceId: undefined,
      }),
    ],
    [
      'null optional source repo',
      (): Record<string, unknown> => ({
        repoMappings: [
          { sourceRepoId: null, destinationRepoId: 'r', repoName: 'n' },
        ],
      }),
    ],
    [
      'null root rewrite',
      (): Record<string, unknown> => ({ sourceRootRepoIdRewrite: null }),
    ],
    [
      'numeric removed workspace',
      (): Record<string, unknown> => ({ removedTemporaryWorkspaceId: 1 }),
    ],
    [
      'mapping without a destination',
      (): Record<string, unknown> => ({
        repoMappings: [{ repoName: 'n' }],
      }),
    ],
    [
      'missing mappings',
      (): Record<string, unknown> => ({ repoMappings: undefined }),
    ],
    [
      'missing rewrites',
      (): Record<string, unknown> => ({ selectedRepoIdRewrites: undefined }),
    ],
    [
      'non-string rewrite',
      (): Record<string, unknown> => ({ selectedRepoIdRewrites: { r: 1 } }),
    ],
    [
      'array rewrites',
      (): Record<string, unknown> => ({ selectedRepoIdRewrites: ['r'] }),
    ],
    [
      'class-instance rewrites',
      (): Record<string, unknown> => ({
        selectedRepoIdRewrites: new (class Rewrites {
          r = 's';
        })(),
      }),
    ],
  ];

  it.each(migrationFields)('combine migration with %s', (_name, fields) => {
    expectCompositionParity(zodCombine, w5CombineOutcomeParser, {
      ...combine(minimalRow),
      ...fields(),
    });
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      existingCombine(fields()),
    );
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      existingCombine({ joinedWorktree: { ...joinedWorktree(), ...fields() } }),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing source workspace', { sourceWorkspaceId: undefined }],
    ['a numeric destination worktree id', { destinationWorktreeId: 1 }],
    ['a string created flag', { createdTemporaryWorkspace: 'false' }],
    ['a missing reused flag', { reusedWorkspace: undefined }],
    ['a null removed flag', { removedSourceWorktree: null }],
    ['a null destination worktree', { destinationWorktree: null }],
    ['a missing destination workspace', { destinationWorkspace: undefined }],
  ])('combine outcome with %s', (_name, overrides) => {
    expectCompositionParity(zodCombine, w5CombineOutcomeParser, {
      ...combine(minimalRow),
      ...overrides,
    });
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      existingCombine(overrides),
    );
  });

  it.each<[string, unknown]>([
    ['a missing joined worktree', undefined],
    ['a null joined worktree', null],
    ['an array joined worktree', [joinedWorktree()]],
    [
      'a joined worktree without its id',
      { ...joinedWorktree(), worktreeId: undefined },
    ],
    [
      'a joined worktree with a numeric workspace id',
      { ...joinedWorktree(), workspaceId: 2 },
    ],
    [
      'a joined worktree with unknown host fields',
      { ...joinedWorktree(), checkoutPath: '/j', status: 'active' },
    ],
  ])('existing combine outcome with %s', (_name, joined) => {
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      existingCombine({ joinedWorktree: joined }),
    );
  });

  it.each<[string, unknown]>([
    ['a null outcome', null],
    ['a string outcome', 'ws-1'],
    ['an array outcome', [combine(minimalRow)]],
  ])('combine outcomes refuse %s', (_name, outcome) => {
    expectCompositionParity(zodCombine, w5CombineOutcomeParser, outcome);
    expectCompositionParity(
      zodExistingCombine,
      w5ExistingCombineOutcomeParser,
      outcome,
    );
  });

  it('decodes a combine outcome as the existing-worktree variant only with its joined worktree', () => {
    const outcome = combine(minimalRow);
    expect(w5CombineOutcomeParser.parse(outcome)).not.toHaveProperty(
      'sourceCheckoutPath',
    );
    expect(() => w5ExistingCombineOutcomeParser.parse(outcome)).toThrow(
      new W5OutcomeDecodeError('joinedWorktree'),
    );
    expect(
      w5CombineOutcomeParser.parse(existingCombine({})),
    ).not.toHaveProperty('joinedWorktree');
  });

  it('names nested composition fields by path', () => {
    expect(() =>
      w5ExistingCombineOutcomeParser.parse(
        existingCombine({
          destinationWorkspace: workspace([
            minimalRow,
            { ...minimalRow, id: 1 },
          ]),
        }),
      ),
    ).toThrow(new W5OutcomeDecodeError('destinationWorkspace.worktrees.1.id'));
    expect(() =>
      w5ExistingCombineOutcomeParser.parse(
        existingCombine({
          joinedWorktree: {
            ...joinedWorktree(),
            repoMappings: [{ destinationRepoId: 'r' }],
          },
        }),
      ),
    ).toThrow(
      new W5OutcomeDecodeError('joinedWorktree.repoMappings.0.repoName'),
    );
  });

  it.each<[string, unknown]>([
    ['missing changed', { worktree: minimalRow }],
    ['string changed', { worktree: minimalRow, changed: 'false' }],
    ['missing worktree', { changed: true }],
    ['null worktree', { worktree: null, changed: true }],
    ['array outcome', [minimalRow]],
    ['null outcome', null],
  ])('update outcome with %s', (_name, outcome) => {
    expectParity(
      (value): unknown => zodUpdate.parse(value),
      decodeW5WorktreeUpdateOutcome,
      outcome,
      W5OutcomeDecodeError,
    );
  });

  it.each<[string, unknown]>([
    ['a null worktree', { branchName: 'b', worktree: null }],
    ['a missing worktree', { branchName: 'b' }],
    ['an undefined worktree', { branchName: 'b', worktree: undefined }],
    ['a missing branch name', { worktree: minimalRow }],
    ['a null branch name', { branchName: null, worktree: minimalRow }],
    ['a string outcome', 'b'],
  ])('branch rename outcome with %s', (_name, outcome) => {
    expectParity(
      (value): unknown => zodRename.parse(value),
      decodeW5WorktreeBranchRenameOutcome,
      outcome,
      W5OutcomeDecodeError,
    );
  });

  it.each<[string, unknown]>([
    ['missing outcome keys', { worktree: minimalRow, changed: true }],
    [
      'null outcome keys',
      { worktree: minimalRow, pausedHookKeys: null, changed: true },
    ],
    [
      'non-string outcome keys',
      { worktree: minimalRow, pausedHookKeys: [1], changed: true },
    ],
    ['missing changed', { worktree: minimalRow, pausedHookKeys: [] }],
    ['a null worktree', { worktree: null, pausedHookKeys: [], changed: true }],
    ['an array worktree', { worktree: [], pausedHookKeys: [], changed: true }],
  ])('paused-hook outcome with %s', (_name, outcome) => {
    expectParity(
      (value): unknown => zodPaused.parse(value),
      decodeW5WorktreeHooksPausedOutcome,
      outcome,
      W5OutcomeDecodeError,
    );
  });

  /** Whole saved outcomes as receipts hold them, with unknown fields at each level. */
  it.each<
    [string, (value: unknown) => unknown, (value: unknown) => unknown, string]
  >([
    [
      'worktree update',
      (value): unknown => zodUpdate.parse(value),
      decodeW5WorktreeUpdateOutcome,
      `{"changed":false,"previousRevision":3,"worktree":{"createdAt":"${createdAt}","branchName":"b","id":"wt-1","trackedBaseBranch":null,"replica":{"state":"present"}}}`,
    ],
    [
      'branch rename with a row',
      (value): unknown => zodRename.parse(value),
      decodeW5WorktreeBranchRenameOutcome,
      `{"worktree":{"id":"wt-1","branchName":"next","createdAt":"${createdAt}","includedRepoIds":["r-1"],"status":"active"},"branchName":"next","previousBranchName":"old"}`,
    ],
    [
      'branch rename without a row',
      (value): unknown => zodRename.parse(value),
      decodeW5WorktreeBranchRenameOutcome,
      '{"branchName":"next","worktree":null,"repoId":"r-1"}',
    ],
    [
      'paused-hook change',
      (value): unknown => zodPaused.parse(value),
      decodeW5WorktreeHooksPausedOutcome,
      `{"pausedHookKeys":["setup"],"worktree":{"pausedHookKeys":["setup"],"id":"wt-1","branchName":"b","createdAt":"${createdAt}","hidden":true,"chatBadges":{}},"changed":true,"workspaceId":"ws-1"}`,
    ],
    [
      'paused-hook change with a bad row key list',
      (value): unknown => zodPaused.parse(value),
      decodeW5WorktreeHooksPausedOutcome,
      `{"pausedHookKeys":[],"worktree":{"pausedHookKeys":[null],"id":"wt-1","branchName":"b","createdAt":"${createdAt}"},"changed":true}`,
    ],
  ])('saved %s outcome', (_name, oracle, decode, json) => {
    expectParity(oracle, decode, JSON.parse(json), W5OutcomeDecodeError);
  });

  it('names only the first invalid field, never its value', () => {
    const outcome = attempt(decodeW5WorktreeUpdateOutcome, {
      changed: true,
      worktree: {
        ...minimalRow,
        trackedRepoBaseBranches: { r: 'secret-branch', s: 1 },
      },
    });
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.error).toBeInstanceOf(W5OutcomeDecodeError);
    expect(outcome.error).toMatchObject({
      name: 'W5OutcomeDecodeError',
      path: 'worktree.trackedRepoBaseBranches.s',
      message:
        'Invalid operation outcome at worktree.trackedRepoBaseBranches.s.',
    });
    expect(String(outcome.error)).not.toContain('secret-branch');
  });
});
