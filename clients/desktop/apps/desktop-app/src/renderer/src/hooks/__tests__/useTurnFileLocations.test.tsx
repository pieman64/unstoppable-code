/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JSX } from 'react';
import { isTurnFileRecord } from '@canopy/protocol/turn-files';
import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import type {
  FileReferenceResolveRequest,
  FileReferenceResolveResponse,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import {
  useTurnFileLocations,
  type TurnFileLocationsTarget,
} from '../useTurnFileLocations';
import { resetTurnFileRootsCacheForTests } from '@/lib/turn-file-locations';
import { collectTurnFiles } from '@canopy/desktop-shared/lib/turn-files';
import { desktopTurnApprovalWait } from '@/components/chat/tool-approval-matching';
import type { DisplayMessage } from '@/components/chat/types';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const target: TurnFileLocationsTarget = {
  projectId: 'project',
  worktreeId: 'worktree',
};
const roots: FileTreeRootsResponse = {
  roots: [
    {
      repoId: 'project',
      repoName: 'project',
      absolutePath: '/ws',
      rootKind: 'git-repo',
    },
  ],
};
const existing = new Set(['/ws/report.md', '/ws/out/page.html']);
const getFileTreeRoots = jest.fn<
  Promise<FileTreeRootsResponse>,
  [FileTreeRootsRequest]
>();
const resolveFileReference = jest.fn<
  Promise<FileReferenceResolveResponse>,
  [FileReferenceResolveRequest]
>();

let observed: ReturnType<typeof useTurnFileLocations> | undefined;
function Probe({
  files,
  complete,
  noTarget = false,
}: {
  files: readonly TranscriptTurnFile[];
  complete: boolean;
  noTarget?: boolean;
}): JSX.Element {
  observed = useTurnFileLocations(
    noTarget ? undefined : target,
    files,
    complete,
  );
  return <div />;
}

async function flush(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  resetTurnFileRootsCacheForTests();
  getFileTreeRoots.mockReset().mockResolvedValue(roots);
  resolveFileReference.mockReset().mockImplementation((request) =>
    Promise.resolve(
      request.href === 'dir'
        ? {
            absolutePath: request.baseFilePath,
            filename: 'dir',
            kind: 'directory',
          }
        : existing.has(request.baseFilePath)
          ? {
              absolutePath: request.baseFilePath,
              filename: request.href,
              kind: 'file',
            }
          : null,
    ),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getFileTreeRoots, resolveFileReference },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  observed = undefined;
});

afterEach(async () => {
  await flush(() => root.unmount());
  container.remove();
});

it('keeps only files that exist inside a target root and reports pending creations', async () => {
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'ready' },
    { path: '/ws/missing.md', state: 'ready' },
    { path: '/tmp/outside.md', state: 'ready' },
    { path: '/ws/dir', state: 'ready' },
    { path: '/ws/failed.md', state: 'failed' },
    { path: '/ws/pending.md', state: 'creating' },
  ];
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.pending).toEqual([
    { path: '/ws/pending.md', state: 'creating' },
  ]);
  expect(observed?.located).toEqual([
    {
      path: '/ws/report.md',
      absolutePath: '/ws/report.md',
      repoId: 'project',
      relativePath: 'report.md',
    },
  ]);
  // Outside-root paths never reach the host resolver.
  expect(resolveFileReference).not.toHaveBeenCalledWith(
    expect.objectContaining({ baseFilePath: '/tmp/outside.md' }),
  );
  expect(resolveFileReference).toHaveBeenCalledWith({
    projectId: 'project',
    worktreeId: 'worktree',
    baseFilePath: '/ws/report.md',
    href: 'report.md',
  });
});

it('carries the updated classification onto located and pending files', async () => {
  const updated: TranscriptTurnFile = {
    path: '/ws/report.md',
    state: 'ready',
    change: 'updated',
  };
  const updating: TranscriptTurnFile = {
    path: '/ws/out/page.html',
    state: 'creating',
    change: 'updated',
  };
  await flush(() =>
    root.render(<Probe files={[updated, updating]} complete={false} />),
  );
  expect(observed?.pending).toEqual([updating]);
  expect(observed?.located).toEqual([
    {
      path: '/ws/report.md',
      absolutePath: '/ws/report.md',
      repoId: 'project',
      relativePath: 'report.md',
      change: 'updated',
    },
  ]);

  // A later successful Write reclassifies the file as saved.
  await flush(() =>
    root.render(
      <Probe files={[{ path: '/ws/report.md', state: 'ready' }]} complete />,
    ),
  );
  expect(observed?.located).toEqual([
    {
      path: '/ws/report.md',
      absolutePath: '/ws/report.md',
      repoId: 'project',
      relativePath: 'report.md',
    },
  ]);
});

