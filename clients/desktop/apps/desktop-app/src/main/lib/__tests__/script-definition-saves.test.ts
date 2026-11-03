// CAN-5369: the script settings saves are projections over
// core.script.definition.list, core.script.definition.upsert and
// core.script.definition.delete, whose host applies each change through
// core.workspace.scripts.update.
jest.mock('../script-definition-host', () => ({}));

import type {
  CoreScriptDefinitionsHost,
  CoreScriptLocalChange,
} from '@canopy/core-runtime/node/script/core-script-definitions';
import type { CoreScriptTarget } from '@canopy/protocol/canopy-core';
import type { ScriptSourceMap } from '@canopy/core-runtime/node/script/definitions';
import {
  DESKTOP_SCRIPT_CALLER,
  scriptDefinitionsDispatcher,
} from '../../__tests__/helpers/script-definitions-dispatcher';
import {
  mergeWorkspaceScriptCommands,
  saveProjectScripts,
  saveWorkspaceRepoScripts,
} from '../script-definition-saves';
import { ScriptHookSettingsRefusedError } from '../workspace-script-hook-settings';

interface Applied {
  target: CoreScriptTarget;
  change: CoreScriptLocalChange;
  idempotencyKey: string;
  expectedRevision?: number;
  source: string;
}

function host(
  local: Record<string, ScriptSourceMap | undefined>,
  revision?: number,
): {
  host: CoreScriptDefinitionsHost;
  applied: Applied[];
} {
  const applied: Applied[] = [];
  return {
    applied,
    host: {
      resolve: () => Promise.resolve({}),
      readLocal: (target) => {
        const key =
          target.kind === 'workspace-repo' ? target.repoId : target.workspaceId;
        if (!(key in local))
          return Promise.reject(
            new ScriptHookSettingsRefusedError('not-found', `${key} not found`),
          );
        return Promise.resolve(local[key]);
      },
      localRevision: () => Promise.resolve(revision),
      inspect: () => Promise.resolve({ resolved: {}, layers: [] }),
      change: ({
        target,
        change,
        idempotencyKey,
        expectedRevision,
        caller,
      }) => {
        applied.push({
          target,
          change,
          idempotencyKey,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          source: caller.interfaceKind,
        });
        return Promise.resolve();
      },
      errorCode: (error) =>
        error instanceof ScriptHookSettingsRefusedError &&
        error.reason === 'not-found'
          ? 'core.script.notFound'
          : undefined,
    },
  };
}

