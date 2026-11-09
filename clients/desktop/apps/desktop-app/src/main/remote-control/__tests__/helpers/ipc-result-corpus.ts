/**
 * Representative results and pushes of allowlisted controller channels
 * (`MOBILE_CONTROLLER_CHANNELS`), shaped like the desktop handlers return
 * them, plus the RPC envelopes that carry them.
 */
export interface CorpusEntry {
  channel: string;
  value: unknown;
}

function repeated(text: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${text} ${index}`).join(
    '\n',
  );
}

export function ipcResultCorpus(): CorpusEntry[] {
  const worktree = {
    id: 'wt_8f2c',
    name: 'opossum',
    branch: 'qrtp/migrate-website-remote-control',
    path: '/Users/example/.canopy/workspaces/canopy/worktrees/opossum',
    createdAt: '2026-11-07T21:14:03.120Z',
    paused: false,
    hooks: { setup: { status: 'complete', exitCode: 0 } },
  };
  const project = {
    id: 'proj_1',
    name: 'canopy',
    color: 'categorical-3',
    repositories: [{ id: 'repo_1', url: 'git@github.com:example/canopy.git' }],
    worktrees: [
      worktree,
      { ...worktree, id: 'wt_9a1d', name: 'badger', paused: true },
    ],
    settings: { planDetection: null, scripts: undefined },
  };
  const transcriptMessage = (index: number): Record<string, unknown> => ({
    id: `msg_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    createdAt: 1_762_560_000_000 + index * 1_000,
    parts: [
      {
        type: 'text',
        text: `Message ${index}: café ✓ ${'é'.repeat(index % 5)}`,
      },
      {
        type: 'tool',
        name: 'Bash',
        input: { command: 'pnpm run checks:dirty' },
        output: index % 3 === 0 ? null : { exitCode: 0, stdout: 'ok' },
      },
    ],
  });
  const sparseColumns: unknown[] = [];
  sparseColumns[3] = 'col-3';
  sparseColumns[1_000] = 'col-1000';
  return [
    { channel: 'projects:load', value: [project] },
    {
      channel: 'chat:get-transcript-page',
      value: {
        messages: Array.from({ length: 40 }, (_, index) =>
          transcriptMessage(index),
        ),
        cursor: { before: 'msg_0', hasMore: true },
      },
    },
    {
      channel: 'activity:file-diff',
      value: {
        path: 'packages/remote-session/src/index.ts',
        oldContent: repeated('export const before =', 400),
        newContent: repeated('export const after =', 420),
        binary: false,
      },
    },
    {
      channel: 'activity:changed-files',
      value: {
        files: [
          { path: 'a.ts', status: 'M', additions: 3, deletions: 1 },
          { path: 'b/中文.md', status: 'A', additions: 10, deletions: 0 },
        ],
        truncated: false,
      },
    },
    {
      channel: 'pipelines:read-step-log',
      value: {
        text: repeated('[step] building', 3_000),
        truncated: false,
        sizeBytes: 98_765,
      },
    },
    {
      channel: 'workspace-items:import-attachments',
      value: {
        attachments: [
          {
            name: 'shot.png',
            bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
          },
        ],
      },
    },
    {
      channel: 'pipelines:list-executions',
      value: new Map<string, unknown>([
        [
          'exec_1',
          { status: 'success', startedAt: new Date(1_762_560_000_000) },
        ],
        [
          'exec_2',
          {
            status: 'failure',
            error: { message: 'Step failed', code: 'E_STEP' },
          },
        ],
      ]),
    },
    {
      channel: 'preferences:load',
      value: {
        theme: 'dark',
        uiScale: 1.25,
        disabledBuiltinGlobIds: new Set(['node_modules', 'dist']),
        maxConcurrentChats: 2 ** 31,
        fractional: -0.5,
        missing: undefined,
        nothing: null,
      },
    },
    {
      channel: 'chat:state-changed',
      value: [{ chatId: 'c1', state: 'running' }, 'main'],
    },
    { channel: 'worktree:get-path', value: '/tmp/中文/路径' },
    { channel: 'chat:cancel', value: undefined },
    {
      channel: 'model-registry:get',
      value: { columns: sparseColumns, version: 7n },
    },
  ];
}

/** RPC envelopes as the desktop host sends them for a corpus entry. */
export function rpcEnvelopes(entry: CorpusEntry, id: number): unknown[] {
  return [
    {
      kind: 'request',
      id,
      method: 'ipc.invoke',
      params: { channel: entry.channel, args: [] },
    },
    { kind: 'response', id, ok: true, value: entry.value },
    {
      kind: 'event',
      name: 'ipc.push',
      payload: { channel: entry.channel, args: [entry.value] },
    },
  ];
}