it('deduplicates resolved relative and absolute identities with saved precedence', async () => {
  await flush(() =>
    root.render(
      <Probe
        files={[
          { path: 'report.md', state: 'ready', change: 'updated' },
          { path: '/ws/report.md', state: 'ready', saved: true },
        ]}
        complete
      />,
    ),
  );
  expect(observed?.located).toHaveLength(1);
  expect(observed?.located[0]?.change).toBeUndefined();
});

it('keeps updated classification when ShowFiles presents the same absolute file', async () => {
  const files = collectTurnFiles([
    {
      id: 'edit',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'edit',
          toolName: 'Edit',
          input: '{"file_path":"report.md"}',
          result: { output: 'Done', isError: false },
        },
        {
          type: 'tool_use',
          toolUseId: 'show',
          toolName: 'ShowFiles',
          input: '{}',
          result: {
            output:
              '{"files":[{"path":"/ws/report.md","absolutePath":"/ws/report.md","ok":true}]}',
            isError: false,
          },
        },
      ],
    },
  ]);
  await flush(() => root.render(<Probe files={files} complete />));
  expect(observed?.located).toHaveLength(1);
  expect(observed?.located[0]?.change).toBe('updated');
});

it.each(['creating', 'failed'] as const)(
  'reconciles %s relative edits before exposing an absolute presentation',
  async (state) => {
    await flush(() =>
      root.render(
        <Probe
          files={[
            { path: '/ws/report.md', state: 'ready' },
            { path: 'report.md', state, change: 'updated' },
          ]}
          complete={state === 'failed'}
        />,
      ),
    );
    expect(observed?.located).toEqual([]);
    expect(observed?.pending).toHaveLength(state === 'creating' ? 1 : 0);
  },
);

it.each(['creating', 'failed'] as const)(
  'keeps a successful saved file over its %s canonical retry',
  async (state) => {
    await flush(() =>
      root.render(
        <Probe
          files={[
            { path: '/ws/report.md', state: 'ready', saved: true },
            { path: 'report.md', state, change: 'updated' },
          ]}
          complete={state === 'failed'}
        />,
      ),
    );
    expect(observed?.located).toHaveLength(1);
    expect(observed?.located[0]?.saved).toBe(true);
    expect(observed?.pending).toEqual([]);
  },
);

it('keeps a pending edit disabled while its roots lookup is unavailable', async () => {
  getFileTreeRoots.mockRejectedValueOnce(new Error('offline'));
  const file: TranscriptTurnFile = {
    path: 'report.md',
    state: 'creating',
    change: 'updated',
  };
  await flush(() => root.render(<Probe files={[file]} complete={false} />));
  expect(observed?.located).toEqual([]);
  expect(observed?.pending).toEqual([file]);
});

it('does not turn an unfinished update into a ready chip when the turn ends', async () => {
  await flush(() =>
    root.render(
      <Probe
        files={[
          { path: '/ws/report.md', state: 'creating', change: 'updated' },
        ]}
        complete
      />,
    ),
  );
  expect(observed?.located).toEqual([]);
});

it('re-checks a creation once it completes and checks every file after the turn ends', async () => {
  const creating: TranscriptTurnFile[] = [
    { path: '/ws/out/page.html', state: 'creating' },
  ];
  await flush(() => root.render(<Probe files={creating} complete={false} />));
  expect(observed?.pending).toHaveLength(1);
  expect(observed?.located).toEqual([]);
  expect(resolveFileReference).not.toHaveBeenCalled();

  const ready: TranscriptTurnFile[] = [
    { path: '/ws/out/page.html', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={ready} complete={false} />));
  expect(observed?.pending).toEqual([]);
  expect(observed?.located.map((file) => file.relativePath)).toEqual([
    'out/page.html',
  ]);

  // A turn that ended with a creation still marked in flight checks the disk
  // instead of presenting a dead tile.
  const stale: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'creating' },
    { path: '/ws/missing.md', state: 'creating' },
  ];
  await flush(() => root.render(<Probe files={stale} complete />));
  expect(observed?.pending).toEqual([]);
  expect(observed?.located.map((file) => file.relativePath)).toEqual([
    'report.md',
  ]);
  // The end-of-turn recheck reads the roots again, once for the whole turn.
  expect(getFileTreeRoots).toHaveBeenCalledTimes(2);
});

