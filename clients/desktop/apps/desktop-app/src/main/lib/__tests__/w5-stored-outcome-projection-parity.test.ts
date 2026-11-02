import { z } from 'zod';
import {
  projectW5ReorderOutcome,
  projectW5WorkspaceCreationOutcome,
  projectW5WorktreeCreationOutcome,
  W5OutcomeDecodeError,
} from '@canopy/core-runtime/node/w5/stored-outcome-projection';

/*
 * CAN-5428 reference oracle: the zod schemas desktop main replays these
 * receipts with (workspace-creation.ts, worktree-creation.ts,
 * workspace-metadata.ts), copied verbatim. A projector must accept exactly
 * the stored outcomes desktop replay accepts, and project only what that
 * replay keeps. Update both together.
 */
const workspaceReceipt = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['single-repo', 'multi-repo', 'cowork']),
    color: z.string(),
    order: z.number(),
    collapsed: z.boolean().optional(),
  }),
  clonedRepoIds: z.array(z.string()),
  scriptActionsOperationId: z.string().optional(),
});
const createdReceipt = z.object({
  status: z.literal('created'),
  workspaceKind: z.enum(['single-repo', 'multi-repo']),
  record: z.object({
    worktreeId: z.string(),
    branchName: z.string(),
    createdAt: z.string(),
    setupPhase: z.enum(['git-pending', 'git-ready']),
    trackedBaseBranch: z.string().nullable(),
    trackedRepoBaseBranches: z.record(z.string(), z.string()),
    includedRepoIds: z.array(z.string()).nullable(),
  }),
  response: z.object({
    id: z.string(),
    branchName: z.string(),
    createdAt: z.string(),
    setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
    trackedBaseBranch: z.string().nullable().optional(),
    trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
  }),
});
const repairIssues = z.array(
  z.object({
    code: z.enum([
      'missing-gitignore',
      'invalid-gitignore',
      'missing-canopy-json',
      'invalid-canopy-json',
      'missing-claude-md',
      'invalid-agents-md',
    ]),
    message: z.string(),
    blocking: z.boolean(),
  }),
);
const worktreeReceipt = z.union([
  createdReceipt,
  z.object({
    status: z.literal('needs-repair'),
    workspaceKind: z.literal('multi-repo'),
    worktreeId: z.string(),
    branchName: z.string(),
    repairIssues,
    response: z.object({
      id: z.string(),
      branchName: z.string(),
      existingBranch: z.string().optional(),
      trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
      needsRepair: z.literal(true),
      repairIssues,
    }),
  }),
]);
const workspaceReorder = z.object({ workspaceIds: z.array(z.string()) });

const context = { workspaceId: 'ws' };
const createdAt = '2026-10-01T12:00:00.000Z';

