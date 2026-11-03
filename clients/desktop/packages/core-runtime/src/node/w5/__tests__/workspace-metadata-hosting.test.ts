// W5d1 (CAN-5522): the hosted metadata commands' path-free messages, bounded
// retry, manifest edit and #3 result projection (W7a-3), below the daemon
// composition. The A7 table is
// `../../workspace/__tests__/metadata-commands.test.ts`.
import { CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS } from '../../workspace/metadata-commands';
import { toCoreWorkspaceMetadataWireError } from '../../workspace/metadata-wire-errors';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../commit-log-file-store';
import type { WorkspaceManifestRead } from '../workspace-manifest-repository';
import {
  projectW5Repository,
  readW5DecidedWorkspace,
  type W5DecidedWorkspaceReads,
} from '../workspace-metadata/decided-workspace';
import {
  applyW5ManifestChange,
  readW5ManifestView,
} from '../workspace-metadata/manifest-edit';
import { WorkspaceRepositoryRefusedError } from '../workspace-metadata/repositories';
import { createW5DecisionOnlyRetry } from '../workspace-metadata/retry';
import { ScriptHookSettingsRefusedError } from '../workspace-metadata/settings';

const SCRIPTS = 'core.workspace.scripts.update';

function message(error: Error): string {
  const mapped = toCoreWorkspaceMetadataWireError(
    CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS[SCRIPTS],
    SCRIPTS,
    error,
  );
  if (!(mapped instanceof CanopyOperationError)) throw new Error('untyped');
  return mapped.payload.message;
}

describe('hosted metadata wire messages', () => {
  it('never sends a host path in a message', () => {
    expect(
      message(
        new WorkspaceRepositoryRefusedError(
          'not-a-repository',
          'Not a git repository: /Users/me/repo',
        ),
      ),
    ).toBe('The selected folder is not a Git repository.');
    // A bare path, a path glued to other text, a Windows or UNC path and a
    // home path.
    for (const text of [
      'Missing /tmp/x',
      'Repo path=/Users/me/repo not found',
      'Missing (C:\\src\\repo)',
      'Missing \\\\server\\share',
      'Missing "~/repo".',
      'Missing x:file:///Users/me',
    ])
      expect(
        message(new ScriptHookSettingsRefusedError('not-found', text)),
      ).toBe('This change was refused.');
    for (const text of [
      'Repo web not found in project a',
      'Choose read/write access first.',
      'Shared-container recipient workspaces are read-only',
    ])
      expect(
        message(new ScriptHookSettingsRefusedError('not-found', text)),
      ).toBe(text);
  });
});