it('retries once when a host check fails instead of hiding the file for good', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  try {
    resolveFileReference
      .mockReset()
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValue({
        absolutePath: '/ws/report.md',
        filename: 'report.md',
        kind: 'file',
      });
    const files: TranscriptTurnFile[] = [
      { path: '/ws/report.md', state: 'ready' },
    ];
    await flush(() => root.render(<Probe files={files} complete />));
    expect(observed?.located).toEqual([]);
    await flush(() => {
      jest.advanceTimersByTime(2_000);
    });
    expect(resolveFileReference).toHaveBeenCalledTimes(2);
    expect(observed?.located.map((file) => file.relativePath)).toEqual([
      'report.md',
    ]);
  } finally {
    jest.useRealTimers();
  }
});

it('never turns a failed write into a chip, even when the path exists after the turn', async () => {
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'failed' },
    { path: '/ws/out/page.html', state: 'creating' },
  ];
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.located).toEqual([]);
  await flush(() => root.render(<Probe files={files} complete />));
  expect(observed?.located.map((file) => file.relativePath)).toEqual([
    'out/page.html',
  ]);
  expect(resolveFileReference).not.toHaveBeenCalledWith(
    expect.objectContaining({ baseFilePath: '/ws/report.md' }),
  );
});

it('keeps a finished creation visible as pending until its check answers', async () => {
  let answer: (value: FileReferenceResolveResponse) => void = () => {};
  resolveFileReference.mockReset().mockImplementation(
    () =>
      new Promise<FileReferenceResolveResponse>((resolve) => {
        answer = resolve;
      }),
  );
  const creating: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'creating' },
  ];
  await flush(() => root.render(<Probe files={creating} complete={false} />));
  expect(observed?.pending).toEqual(creating);
  expect(observed?.settled).toBe(true);
  const ready: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={ready} complete={false} />));
  // Still shown while the host has not answered, so the summary stays put.
  expect(observed?.pending).toEqual(ready);
  expect(observed?.located).toEqual([]);
  expect(observed?.settled).toBe(true);
  await flush(() =>
    answer({
      absolutePath: '/ws/report.md',
      filename: 'report.md',
      kind: 'file',
    }),
  );
  expect(observed?.pending).toEqual([]);
  expect(observed?.located.map((file) => file.relativePath)).toEqual([
    'report.md',
  ]);
});

it('reports a turn that mounted complete as unsettled until its first answer', async () => {
  let answer: (value: FileReferenceResolveResponse) => void = () => {};
  resolveFileReference.mockReset().mockImplementation(
    () =>
      new Promise<FileReferenceResolveResponse>((resolve) => {
        answer = resolve;
      }),
  );
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={files} complete />));
  expect(observed?.settled).toBe(false);
  expect(observed?.pending).toEqual([]);
  await flush(() =>
    answer({
      absolutePath: '/ws/report.md',
      filename: 'report.md',
      kind: 'file',
    }),
  );
  expect(observed?.settled).toBe(true);
  expect(observed?.located).toHaveLength(1);
  await flush(() => root.render(<Probe files={[]} complete />));
  expect(observed?.settled).toBe(true);
});

it('shows nothing, not even pending creations, without a chat target', async () => {
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'creating' },
    { path: '/ws/out/page.html', state: 'ready' },
  ];
  await flush(() =>
    root.render(<Probe files={files} complete={false} noTarget />),
  );
  expect(observed?.pending).toEqual([]);
  expect(observed?.located).toEqual([]);
  expect(observed?.settled).toBe(true);
  expect(resolveFileReference).not.toHaveBeenCalled();
});

it('checks a large turn a few files at a time instead of all at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  resolveFileReference.mockReset().mockImplementation(async (request) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return {
      absolutePath: request.baseFilePath,
      filename: request.href,
      kind: 'file',
    };
  });
  const files: TranscriptTurnFile[] = Array.from({ length: 20 }, (_, i) => ({
    path: `/ws/part-${i}.md`,
    state: 'ready',
  }));
  await flush(() => root.render(<Probe files={files} complete />));
  for (let i = 0; i < 6; i += 1) await flush(() => {});
  expect(observed?.located).toHaveLength(20);
  expect(maxInFlight).toBeLessThanOrEqual(8);
});

it('re-checks an unchanged ready file when the turn completes', async () => {
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.located).toHaveLength(1);
  resolveFileReference.mockResolvedValue(null);
  await flush(() => root.render(<Probe files={files} complete />));
  expect(resolveFileReference).toHaveBeenCalledTimes(2);
  expect(observed?.located).toEqual([]);
});