function accepts(decode: (value: unknown) => unknown, value: unknown): boolean {
  try {
    decode(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same acceptance; a refusal is a W5OutcomeDecodeError; an accepted stored
 * outcome projects as the stored form of desktop's own replay value does, so
 * nothing desktop strips reaches a result.
 */
function expectParity(
  oracle: z.ZodType,
  project: (value: unknown) => unknown,
  input: unknown,
): void {
  const accepted = accepts((value) => oracle.parse(value), input);
  if (!accepted) {
    expect(() => project(input)).toThrow(W5OutcomeDecodeError);
    return;
  }
  const replayed: unknown = JSON.parse(JSON.stringify(oracle.parse(input)));
  expect(project(input)).toStrictEqual(project(replayed));
}

const workspace = {
  id: 'alpha',
  name: 'Alpha',
  type: 'single-repo',
  color: '#7C3AED',
  order: 0,
};
const workspaceCases: ReadonlyArray<[string, unknown]> = [
  ['a minimal receipt', { workspace, clonedRepoIds: [] }],
  [
    'host and unknown fields',
    {
      workspace: {
        ...workspace,
        type: 'multi-repo',
        repos: [{ id: 'api', repoPath: '/Users/alex/repos/api' }],
        sourceRepoPath: '/Users/alex/suite',
      },
      clonedRepoIds: ['api'],
      scriptActionsOperationId: 'op',
      warnings: ['/Users/alex'],
    },
  ],
  [
    'a cowork receipt',
    {
      workspace: { ...workspace, type: 'cowork', collapsed: true },
      clonedRepoIds: [],
    },
  ],
  [
    'an undefined collapsed flag',
    { workspace: { ...workspace, collapsed: undefined }, clonedRepoIds: [] },
  ],
  [
    'an undefined operation id',
    { workspace, clonedRepoIds: [], scriptActionsOperationId: undefined },
  ],
  [
    'a non-palette color',
    { workspace: { ...workspace, color: 'teal' }, clonedRepoIds: [] },
  ],
  [
    'an empty name',
    { workspace: { ...workspace, name: '' }, clonedRepoIds: [] },
  ],
  [
    'negative zero and fractional orders',
    { workspace: { ...workspace, order: -0.5 }, clonedRepoIds: [] },
  ],
  // Refused.
  ['a null receipt', null],
  ['an array receipt', []],
  ['a string receipt', 'alpha'],
  ['a missing workspace', { clonedRepoIds: [] }],
  [
    'a capitalised type',
    { workspace: { ...workspace, type: 'Single-repo' }, clonedRepoIds: [] },
  ],
  [
    'a numeric color',
    { workspace: { ...workspace, color: 7 }, clonedRepoIds: [] },
  ],
  [
    'a string order',
    { workspace: { ...workspace, order: '0' }, clonedRepoIds: [] },
  ],
  [
    'a NaN order',
    { workspace: { ...workspace, order: Number.NaN }, clonedRepoIds: [] },
  ],
  [
    'an infinite order',
    {
      workspace: { ...workspace, order: Number.POSITIVE_INFINITY },
      clonedRepoIds: [],
    },
  ],
  [
    'a null collapsed flag',
    { workspace: { ...workspace, collapsed: null }, clonedRepoIds: [] },
  ],
  ['missing cloned ids', { workspace }],
  ['a numeric cloned id', { workspace, clonedRepoIds: [1] }],
  // eslint-disable-next-line no-sparse-arrays
  ['a sparse cloned id list', { workspace, clonedRepoIds: ['a', , 'b'] }],
  [
    'a null operation id',
    { workspace, clonedRepoIds: [], scriptActionsOperationId: null },
  ],
  [
    'a numeric operation id',
    { workspace, clonedRepoIds: [], scriptActionsOperationId: 1 },
  ],
];

const record = {
  worktreeId: 'otter',
  branchName: 'otter-1',
  createdAt,
  setupPhase: 'git-ready',
  trackedBaseBranch: 'main',
  trackedRepoBaseBranches: {},
  includedRepoIds: null,
};
const response = { id: 'otter', branchName: 'otter-1', createdAt };
const created = {
  status: 'created',
  workspaceKind: 'single-repo',
  record,
  response,
};
const issue = {
  code: 'invalid-canopy-json',
  message:
    "ENOENT: no such file or directory, open '/Users/alex/suite/canopy.json'",
  blocking: true,
};
const repair = {
  status: 'needs-repair',
  workspaceKind: 'multi-repo',
  worktreeId: 'lynx',
  branchName: 'lynx-1',
  repairIssues: [issue],
  response: {
    id: 'lynx',
    branchName: 'lynx-1',
    needsRepair: true,
    repairIssues: [issue],
  },
};
const worktreeCases: ReadonlyArray<[string, unknown]> = [
  ['a created receipt', created],
  [
    'a deferred multi-repo receipt with host fields',
    {
      ...created,
      workspaceKind: 'multi-repo',
      record: {
        ...record,
        setupPhase: 'git-pending',
        trackedBaseBranch: null,
        trackedRepoBaseBranches: { api: 'develop' },
        includedRepoIds: ['api'],
      },
      response: {
        ...response,
        setupPhase: 'git-pending',
        trackedBaseBranch: null,
        trackedRepoBaseBranches: { api: 'develop' },
        worktreePath: '/Users/alex/wt/otter',
        repoPaths: { api: '/Users/alex/wt/otter/api' },
      },
    },
  ],
  ['a needs-repair receipt', repair],
  [
    'a needs-repair receipt with an existing branch',
    {
      ...repair,
      response: {
        ...repair.response,
        existingBranch: 'feature',
        trackedRepoBaseBranches: { api: 'main' },
      },
    },
  ],
  [
    'an empty repair list',
    {
      ...repair,
      repairIssues: [],
      response: { ...repair.response, repairIssues: [] },
    },
  ],
  // Refused.
  ['a null receipt', null],
  ['an unknown status', { ...created, status: 'pending' }],
  [
    'a needs-repair single-repo receipt',
    { ...repair, workspaceKind: 'single-repo' },
  ],
  ['a created cowork receipt', { ...created, workspaceKind: 'cowork' }],
  ['a missing record', { ...created, record: undefined }],
  [
    'an unknown setup phase',
    { ...created, record: { ...record, setupPhase: 'ready' } },
  ],
  [
    'an undefined tracked base',
    { ...created, record: { ...record, trackedBaseBranch: undefined } },
  ],
  [
    'an array of base branches',
    { ...created, record: { ...record, trackedRepoBaseBranches: [] } },
  ],
  [
    'a numeric base branch',
    { ...created, record: { ...record, trackedRepoBaseBranches: { api: 1 } } },
  ],
  [
    'undefined included repositories',
    { ...created, record: { ...record, includedRepoIds: undefined } },
  ],
  ['a missing response', { ...created, response: undefined }],
  [
    'a response without createdAt',
    { ...created, response: { id: 'otter', branchName: 'otter-1' } },
  ],
  [
    'a null response setup phase',
    { ...created, response: { ...response, setupPhase: null } },
  ],
  [
    'a numeric response base',
    { ...created, response: { ...response, trackedBaseBranch: 1 } },
  ],
  [
    'a null existing branch',
    { ...repair, response: { ...repair.response, existingBranch: null } },
  ],
  [
    'a string needsRepair',
    { ...repair, response: { ...repair.response, needsRepair: 'true' } },
  ],
  [
    'a missing response repair list',
    { ...repair, response: { ...repair.response, repairIssues: undefined } },
  ],
  [
    'an unknown repair code',
    { ...repair, repairIssues: [{ ...issue, code: 'missing-readme' }] },
  ],
  [
    'a non-string repair message',
    { ...repair, repairIssues: [{ ...issue, message: 1 }] },
  ],
  [
    'a string blocking flag',
    { ...repair, repairIssues: [{ ...issue, blocking: 'yes' }] },
  ],
];

describe('the stored-outcome projectors accept what desktop replay accepts', () => {
  it.each(workspaceCases)(
    'core.workspace.create / .import: %s',
    (_label, input) => {
      expectParity(workspaceReceipt, projectW5WorkspaceCreationOutcome, input);
    },
  );

  it.each(worktreeCases)('core.worktree.create: %s', (_label, input) => {
    expectParity(
      worktreeReceipt,
      (value) => projectW5WorktreeCreationOutcome(value, context),
      input,
    );
  });

  it.each([
    ['ids', { workspaceIds: ['b', 'a'] }],
    ['no ids', { workspaceIds: [] }],
    [
      'host fields',
      { workspaceIds: ['a'], indexPath: '/Users/alex/index.json' },
    ],
    ['a missing list', {}],
    ['a numeric id', { workspaceIds: [1] }],
    ['a null receipt', null],
  ])('core.workspace.reorder: %s', (_label, input) => {
    expectParity(
      workspaceReorder,
      (value) => projectW5ReorderOutcome('core.workspace.reorder', value),
      input,
    );
  });

  it('refuses a future version that desktop replay would strip', () => {
    const future = { workspace, clonedRepoIds: [], version: 2 };
    expect(workspaceReceipt.safeParse(future).success).toBe(true);
    expect(() => projectW5WorkspaceCreationOutcome(future)).toThrow(
      W5OutcomeDecodeError,
    );
  });
});
