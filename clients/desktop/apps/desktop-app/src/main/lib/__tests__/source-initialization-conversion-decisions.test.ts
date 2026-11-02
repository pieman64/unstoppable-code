// W6f2: pure apply and JSON decision semantics, not product lifecycle evidence.
import { jsonRecordRoundTrip as roundTrip } from './fixtures/json-record-round-trip';
import type {
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  admitSourceInitializationRecord,
  applySourceInitializationTo,
  applyWorkspaceConversionManifestTo,
  applyWorkspaceIndexDecisionTo,
  sourceInitializationHookOverlays,
  WorkspaceSourceRepoRefusedError,
  WorkspaceTypeConversionRefusedError,
} from '../worktree-record-decision-apply';
import type {
  SourceInitializationDecision,
  WorkspaceConversionManifestDecision,
} from '../worktree-record-decisions';

const sourceDecision: SourceInitializationDecision = {
  kind: 'workspace.source.initialize',
  sourceRepoPath: '/source',
  repositories: [
    {
      id: 'manifest',
      name: 'Old',
      repoPath: '/old',
      source: 'manifest',
      manifestUrl: 'https://example.test/repo',
    },
    { id: 'local', name: 'Local', repoPath: '/local', source: 'local' },
  ],
};
function config(): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    repos: [
      {
        id: 'manifest',
        name: 'Concurrent name',
        repoPath: '/new',
        scripts: { setup: 'new setup' },
        hooks: { setup: null },
      },
      {
        id: 'local',
        name: 'Local',
        repoPath: '/local',
        manifestUrl: 'old',
        scripts: { setup: 'local setup' },
      },
      {
        id: 'added',
        name: 'Added later',
        repoPath: '/added',
        scripts: { setup: 'added setup' },
      },
    ],
    scripts: { setup: 'moved to canopy.json' },
    hooks: {
      setup: null,
      teardown: [{ type: 'command', command: 'portable' }],
    },
    privateMemory: true,
  };
}
it('merges source decisions by ID over the locked read and preserves concurrent additions', () => {
  const current = config();
  const before = structuredClone(current);
  const decision = roundTrip(sourceDecision);
  admitSourceInitializationRecord('a', current, 'ok');
  applySourceInitializationTo(current, decision, true);
  expect(current).toEqual({
    ...before,
    scripts: undefined,
    hooks: { setup: null },
    sourceRepoPath: '/source',
    repos: [
      {
        ...before.repos[0],
        source: 'manifest',
        manifestUrl: 'https://example.test/repo',
        scripts: undefined,
        hooks: { setup: null },
      },
      { ...before.repos[1], source: 'local', manifestUrl: undefined },
      before.repos[2],
    ],
  });
  expect(decision).toEqual(sourceDecision);
});
it('handles an empty source build without replacing newly added repositories', () => {
  const current = config();
  const repos = structuredClone(current.repos);
  applySourceInitializationTo(
    current,
    { ...sourceDecision, repositories: [] },
    true,
  );
  expect(current.repos).toEqual(repos);
  expect(current.sourceRepoPath).toBe('/source');
});
it.each(['absent', 'bound'] as const)(
  'refuses %s source recording without mutations',
  (state) => {
    const current = config();
    if (state === 'bound') current.sourceRepoPath = '/rival';
    const before = structuredClone(current);
    expect(() =>
      admitSourceInitializationRecord(
        'a',
        current,
        state === 'absent' ? 'absent' : 'ok',
      ),
    ).toThrow(WorkspaceSourceRepoRefusedError);
    expect(current).toEqual(before);
  },
);
it.each([true, false])(
  'keeps local hook overlays with pipeline bindings enabled=%s',
  (enabled) => {
    const hooks: WorkspaceConfigFile['hooks'] = {
      setup: [
        {
          type: 'pipeline',
          source: 'project',
          id: 'pipeline',
          executionContext: 'local:machine',
        },
        { type: 'chat', prompt: 'run', executionContext: 'local:machine' },
        { type: 'command', command: 'portable' },
      ],
      teardown: null,
    };
    expect(sourceInitializationHookOverlays(hooks, enabled)).toEqual(
      enabled
        ? {
            setup: [
              {
                type: 'pipeline',
                source: 'project',
                id: 'pipeline',
                executionContext: 'local:machine',
                localExecutionContextOverlay: true,
              },
              {
                type: 'chat',
                prompt: 'run',
                executionContext: 'local:machine',
                localExecutionContextOverlay: true,
              },
            ],
            teardown: null,
          }
        : { teardown: null },
    );
    expect(
      sourceInitializationHookOverlays(undefined, enabled),
    ).toBeUndefined();
    expect(sourceInitializationHookOverlays({}, enabled)).toBeUndefined();
  },
);
it.each(['single-repo', 'multi-repo'] as const)(
  'conversion applies only the index type for %s',
  (type) => {
    const entries: WorkspaceIndexEntry[] = [
      {
        id: 'a',
        name: 'Concurrent name',
        type: 'single-repo',
        color: 'red',
        collapsed: true,
        order: 1,
      },
      {
        id: 'b',
        name: 'B',
        type: 'multi-repo',
        color: 'blue',
        collapsed: false,
        order: 0,
      },
    ];
    const before = structuredClone(entries);
    expect(
      applyWorkspaceIndexDecisionTo(entries, 'partial', {
        kind: 'workspace.conversion.index',
        workspaceId: 'a',
        type,
      }),
    ).toEqual([{ ...before[0], type }, before[1]]);
    expect(entries).toEqual(before);
  },
);
it('refuses a deleted conversion index target and does not touch the read', () => {
  const decision = {
    kind: 'workspace.conversion.index',
    workspaceId: 'a',
    type: 'single-repo',
  } as const;
  expect(() => applyWorkspaceIndexDecisionTo([], 'ok', decision)).toThrow(
    WorkspaceTypeConversionRefusedError,
  );
  expect(() =>
    applyWorkspaceIndexDecisionTo([], 'unreadable', decision),
  ).toThrow(WorkspaceTypeConversionRefusedError);
});
it('conversion clears omitted mapped fields across JSON and preserves fields outside its projection', () => {
  const current = config();
  current.sourceRepoPath = '/old';
  current.hooks = { setup: null };
  const decision: WorkspaceConversionManifestDecision = roundTrip({
    kind: 'workspace.conversion.manifest',
    config: { version: 1, type: 'single-repo', repoPath: '/repo', repos: [] },
    clear: ['sourceRepoPath', 'scripts', 'hooks'],
  });
  applyWorkspaceConversionManifestTo('a', current, 'ok', decision);
  expect(current).toEqual({
    version: 1,
    type: 'single-repo',
    repoPath: '/repo',
    repos: [],
    sourceRepoPath: undefined,
    scripts: undefined,
    hooks: undefined,
    privateMemory: true,
  });
});
it('refuses an absent conversion manifest without changing defaults', () => {
  const current = config();
  const before = structuredClone(current);
  expect(() =>
    applyWorkspaceConversionManifestTo('a', current, 'absent', {
      kind: 'workspace.conversion.manifest',
      config: { version: 1, type: 'single-repo', repos: [] },
      clear: [],
    }),
  ).toThrow(WorkspaceTypeConversionRefusedError);
  expect(current).toEqual(before);
});