it('retries a transient host failure without a new transcript event', async () => {
  jest.useFakeTimers();
  try {
    const files: TranscriptTurnFile[] = [
      { path: '/ws/report.md', state: 'ready' },
    ];
    resolveFileReference.mockRejectedValueOnce(new Error('temporary failure'));
    await flush(() => root.render(<Probe files={files} complete={false} />));
    expect(observed?.located).toEqual([]);
    await flush(() => jest.advanceTimersByTime(2_000));
    expect(observed?.located.map((file) => file.relativePath)).toEqual([
      'report.md',
    ]);
    expect(resolveFileReference).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

it('reuses a recent existence answer across remounts', async () => {
  const files: TranscriptTurnFile[] = [
    { path: '/ws/report.md', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.located).toHaveLength(1);
  await flush(() => root.unmount());
  root = createRoot(container);
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.located).toHaveLength(1);
  expect(resolveFileReference).toHaveBeenCalledTimes(1);
});

it('uses an explicitly selected workspace per file and hides everything when roots are unavailable', async () => {
  const other = { projectId: 'other', worktreeId: 'entry' };
  getFileTreeRoots.mockImplementation((request) =>
    request.projectId === 'other'
      ? Promise.resolve({
          roots: [
            {
              repoId: 'other',
              repoName: 'other',
              absolutePath: '/other',
              rootKind: 'standalone',
            },
          ],
        })
      : Promise.reject(new Error('unavailable')),
  );
  existing.add('/other/report.md');
  const files: TranscriptTurnFile[] = [
    { path: '/other/report.md', state: 'ready', target: other },
    { path: '/ws/report.md', state: 'ready' },
  ];
  await flush(() => root.render(<Probe files={files} complete />));
  expect(observed?.located).toEqual([
    {
      path: '/other/report.md',
      absolutePath: '/other/report.md',
      repoId: 'other',
      relativePath: 'report.md',
      target: other,
    },
  ]);
  expect(resolveFileReference).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'other', worktreeId: 'entry' }),
  );
  await flush(() => root.render(<Probe files={files} complete noTarget />));
  expect(observed?.located).toEqual([]);
  expect(observed?.pending).toEqual([]);
});

it.each(['move', 'delete'] as const)(
  'retires an absolute source after a relative %s with a warm existence cache',
  async (operation) => {
    const initial = collectTurnFiles([
      {
        id: 'absolute-write',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'write-1',
            toolName: 'Write',
            input: '{"file_path":"/ws/report.md"}',
            result: { output: 'Done', isError: false },
          },
        ],
      },
    ]);
    await flush(() => root.render(<Probe files={initial} complete={false} />));
    expect(observed?.located).toHaveLength(1);
    existing.delete('/ws/report.md');
    existing.add('/ws/renamed.md');
    try {
      const files = collectTurnFiles(
        [
          {
            id: operation,
            role: 'assistant',
            timestamp: 2,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'patch-1',
                toolName: 'apply_patch',
                input:
                  operation === 'move'
                    ? '*** Update File: report.md\n*** Move to: renamed.md\n@@\n-old\n+new'
                    : '*** Delete File: report.md',
                result: { output: 'Done', isError: false },
              },
            ],
          },
        ],
        initial,
      );
      await flush(() => root.render(<Probe files={files} complete={false} />));
      expect(observed?.located.map((file) => file.relativePath)).toEqual(
        operation === 'move' ? ['renamed.md'] : [],
      );
      if (operation === 'move') {
        expect(observed?.located[0]?.saved).toBe(true);
        expect(observed?.located[0]?.change).toBeUndefined();
      }
      expect(observed?.pending).toEqual([]);
    } finally {
      existing.add('/ws/report.md');
      existing.delete('/ws/renamed.md');
    }
  },
);

