import {
  CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  CORE_SCRIPT_DEFINITION_QUERIES,
  CoreScriptValueSchema,
  type CanopyCallerDescriptor,
  type CoreScriptTarget,
} from '@canopy/protocol/canopy-core';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
} from '@canopy/protocol/scripts';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  createCoreScriptDefinitionHandlers,
  type CoreScriptDefinitionsHost,
} from '../core-script-definitions';
import {
  collectProjectScriptLayers,
  collectWorkspaceRepoScriptLayers,
  collectWorkspaceRootScriptLayers,
  listCoreScriptDefinitions,
  resolveLocalScriptMap,
  resolveProjectScriptMap,
  resolveWorkspaceRepoScriptMap,
  resolveWorkspaceRootScriptMap,
  toCoreScriptDefinition,
  type ScriptConfigFile,
} from '../definitions';

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants,
  };
}

const READ = { caller: caller(['core.script.read']) };
const WRITE = {
  caller: caller(['core.script.write']),
  metadata: { idempotencyKey: 'key-1' },
};
type ScriptDefinitionsDispatcher = CanopyDispatcher<
  typeof CORE_SCRIPT_DEFINITION_QUERIES,
  typeof CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  Record<never, never>
>;

const ROOT: CoreScriptTarget = { kind: 'workspace-root', workspaceId: 'ws' };

describe('script source precedence', () => {
  it('layers repo config, local overrides and conductor fallbacks for a project', async () => {
    const readConductor = jest.fn(() =>
      Promise.resolve({ setup: 'conductor setup', teardown: 'conductor down' }),
    );
    const resolved = await resolveProjectScriptMap({
      repoScripts: { setup: '  pnpm install  ', test: 'pnpm test', lint: '' },
      localScripts: { test: null, launch: { command: 'pnpm dev' } },
      readConductor,
    });
    expect(resolved).toEqual({
      setup: {
        definition: { command: 'pnpm install' },
        value: 'pnpm install',
        source: 'repo-canopy',
      },
      test: { source: 'local-disabled' },
      launch: {
        definition: { command: 'pnpm dev' },
        value: 'pnpm dev',
        source: 'local-override',
      },
      teardown: {
        definition: { command: 'conductor down' },
        value: 'conductor down',
        source: 'repo-conductor',
      },
    });
  });

  it('reads conductor.json only while a lifecycle script is missing', async () => {
    const readConductor = jest.fn(() => Promise.resolve(null));
    await resolveProjectScriptMap({
      repoScripts: { setup: 'a', launch: 'b', teardown: 'c' },
      localScripts: undefined,
      readConductor,
    });
    expect(readConductor).not.toHaveBeenCalled();
  });

  it('puts local settings above the workspace manifest for a repository', async () => {
    const resolved = await resolveWorkspaceRepoScriptMap({
      repoScripts: { setup: 'repo', launch: 'repo launch' },
      workspaceManifestScripts: { setup: null, launch: 'manifest launch' },
      localScripts: { launch: 'local launch' },
      readConductor: () => Promise.resolve(undefined),
    });
    expect(resolved.setup).toEqual({ source: 'workspace-manifest-disabled' });
    expect(resolved.launch?.source).toBe('local-override');
  });

  it('skips the conductor fallback for a root without a checkout', async () => {
    const resolved = await resolveWorkspaceRootScriptMap({
      workspaceManifestScripts: { 'before-setup': 'echo hi' },
      localScripts: undefined,
      readConductor: undefined,
    });
    expect(resolved).toEqual({
      'before-setup': {
        definition: { command: 'echo hi' },
        value: 'echo hi',
        source: 'workspace-hook',
      },
    });
  });
});

describe('script source layers', () => {
  const files = (
    primary: ScriptConfigFile['scripts'] | null,
    fallback: ScriptConfigFile['scripts'] | null,
  ): ScriptConfigFile[] => [
    {
      fileName: 'canopy.json',
      present: primary !== null,
      scripts: primary ?? undefined,
    },
    {
      fileName: 'fallback.json',
      present: fallback !== null,
      scripts: fallback ?? undefined,
    },
  ];

  it('marks a fallback-only script overridden and notes the file in use', async () => {
    const layers = await collectProjectScriptLayers({
      scriptName: 'setup',
      localScripts: undefined,
      repoConfigFiles: files({}, { setup: 'fallback setup' }),
      readConductor: () => Promise.resolve({ setup: 'conductor setup' }),
    });
    expect(layers).toEqual([
      {
        sourceKey: 'repo-canopy:canopy.json',
        source: 'repo-canopy',
        file: 'canopy.json',
        note: 'used-config',
        command: null,
        status: 'absent',
      },
      {
        sourceKey: 'repo-canopy:fallback.json',
        source: 'repo-canopy',
        file: 'fallback.json',
        note: 'overridden-fallback',
        command: 'fallback setup',
        status: 'overridden',
      },
      {
        sourceKey: 'repo-conductor',
        source: 'repo-conductor',
        file: 'conductor.json',
        command: 'conductor setup',
        status: 'active',
      },
    ]);
  });

  it('lists a missing primary file once a fallback defines the script', async () => {
    const layers = await collectWorkspaceRootScriptLayers({
      scriptName: 'after-setup',
      localScripts: { 'after-setup': null },
      workspaceConfigFiles: files(null, { 'after-setup': 'fallback' }),
      workspaceManifestScripts: undefined,
      readConductor: () => Promise.resolve(null),
    });
    expect(layers.map((layer) => [layer.sourceKey, layer.status])).toEqual([
      ['local-override', 'disabled'],
      ['workspace-hook:canopy.json', 'absent'],
      ['workspace-hook:fallback.json', 'overridden'],
    ]);
  });

  it('reads the manifest entry when the workspace has no root checkout', async () => {
    const layers = await collectWorkspaceRepoScriptLayers({
      scriptName: 'launch',
      localScripts: undefined,
      workspaceConfigFiles: undefined,
      workspaceManifestScripts: { launch: 'manifest' },
      repoConfigFiles: files({ launch: 'repo' }, null),
      readConductor: () => Promise.resolve(null),
    });
    expect(layers.map((layer) => [layer.sourceKey, layer.status])).toEqual([
      ['workspace-manifest', 'active'],
      ['repo-canopy:canopy.json', 'overridden'],
    ]);
  });
});