describe('script settings saves', () => {
  it('upserts only the scripts that differ and deletes the dropped ones', async () => {
    const fake = host({
      ws: {
        setup: 'npm ci',
        launch: { command: 'npm run dev', timeoutSeconds: 60 },
        teardown: null,
      },
    });
    await saveProjectScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      {
        projectId: 'ws',
        scripts: {
          setup: '  npm ci ',
          launch: 'npm start',
          dev: 'pnpm dev',
        },
      },
    );
    expect(fake.applied.map(({ change }) => change)).toEqual([
      { kind: 'set', name: 'launch', value: 'npm start' },
      { kind: 'set', name: 'dev', value: 'pnpm dev' },
      { kind: 'remove', name: 'teardown' },
    ]);
    expect(
      new Set(fake.applied.map((entry) => entry.idempotencyKey)).size,
    ).toBe(3);
    expect(fake.applied[0]).toMatchObject({
      target: { kind: 'workspace-root', workspaceId: 'ws' },
      source: 'desktop',
    });
  });

  it('writes nothing when the saved scripts are unchanged', async () => {
    const fake = host({ ws: { setup: 'npm ci' } });
    await saveProjectScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      { projectId: 'ws', scripts: { setup: 'npm ci' } },
    );
    expect(fake.applied).toEqual([]);
  });

  it('merges commands, keeping definition fields and removing empty ones', async () => {
    const fake = host({
      ws: {
        setup: { command: 'npm ci', timeoutSeconds: 60 },
        launch: 'npm run dev',
      },
    });
    await mergeWorkspaceScriptCommands(
      scriptDefinitionsDispatcher(fake.host),
      { ...DESKTOP_SCRIPT_CALLER, interfaceKind: 'portal' },
      { workspaceId: 'ws', commands: { setup: 'pnpm i', launch: '' } },
    );
    expect(fake.applied).toEqual([
      expect.objectContaining({
        change: {
          kind: 'set',
          name: 'setup',
          value: { command: 'pnpm i', timeoutSeconds: 60 },
        },
        source: 'portal',
      }),
      expect.objectContaining({ change: { kind: 'remove', name: 'launch' } }),
    ]);
  });

  it('refuses a malformed command map before reading', async () => {
    const fake = host({});
    // The renderer's payload is untrusted at runtime.
    const commands: Record<string, string> = {};
    Reflect.set(commands, 'setup', 1);
    await expect(
      mergeWorkspaceScriptCommands(
        scriptDefinitionsDispatcher(fake.host),
        DESKTOP_SCRIPT_CALLER,
        { workspaceId: 'ws', commands },
      ),
    ).rejects.toThrow('Invalid script commands.');
  });

  it('skips a repository the workspace does not have and keeps the host error otherwise', async () => {
    const fake = host({ api: { setup: 'old' } });
    await saveWorkspaceRepoScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      {
        workspaceId: 'ws',
        repos: [
          { repoId: 'gone', scripts: { setup: 'x' } },
          { repoId: 'Not An Id', scripts: { setup: 'x' } },
          { repoId: 'api', scripts: { setup: 'new' } },
        ],
      },
    );
    expect(fake.applied).toEqual([
      expect.objectContaining({
        target: { kind: 'workspace-repo', workspaceId: 'ws', repoId: 'api' },
        change: { kind: 'set', name: 'setup', value: 'new' },
      }),
    ]);

    const refused = new ScriptHookSettingsRefusedError(
      'read-only-scope',
      'This project is read-only.',
    );
    await expect(
      saveWorkspaceRepoScripts(
        scriptDefinitionsDispatcher({
          ...fake.host,
          change: () => Promise.reject(refused),
        }),
        DESKTOP_SCRIPT_CALLER,
        { workspaceId: 'ws', repos: [{ repoId: 'api', scripts: {} }] },
      ),
    ).rejects.toBe(refused);
  });

  it('deletes a script named after an Object property', async () => {
    const fake = host({ ws: { constructor: 'echo old', setup: 'npm ci' } });
    await saveProjectScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      { projectId: 'ws', scripts: { setup: 'npm ci' } },
    );
    expect(fake.applied.map(({ change }) => change)).toEqual([
      { kind: 'remove', name: 'constructor' },
    ]);
  });

  it('expects the revision each change leaves behind', async () => {
    const fake = host({ ws: { setup: 'npm ci' } }, 7);
    await saveProjectScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      { projectId: 'ws', scripts: { launch: 'dev' } },
    );
    expect(
      fake.applied.map(({ change, expectedRevision }) => [
        change.kind,
        change.name,
        expectedRevision,
      ]),
    ).toEqual([
      ['set', 'launch', 7],
      ['remove', 'setup', 8],
    ]);
  });

  it('plans again from fresh settings when another write lands first', async () => {
    const conflict = new Error('Workspace changed.');
    const local: Record<string, ScriptSourceMap | undefined> = {
      ws: { setup: { command: 'npm ci', timeoutSeconds: 60 } },
    };
    let revision = 1;
    const fake = host(local);
    let conflicts = 0;
    await mergeWorkspaceScriptCommands(
      scriptDefinitionsDispatcher({
        ...fake.host,
        localRevision: () => Promise.resolve(revision),
        change: (input) => {
          if (conflicts === 0) {
            conflicts += 1;
            // Another save changed the timeout after this one read it.
            local.ws = { setup: { command: 'npm ci', timeoutSeconds: 120 } };
            revision = 2;
            return Promise.reject(conflict);
          }
          return fake.host.change(input);
        },
        errorCode: (error) =>
          error === conflict ? 'core.script.revisionConflict' : undefined,
      }),
      DESKTOP_SCRIPT_CALLER,
      { workspaceId: 'ws', commands: { setup: 'pnpm i' } },
    );
    expect(fake.applied).toEqual([
      expect.objectContaining({
        change: {
          kind: 'set',
          name: 'setup',
          value: { command: 'pnpm i', timeoutSeconds: 120 },
        },
        expectedRevision: 2,
      }),
    ]);
  });

  it('gives up after repeated conflicts with the host error', async () => {
    const conflict = new Error('Workspace changed.');
    const fake = host({ ws: {} }, 1);
    const change = jest.fn(() => Promise.reject(conflict));
    await expect(
      saveProjectScripts(
        scriptDefinitionsDispatcher({
          ...fake.host,
          change,
          errorCode: () => 'core.script.revisionConflict',
        }),
        DESKTOP_SCRIPT_CALLER,
        { projectId: 'ws', scripts: { setup: 'npm ci' } },
      ),
    ).rejects.toBe(conflict);
    expect(change).toHaveBeenCalledTimes(3);
  });

  it('removes a stored command longer than a new one may be', async () => {
    const fake = host({ ws: { setup: `echo ${'x'.repeat(70_000)}` } });
    await saveProjectScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      { projectId: 'ws', scripts: { launch: 'dev' } },
    );
    expect(fake.applied.map(({ change }) => change)).toEqual([
      { kind: 'set', name: 'launch', value: 'dev' },
      { kind: 'remove', name: 'setup' },
    ]);
  });

  it('saves a repository whose valid id is longer than 128 characters', async () => {
    const repoId = 'r'.repeat(129);
    const fake = host({ [repoId]: {} });
    await saveWorkspaceRepoScripts(
      scriptDefinitionsDispatcher(fake.host),
      DESKTOP_SCRIPT_CALLER,
      { workspaceId: 'ws', repos: [{ repoId, scripts: { setup: 'npm ci' } }] },
    );
    expect(fake.applied).toEqual([
      expect.objectContaining({
        target: { kind: 'workspace-repo', workspaceId: 'ws', repoId },
      }),
    ]);
  });
});
