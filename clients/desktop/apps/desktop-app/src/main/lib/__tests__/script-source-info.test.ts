// CAN-4153: the script settings reads are projections over
// core.script.definition.*, with their legacy shapes, labels and errors.
jest.mock('../script-definition-host', () => ({}));

import { BRAND } from '@canopy/brand/current';
import {
  CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  CORE_SCRIPT_DEFINITION_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  createCoreScriptDefinitionHandlers,
  type CoreScriptDefinitionsHost,
} from '@canopy/core-runtime/node/script/core-script-definitions';
import { ScriptHookSettingsRefusedError } from '@canopy/core-runtime/node/w5/workspace-metadata/settings';
import { PortalServiceError } from '../../services/portal-service-error';
import {
  readScriptSourceInfo,
  readWorkspaceScriptCommands,
} from '../script-source-info';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

type ScriptDefinitionsDispatcher = CanopyDispatcher<
  typeof CORE_SCRIPT_DEFINITION_QUERIES,
  typeof CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  Record<never, never>
>;

function dispatcher(
  host: Partial<CoreScriptDefinitionsHost>,
): ScriptDefinitionsDispatcher {
  const handlers = createCoreScriptDefinitionHandlers({
    resolve: () => Promise.resolve({}),
    readLocal: () => Promise.resolve(undefined),
    localRevision: () => Promise.resolve(undefined),
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

describe('readWorkspaceScriptCommands', () => {
  it('keeps answering an absent or unreadable manifest with no scripts', async () => {
    const readLocal = jest.fn(() =>
      Promise.reject(
        new ScriptHookSettingsRefusedError(
          'configuration-unavailable',
          'Settings could not be read.',
        ),
      ),
    );
    await expect(
      readWorkspaceScriptCommands(dispatcher({ readLocal }), CALLER, 'ws-1'),
    ).resolves.toEqual({});
  });

  it('flattens string and definition settings to commands and drops disables', async () => {
    const readLocal = jest.fn(() =>
      Promise.resolve({
        setup: 'npm ci',
        launch: { command: 'npm run dev', timeoutSeconds: 60 },
        teardown: null,
      }),
    );
    await expect(
      readWorkspaceScriptCommands(dispatcher({ readLocal }), CALLER, 'ws-1'),
    ).resolves.toEqual({ setup: 'npm ci', launch: 'npm run dev' });
    expect(readLocal).toHaveBeenCalledWith({
      kind: 'workspace-root',
      workspaceId: 'ws-1',
    });
  });

  it('keeps the legacy identifier error', async () => {
    await expect(
      readWorkspaceScriptCommands(dispatcher({}), CALLER, 'Bad Id'),
    ).rejects.toThrow('Invalid workspaceId');
  });
});

describe('readScriptSourceInfo', () => {
  it('returns the legacy response with desktop labels', async () => {
    const inspect = jest.fn(() =>
      Promise.resolve({
        resolved: {},
        layers: [
          {
            sourceKey: 'local-override',
            source: 'local-override' as const,
            command: null,
            status: 'disabled' as const,
          },
          {
            sourceKey: 'repo-canopy:canopy.json',
            source: 'repo-canopy' as const,
            file: 'canopy.json',
            note: 'used-config' as const,
            command: null,
            status: 'absent' as const,
          },
          {
            sourceKey: 'workspace-manifest:fallback.json',
            source: 'workspace-manifest' as const,
            file: 'fallback.json',
            note: 'overridden-fallback' as const,
            command: 'make',
            status: 'overridden' as const,
          },
        ],
      }),
    );
    await expect(
      readScriptSourceInfo(dispatcher({ inspect }), CALLER, {
        target: 'workspace-repo',
        scriptName: ' build-docs ',
        workspaceId: 'ws',
        repoId: 'api',
        worktreeId: 'tree',
      }),
    ).resolves.toEqual({
      scriptName: 'build-docs',
      scriptDisplayName: 'Build Docs',
      effectiveCommand: null,
      layers: [
        {
          sourceKey: 'local-override',
          sourceLabel: `${BRAND.displayName} Local Override`,
          command: null,
          status: 'disabled',
        },
        {
          sourceKey: 'repo-canopy:canopy.json',
          sourceLabel: 'canopy.json (used config)',
          command: null,
          status: 'absent',
        },
        {
          sourceKey: 'workspace-manifest:fallback.json',
          sourceLabel: 'fallback.json (project manifest) (overridden fallback)',
          command: 'make',
          status: 'overridden',
        },
      ],
    });
    expect(inspect).toHaveBeenCalledWith(
      {
        kind: 'workspace-repo',
        workspaceId: 'ws',
        repoId: 'api',
        worktreeId: 'tree',
      },
      'build-docs',
    );
  });

  it('refuses a blank script name before dispatch', async () => {
    const inspect = jest.fn();
    const failure = await readScriptSourceInfo(
      dispatcher({ inspect }),
      CALLER,
      { target: 'project', scriptName: '  ', projectId: 'p' },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PortalServiceError);
    expect(failure).toMatchObject({ message: 'scriptName is required.' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rethrows the host error itself', async () => {
    const hostError = new PortalServiceError('not_found', 'Project not found.');
    await expect(
      readScriptSourceInfo(
        dispatcher({
          inspect: () => Promise.reject(hostError),
          errorCode: () => 'core.script.notFound',
        }),
        CALLER,
        { target: 'project', scriptName: 'setup', projectId: 'p' },
      ),
    ).rejects.toBe(hostError);
  });
});