describe('portable script definitions', () => {
  it('reports the lifecycle role, timeout rule and shell selection', () => {
    expect(
      toCoreScriptDefinition('setup', {
        definition: {
          command: 'pnpm i',
          timeoutSeconds: 90,
          shell: { linux: 'zsh', windows: 'powershell' },
        },
        source: 'repo-canopy',
      }),
    ).toEqual({
      state: 'enabled',
      name: 'setup',
      lifecycle: 'setup',
      source: 'repo-canopy',
      command: 'pnpm i',
      interactive: false,
      timeout: { kind: 'custom', seconds: 90 },
      shell: { windows: 'powershell', mac: 'default', linux: 'zsh' },
    });
    const timeout = (
      name: string,
      timeoutSeconds?: number | null,
      interactive?: boolean,
    ): unknown => {
      const definition = toCoreScriptDefinition(name, {
        definition: {
          command: 'x',
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
          ...(interactive ? { interactive } : {}),
        },
        source: 'local-override',
      });
      return definition.state === 'enabled' ? definition.timeout : null;
    };
    expect(timeout('launch', 30)).toEqual({ kind: 'none', reason: 'launch' });
    expect(timeout('build', 30, true)).toEqual({
      kind: 'none',
      reason: 'interactive',
    });
    // Teardown cannot run interactively, so its timeout still applies.
    expect(timeout('teardown', undefined, true)).toEqual({ kind: 'default' });
    expect(timeout('build', null)).toEqual({
      kind: 'none',
      reason: 'disabled',
    });
  });

  it('lists in lifecycle order and keeps disables', () => {
    const definitions = listCoreScriptDefinitions(
      resolveLocalScriptMap({
        zeta: 'z',
        ' teardown ': 'down',
        setup: 'up',
        'before-setup': null,
        empty: '',
      }),
    );
    expect(definitions.map((entry) => [entry.name, entry.state])).toEqual([
      ['before-setup', 'disabled'],
      ['setup', 'enabled'],
      ['teardown', 'enabled'],
      ['zeta', 'enabled'],
    ]);
  });
});