describe('plain-data decision roundtrip verification', () => {
  it('accepts records from the native clone realm as well as the Jest realm', () => {
    const decision = {
      config: { scripts: undefined },
      clear: ['scripts'],
      repositories: [{ id: 'repo', source: 'local' }],
    };
    const nativeCopy = structuredClone(decision);
    const expected = {
      config: {},
      clear: ['scripts'],
      repositories: [{ id: 'repo', source: 'local' }],
    };
    expect(roundTrip(decision)).toEqual(expected);
    expect(roundTrip(nativeCopy)).toEqual(expected);
    expect(nativeCopy.config).toHaveProperty('scripts');
    expect(decision.config).toHaveProperty('scripts');
  });

  it('omits nested undefined object fields without mutating the decision', () => {
    const decision = {
      config: { path: undefined },
      rows: [{ path: undefined }],
      empty: [],
      value: null,
    };
    expect(roundTrip(decision)).toEqual({
      config: {},
      rows: [{}],
      empty: [],
      value: null,
    });
    expect(decision.config).toHaveProperty('path');
    expect(decision.rows[0]).toHaveProperty('path');
  });

  it.each([
    new Date(0),
    NaN,
    Infinity,
    -0,
    [undefined],
    new Map([['key', 'value']]),
  ])('rejects lossy non-record JSON input %#', (value) => {
    expect(() => roundTrip(value)).toThrow();
  });
});