it('keeps recreated sources and pre-move provenance after JSON reload and overlapping replay', async () => {
  const event = (
    id: string,
    toolName: string,
    input: string,
  ): Parameters<typeof collectTurnFiles>[0][number] => ({
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: id,
        toolName,
        input,
        result: { output: 'Done', isError: false },
      },
    ],
  });
  const edit = event('first-edit', 'Edit', '{"file_path":"/ws/report.md"}');
  const move = event(
    'move',
    'apply_patch',
    '*** Update File: report.md\n*** Move to: renamed.md\n@@\n-old\n+new',
  );
  const snapshot = collectTurnFiles([edit, move]);
  const retained: unknown = JSON.parse(JSON.stringify(snapshot));
  if (!Array.isArray(retained) || !retained.every(isTurnFileRecord))
    throw new Error('Invalid evidence round trip');
  const files = collectTurnFiles(
    [
      edit,
      move,
      event('recreate-source', 'Write', '{"file_path":"/ws/report.md"}'),
      event('edit-destination', 'Edit', '{"file_path":"renamed.md"}'),
    ],
    retained,
  );
  expect(files.find((file) => file.evidence)?.evidence).toHaveLength(4);
  existing.add('/ws/renamed.md');
  existing.delete('/ws/report.md');
  try {
    await flush(() => root.render(<Probe files={snapshot} complete={false} />));
    expect(observed?.located.map((file) => file.relativePath)).toEqual([
      'renamed.md',
    ]);
    existing.add('/ws/report.md');
    await flush(() => root.render(<Probe files={files} complete={false} />));
    expect(observed?.located).toHaveLength(2);
    expect(
      observed?.located.find((file) => file.relativePath === 'report.md')
        ?.saved,
    ).toBe(true);
    expect(
      observed?.located.find((file) => file.relativePath === 'renamed.md')
        ?.change,
    ).toBe('updated');
    expect(
      observed?.located.find((file) => file.relativePath === 'renamed.md')
        ?.saved,
    ).toBeUndefined();
  } finally {
    existing.add('/ws/report.md');
    existing.delete('/ws/renamed.md');
  }
});

it('preserves an explicit receipt alias into a secondary root during ordered replay', async () => {
  getFileTreeRoots.mockResolvedValue({
    roots: [
      ...roots.roots,
      {
        repoId: 'secondary',
        repoName: 'secondary',
        absolutePath: '/ws/secondary',
        rootKind: 'git-repo',
      },
    ],
  });
  existing.add('/ws/secondary/report.md');
  try {
    const files = collectTurnFiles([
      {
        id: 'alias-write',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'alias-write',
            toolName: 'Write',
            input: '{"file_path":"report.md"}',
            result: { output: 'Done', isError: false },
          },
        ],
      },
      {
        id: 'alias-receipt',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'alias-receipt',
            toolName: 'ShowFiles',
            input: '{}',
            result: {
              output:
                '{"files":[{"path":"report.md","absolutePath":"/ws/secondary/report.md","ok":true}]}',
              isError: false,
            },
          },
        ],
      },
    ]);
    await flush(() => root.render(<Probe files={files} complete={false} />));
    expect(observed?.located).toHaveLength(1);
    expect(observed?.located[0]?.absolutePath).toBe('/ws/secondary/report.md');
    expect(observed?.located[0]?.saved).toBe(true);
  } finally {
    existing.delete('/ws/secondary/report.md');
  }
});

it('keeps approval waiting through canonical relative/absolute aggregation without a receipt', async () => {
  const messages: DisplayMessage[] = [
    {
      id: 'mixed-edits',
      role: 'assistant',
      timestamp: 0,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'waiting',
          toolName: 'Edit',
          input: JSON.stringify({ file_path: 'report.md' }),
        },
        {
          type: 'tool_use',
          toolUseId: 'executing',
          toolName: 'Edit',
          input: JSON.stringify({ file_path: '/ws/report.md' }),
        },
      ],
    },
  ];
  const files = collectTurnFiles(messages);
  await flush(() => root.render(<Probe files={files} complete={false} />));
  expect(observed?.pending).toEqual([
    { path: '/ws/report.md', state: 'creating', change: 'updated' },
  ]);
  const wait = desktopTurnApprovalWait(
    [
      {
        requestId: 'waiting-approval',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        provider: 'claude',
        title: 'Edit file',
        toolUseId: 'waiting',
        details: { kind: 'file-write', path: 'report.md' },
      },
    ],
    messages,
    files,
    observed?.pendingPathAliases,
  );
  expect(wait.isCallWaiting({ toolUseId: 'waiting', toolName: 'Edit' })).toBe(
    true,
  );
  expect(wait.isCallWaiting({ toolUseId: 'executing', toolName: 'Edit' })).toBe(
    false,
  );
  expect(wait.isFileWaiting('/ws/report.md')).toBe(true);
  expect(wait.isFileWaiting('/other/report.md')).toBe(false);
  await flush(() => root.render(<Probe files={[]} complete={false} />));
  expect(observed?.pendingPathAliases).toEqual([]);
});