describe('core.script.definition.*', () => {
  it('refuses blank names and commands at the schema', () => {
    expect(CoreScriptValueSchema.safeParse('   ').success).toBe(false);
    expect(CoreScriptValueSchema.safeParse({ command: ' \t ' }).success).toBe(
      false,
    );
    expect(CoreScriptValueSchema.safeParse(null).success).toBe(true);
    for (const name of ['   ', ' setup']) {
      expect(
        CORE_SCRIPT_DEFINITION_QUERIES[
          'core.script.definition.get'
        ].params.safeParse({ target: ROOT, name }).success,
      ).toBe(false);
    }
  });

  it('reads any stored name but bounds the names a change sets', () => {
    const long = 'n'.repeat(600);
    expect(
      CORE_SCRIPT_DEFINITION_QUERIES[
        'core.script.definition.get'
      ].params.safeParse({ target: ROOT, name: long }).success,
    ).toBe(true);
    expect(
      CORE_SCRIPT_DEFINITION_INSTRUCTIONS[
        'core.script.definition.delete'
      ].params.safeParse({ target: ROOT, name: long }).success,
    ).toBe(false);
  });

  it('bounds script values with the script model limits', () => {
    const accepts = (value: unknown): boolean =>
      CoreScriptValueSchema.safeParse(value).success;
    expect(
      accepts({ command: 'x', timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS }),
    ).toBe(true);
    expect(
      accepts({ command: 'x', timeoutSeconds: MAX_SCRIPT_TIMEOUT_SECONDS + 1 }),
    ).toBe(false);
    const pattern = 'p'.repeat(MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH);
    const label = 'l'.repeat(MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH);
    expect(
      accepts({ command: 'x', devServerPattern: { pattern, label } }),
    ).toBe(true);
    expect(accepts({ command: 'x', devServerPattern: `${pattern}p` })).toBe(
      false,
    );
    expect(
      accepts({
        command: 'x',
        devServerPattern: { pattern, label: `${label}l` },
      }),
    ).toBe(false);
    const patterns = Array.from(
      { length: MAX_SCRIPT_DEV_SERVER_PATTERNS },
      () => 'p',
    );
    expect(accepts({ command: 'x', devServerPattern: patterns })).toBe(true);
    expect(
      accepts({ command: 'x', devServerPattern: [...patterns, 'p'] }),
    ).toBe(false);
  });

  function runtime(
    host: Partial<CoreScriptDefinitionsHost>,
  ): ScriptDefinitionsDispatcher {
    const handlers = createCoreScriptDefinitionHandlers({
      resolve: () => Promise.resolve({}),
      readLocal: () => Promise.resolve(undefined),
      inspect: () => Promise.resolve({ resolved: {}, layers: [] }),
      change: () => Promise.resolve(),
      errorCode: () => undefined,
      ...host,
    });
    return createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_SCRIPT_DEFINITION_QUERIES,
        instructions: CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
        streams: {},
      },
      handlers: {
        queries: handlers.queries,
        instructions: handlers.instructions,
        streams: {},
      },
    });
  }

  it('lists the effective or local layer', async () => {
    const dispatcher = runtime({
      resolve: () =>
        Promise.resolve({
          launch: {
            definition: { command: 'dev' },
            value: 'dev',
            source: 'repo-canopy',
          },
        }),
      readLocal: () => Promise.resolve({ build: 'make' }),
    });
    const effective = await dispatcher.query(
      'core.script.definition.list',
      { target: ROOT },
      READ,
    );
    expect(effective.definitions).toEqual([
      expect.objectContaining({ name: 'launch', source: 'repo-canopy' }),
    ]);
    const local = await dispatcher.query(
      'core.script.definition.list',
      { target: ROOT, layer: 'local' },
      READ,
    );
    expect(local.definitions).toEqual([
      expect.objectContaining({
        name: 'build',
        source: 'local-override',
        command: 'make',
      }),
    ]);
  });

  it('reports source info without starting a script', async () => {
    const dispatcher = runtime({
      inspect: () =>
        Promise.resolve({
          resolved: {},
          layers: [
            {
              sourceKey: 'local-override',
              source: 'local-override',
              command: null,
              status: 'disabled',
            },
            {
              sourceKey: 'repo-conductor',
              source: 'repo-conductor',
              file: 'conductor.json',
              command: 'up',
              status: 'overridden',
            },
          ],
        }),
    });
    const result = await dispatcher.query(
      'core.script.definition.get',
      { target: ROOT, name: 'setup' },
      READ,
    );
    expect(result).toMatchObject({
      name: 'setup',
      definition: null,
      effectiveCommand: null,
    });
    expect(result.layers.map((layer) => layer.status)).toEqual([
      'disabled',
      'overridden',
    ]);
  });

  it('changes only through the host with the caller key and revision', async () => {
    const change = jest.fn(() => Promise.resolve());
    const dispatcher = runtime({ change });
    await expect(
      dispatcher.instruction(
        'core.script.definition.upsert',
        { target: ROOT, name: 'build', value: null, expectedRevision: 4 },
        WRITE,
      ),
    ).resolves.toEqual({ name: 'build' });
    await dispatcher.instruction(
      'core.script.definition.delete',
      { target: ROOT, name: 'build' },
      WRITE,
    );
    expect(change.mock.calls).toEqual([
      [
        expect.objectContaining({
          target: ROOT,
          change: { kind: 'set', name: 'build', value: null },
          idempotencyKey: 'key-1',
          expectedRevision: 4,
        }),
      ],
      [
        expect.objectContaining({
          change: { kind: 'remove', name: 'build' },
          idempotencyKey: 'key-1',
        }),
      ],
    ]);
  });

  it('requires a key and the write grant', async () => {
    const dispatcher = runtime({});
    await expect(
      dispatcher.instruction(
        'core.script.definition.delete',
        { target: ROOT, name: 'build' },
        { caller: caller(['core.script.write']) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      dispatcher.instruction(
        'core.script.definition.delete',
        { target: ROOT, name: 'build' },
        { ...WRITE, caller: caller(['core.script.read']) },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });

  it('types host refusals and keeps the original error as the cause', async () => {
    const refusal = new Error('This was changed since it was read.');
    const dispatcher = runtime({
      change: () => Promise.reject(refusal),
      errorCode: (error) =>
        error === refusal ? 'core.script.revisionConflict' : undefined,
    });
    const failure = await dispatcher
      .instruction(
        'core.script.definition.delete',
        { target: ROOT, name: 'build' },
        WRITE,
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CanopyOperationError);
    expect(failure).toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.script.revisionConflict',
        retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      },
      runtimeCause: refusal,
    });
  });
});