describe('the decision-only retry', () => {
  it('retries only a stale-file refusal, at most three attempts, counted per label', async () => {
    const retry = createW5DecisionOnlyRetry();
    let attempts = 0;
    await expect(
      retry.run('label', () => {
        attempts += 1;
        return Promise.reject(new W5FileWriteRefusedError('/x'));
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(
      retry.run('other', () => {
        attempts += 1;
        return Promise.reject(new W5RevisionConflictError('workspaces', 0, 1));
      }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(attempts).toBe(1);
    let landed = 0;
    await expect(
      retry.run('label', () => {
        landed += 1;
        return landed === 1
          ? Promise.reject(new W5FileWriteRefusedError('/x'))
          : Promise.resolve('ok');
      }),
    ).resolves.toBe('ok');
    expect(retry.counts()).toEqual(
      new Map([
        ['label fingerprint retried', 3],
        ['label fingerprint exhausted', 1],
      ]),
    );
  });
});

describe('the daemon manifest edit', () => {
  it('reads the desktop view, including the malformed memory rule and legacy scripts', () => {
    const parsed = readW5ManifestView({
      repoPath: '/repo',
      privateMemoryManagedBy: 'organization',
      setupScript: ' pnpm i ',
      repos: [{ id: 'web', name: 'web', repoPath: '/web' }, { id: 'bad' }],
    });
    expect(parsed.view).toEqual({
      type: 'single-repo',
      repos: [
        {
          id: 'web',
          name: 'web',
          repoPath: '/web',
          source: undefined,
          manifestUrl: undefined,
          scripts: undefined,
        },
      ],
      scripts: { setup: 'pnpm i' },
      privateMemoryManagedBy: 'organization',
    });
    expect(parsed.read).toEqual({ authority: 'ok', memoryMalformed: true });
  });

  it('reads an organization owner only from a well-formed binding, as the desktop read does', () => {
    const owner = {
      type: 'organization',
      organizationId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      instanceId: '33333333-3333-4333-8333-333333333333',
      bindingGeneration: 0,
    };
    expect(
      readW5ManifestView({ type: 'multi-repo', owner }).view.owner,
    ).toEqual({ type: 'organization' });
    for (const malformed of [
      { type: 'organization' },
      { ...owner, bindingGeneration: -1 },
      { type: 'personal' },
      'organization',
    ])
      expect(
        readW5ManifestView({ type: 'multi-repo', owner: malformed }).view,
      ).not.toHaveProperty('owner');
  });

  it('writes only the keys a change names, at the canonical position, and never plugin defaults', () => {
    const document = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'web', name: 'web', repoPath: '/web', future: 1 }],
      defaultPluginSelections: { collectionIds: ['x'] },
      setupScript: 'make',
      alwaysShow: true,
      unknown: true,
    };
    const parsed = readW5ManifestView(document);
    const next = applyW5ManifestChange(document, parsed, {
      privateMemory: true,
      itemSortMode: 'last-updated',
      scripts: { launch: 'pnpm dev' },
      repos: [
        ...parsed.view.repos,
        { id: 'api', name: 'api', repoPath: '/api' },
      ],
    });
    expect(Object.keys(next)).toEqual([
      'privateMemory',
      'version',
      'type',
      'repos',
      'itemSortMode',
      'defaultPluginSelections',
      'scripts',
      'alwaysShow',
      'unknown',
    ]);
    expect(next.defaultPluginSelections).toBe(document.defaultPluginSelections);
    expect(next.repos).toEqual([
      document.repos[0],
      { id: 'api', name: 'api', repoPath: '/api' },
    ]);
    // A manual sort mode is stored as no key, as the desktop write stores it.
    expect(
      applyW5ManifestChange(next, readW5ManifestView(next), {
        itemSortMode: 'manual',
      }),
    ).not.toHaveProperty('itemSortMode');
  });
});

describe("the daemon's #3 result projection (W7a-3)", () => {
  const entry = (
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: 'a',
    name: 'A',
    type: 'multi-repo',
    color: '#7C3AED',
    collapsed: false,
    order: 0,
    ...fields,
  });

  /** Reads of one stored index and one stored manifest. */
  function reads(
    entries: readonly Record<string, unknown>[],
    manifest: WorkspaceManifestRead,
  ): W5DecidedWorkspaceReads {
    return {
      index: {
        readStored: () =>
          Promise.resolve({
            authority: 'ok',
            entries: entries.map((stored) => ({
              id: String(stored.id),
              name: String(stored.name),
              type:
                stored.type === 'cowork' || stored.type === 'single-repo'
                  ? stored.type
                  : 'multi-repo',
              color:
                typeof stored.color === 'string' ? stored.color : '#7C3AED',
              collapsed: stored.collapsed === true,
              order: 0,
            })),
            storedFields: entries,
          }),
      },
      readManifest: () => Promise.resolve(manifest),
    };
  }

  const ok = (document: Record<string, unknown>): WorkspaceManifestRead => ({
    authority: 'ok',
    document,
    raw: JSON.stringify(document),
  });

  it('projects a stored remote as the desktop sanitizes it, never a path or credentials', () => {
    const project = (manifestUrl: string): unknown =>
      projectW5Repository({ id: 'r', name: 'R', manifestUrl });
    expect(project('https://u:secret@github.com/acme/r.git?x=1#y')).toEqual({
      id: 'r',
      name: 'R',
      manifestUrl: 'https://github.com/acme/r.git',
    });
    expect(project('git@github.com:acme/r.git')).toMatchObject({
      manifestUrl: 'git@github.com:acme/r.git',
    });
    for (const unsafe of [
      '/Users/me/origin.git',
      '~/origin.git',
      'C:\\origin.git',
      'file:///Users/me/origin.git',
      'deploy@github.com:acme/r.git',
    ])
      expect(project(unsafe)).toEqual({ id: 'r', name: 'R' });
  });

  it('applies the desktop read defaults, omits stored values outside their schema, and skips Cowork-only fields', async () => {
    await expect(
      readW5DecidedWorkspace(
        reads(
          [entry({ pinned: true, activitySectionOrder: ['plans', 'plans'] })],
          ok({
            type: 'multi-repo',
            repos: [
              {
                id: 'web',
                name: 'web',
                repoPath: '/Users/me/web',
                manifestUrl: 'https://github.com/acme/web.git',
              },
              { id: 'local', name: 'local', repoPath: '/Users/me/local' },
            ],
            alwaysShow: null,
            startPage: null,
          }),
        ),
        'a',
      ),
    ).resolves.toEqual({
      workspaceId: 'a',
      name: 'A',
      kind: 'git',
      repositorySources: [
        { repoId: 'web', remoteUrl: 'https://github.com/acme/web.git' },
      ],
      settings: {},
      color: '#7C3AED',
      pinned: true,
      collapsed: false,
      activitySectionOrder: ['plans'],
      itemSortMode: 'manual',
      startPage: null,
    });
    const cowork = await readW5DecidedWorkspace(
      reads(
        [entry({ type: 'cowork', activitySectionOrder: ['plans'] })],
        ok({ type: 'cowork', repos: [], startPage: { kind: 'url', url: 'x' } }),
      ),
      'a',
    );
    expect(cowork).toMatchObject({ kind: 'cowork', alwaysShow: true });
    expect(cowork).not.toHaveProperty('startPage');
    expect(cowork).not.toHaveProperty('activitySectionOrder');
    // An unproven manifest projects no manifest field.
    await expect(
      readW5DecidedWorkspace(
        reads([entry()], { authority: 'unreadable' }),
        'a',
      ),
    ).resolves.not.toHaveProperty('itemSortMode');
  });

  it('refuses a workspace the result cannot carry or deliver, result-unavailable', async () => {
    const refused = {
      payload: {
        kind: 'capability_unavailable',
        details: { reason: 'result-unavailable' },
        retry: { kind: 'never' },
      },
    };
    const empty = ok({ type: 'multi-repo', repos: [] });
    for (const entries of [
      [],
      [entry(), entry()],
      [entry({ name: 'n'.repeat(257) })],
    ])
      await expect(
        readW5DecidedWorkspace(reads(entries, empty), 'a'),
      ).rejects.toMatchObject(refused);
    const repos = Array.from({ length: 300 }, (_, index) => ({
      id: `r${index}`,
      name: 'r',
      repoPath: `/r${index}`,
      manifestUrl: `https://github.com/acme/${'u'.repeat(4000)}.git`,
    }));
    await expect(
      readW5DecidedWorkspace(
        reads([entry()], ok({ type: 'multi-repo', repos })),
        'a',
      ),
    ).rejects.toMatchObject(refused);
    // The desktop projection's own refusal of a stored id it cannot carry.
    await expect(
      readW5DecidedWorkspace(
        reads(
          [entry()],
          ok({
            type: 'multi-repo',
            repos: [{ id: 'r'.repeat(513), name: 'r', repoPath: '/r' }],
          }),
        ),
        'a',
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Workspace repository id exceeds 512 characters.',
        retry: { kind: 'never' },
      },
    });
  });
});
