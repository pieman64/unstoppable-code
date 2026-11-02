import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import {
  collectHookSourceLayers,
  createCoreInitiatedWorkSourceHandlers,
  effectiveHookSourceActions,
  resolveLayeredHookSources,
  type CoreHookSourceHost,
  type HookOwnerBinding,
  type HookSourceLayerInputs,
  type PortableHookAction,
} from '../hook-sources';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.initiatedWork.read'],
};
const context: CanopyHandlerContext = {
  requestId: 'request-1',
  caller,
  metadata: {},
  signal: new AbortController().signal,
};

type Action = PortableHookAction & Record<string, unknown>;

const command = (value: string): Action => ({
  type: 'command',
  command: value,
});
const chat = (prompt: string, extra: Partial<Action> = {}): Action => ({
  type: 'chat',
  prompt,
  ...extra,
});

function unbound(
  inputs: HookSourceLayerInputs<Action>,
): () => Promise<HookOwnerBinding<Action>> {
  return () => Promise.resolve({ hooks: inputs.localHooks, owner: undefined });
}

describe('resolveLayeredHookSources', () => {
  it('layers the repo manifest entry and local hooks over the checkout canopy.json', async () => {
    const inputs: HookSourceLayerInputs<Action> = {
      scope: 'workspace-repo',
      sourceHooks: {
        'pr:opened': [command('repo-open')],
        'pr:merged': [command('repo-merged')],
        'pr:closed': [command('repo-closed')],
      },
      manifestHooks: {
        'pr:merged': [command('manifest-merged')],
        'pr:closed': null,
      },
      localHooks: { 'pr:opened': [command('local-open')], 'pr:ready': null },
    };
    await expect(
      resolveLayeredHookSources(inputs, unbound(inputs)),
    ).resolves.toEqual({
      'pr:opened': {
        actions: [command('local-open')],
        source: 'local-override',
      },
      'pr:merged': {
        actions: [command('manifest-merged')],
        source: 'workspace-manifest',
      },
      'pr:closed': { source: 'workspace-manifest-disabled' },
      'pr:ready': { source: 'local-disabled' },
    });
  });

  it('ignores a manifest layer outside workspace repos and labels the root base layer', async () => {
    const inputs: HookSourceLayerInputs<Action> = {
      scope: 'workspace-root',
      sourceHooks: { 'pr:opened': [command('root')] },
      manifestHooks: { 'pr:opened': null },
      localHooks: undefined,
    };
    await expect(
      resolveLayeredHookSources(inputs, unbound(inputs)),
    ).resolves.toEqual({
      'pr:opened': { actions: [command('root')], source: 'workspace-hook' },
    });
  });

  it('passes the manifest-resolved map to the ownership binding and overlays its result', async () => {
    const inputs: HookSourceLayerInputs<Action> = {
      scope: 'workspace-repo',
      sourceHooks: { 'pr:opened': [chat('Review')] },
      manifestHooks: { 'pr:merged': [command('m')] },
      localHooks: { 'pr:opened': [command('stale')] },
    };
    const seen: unknown[] = [];
    const bind = jest.fn((resolvedSoFar: unknown) => {
      // The map is overlaid in place afterwards; keep what the binding saw.
      seen.push(structuredClone(resolvedSoFar));
      return Promise.resolve<HookOwnerBinding<Action>>({
        hooks: {
          'pr:opened': [
            chat('Review', {
              localExecutionContextOverlay: true,
              executionContext: 'org:acme',
            }),
          ],
        },
        owner: { organizationId: 'acme' },
      });
    });
    const resolved = await resolveLayeredHookSources(inputs, bind);
    expect(seen).toEqual([
      {
        'pr:opened': { actions: [chat('Review')], source: 'repo-canopy' },
        'pr:merged': { actions: [command('m')], source: 'workspace-manifest' },
      },
    ]);
    expect(resolved['pr:opened']).toEqual({
      actions: [chat('Review', { executionContext: 'org:acme' })],
      source: 'repo-canopy',
    });
  });

  it('drops an organization overlay whose owner no longer matches', async () => {
    const inputs: HookSourceLayerInputs<Action> = {
      scope: 'project',
      sourceHooks: { 'pr:opened': [chat('Review')] },
      localHooks: {
        'pr:opened': [
          chat('Review', {
            localExecutionContextOverlay: true,
            executionContext: 'org:acme',
          }),
        ],
      },
    };
    const resolved = await resolveLayeredHookSources(inputs, () =>
      Promise.resolve({
        hooks: inputs.localHooks,
        owner: { organizationId: 'other' },
      }),
    );
    expect(resolved['pr:opened']?.actions).toEqual([chat('Review')]);
  });

  it('merges a unique plugin selection overlay without shadowing the source action', async () => {
    const installed = {
      kind: 'plugin' as const,
      textStart: 4,
      displayText: '@tool',
      plugin: {
        kind: 'installed' as const,
        marketplaceId: 'm',
        pluginName: 'tool',
      },
    };
    const inputs: HookSourceLayerInputs<Action> = {
      scope: 'project',
      sourceHooks: { 'pr:opened': [chat('Run @tool')] },
      localHooks: {
        'pr:opened': [
          chat('old copy', {
            localPluginSelectionOverlay: true,
            localPluginSelectionOverlayKey: 'chat:Run @tool',
            pluginSelections: { skills: ['a'] },
            promptReferences: [installed],
          }),
        ],
      },
    };
    const resolved = await resolveLayeredHookSources(inputs, unbound(inputs));
    expect(resolved['pr:opened']).toEqual({
      actions: [
        chat('Run @tool', {
          pluginSelections: { skills: ['a'] },
          promptReferences: [installed],
        }),
      ],
      source: 'repo-canopy',
    });
  });
});

describe('collectHookSourceLayers', () => {
  it('orders layers most specific first and marks the winner', () => {
    const layers = collectHookSourceLayers<Action>(
      {
        scope: 'workspace-repo',
        sourceHooks: { 'pr:opened': [command('repo')] },
        manifestHooks: { 'pr:opened': null },
        localHooks: { other: [command('x')] },
      },
      'pr:opened',
    );
    expect(layers).toEqual([
      { sourceKey: 'workspace-manifest', actions: null, status: 'disabled' },
      {
        sourceKey: 'repo-canopy',
        actions: [command('repo')],
        status: 'overridden',
      },
    ]);
    expect(effectiveHookSourceActions(layers)).toBeNull();
  });

  it('reports no layers for an unconfigured trigger', () => {
    expect(
      collectHookSourceLayers<Action>(
        { scope: 'project', sourceHooks: undefined, localHooks: undefined },
        'pr:opened',
      ),
    ).toEqual([]);
  });
});

describe('core.initiatedWork.source handlers', () => {
  function host(
    inputs: HookSourceLayerInputs<Action>,
    overrides: Partial<CoreHookSourceHost<Action>> = {},
  ): CoreHookSourceHost<Action> {
    return {
      readLayers: () =>
        Promise.resolve({ layers: inputs, bindLocalHooks: unbound(inputs) }),
      isInvalidTarget: () => false,
      ...overrides,
    };
  }

  const target = { kind: 'project' as const, workspaceId: 'ws-1' };

  it('lists sources in resolution order with JSON-safe actions', async () => {
    const observed = jest.fn();
    const handlers = createCoreInitiatedWorkSourceHandlers(
      host(
        {
          scope: 'project',
          sourceHooks: {
            'pr:opened': [{ type: 'command', command: 'a', shell: undefined }],
          },
          localHooks: { 'pr:closed': null },
        },
        { observeResolved: observed },
      ),
    );
    const result = await handlers.queries['core.initiatedWork.source.list'](
      { sourceKind: 'hook', target },
      context,
    );
    expect(result).toEqual({
      sources: [
        {
          sourceKind: 'hook',
          triggerName: 'pr:opened',
          origin: 'repo-canopy',
          actions: [{ type: 'command', command: 'a' }],
        },
        {
          sourceKind: 'hook',
          triggerName: 'pr:closed',
          origin: 'local-disabled',
          actions: null,
        },
      ],
    });
    expect(Object.keys(result.sources[0]?.actions?.[0] ?? {})).not.toContain(
      'shell',
    );
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('returns the layers and effective actions for one trigger', async () => {
    const observed = jest.fn();
    const handlers = createCoreInitiatedWorkSourceHandlers(
      host(
        {
          scope: 'project',
          sourceHooks: { 'pr:opened': [command('repo')] },
          localHooks: { 'pr:opened': [command('local')] },
        },
        { observeLayers: observed },
      ),
    );
    await expect(
      handlers.queries['core.initiatedWork.source.get'](
        { sourceKind: 'hook', target, triggerName: 'pr:opened' },
        context,
      ),
    ).resolves.toEqual({
      sourceKind: 'hook',
      triggerName: 'pr:opened',
      effectiveActions: [command('local')],
      layers: [
        {
          sourceKey: 'local-override',
          status: 'active',
          actions: [command('local')],
        },
        {
          sourceKey: 'repo-canopy',
          status: 'overridden',
          actions: [command('repo')],
        },
      ],
    });
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('types an invalid target and keeps every host error as the runtime cause', async () => {
    const invalid = new Error('Invalid workspaceId');
    const io = new Error('EACCES');
    const read = jest
      .fn()
      .mockRejectedValueOnce(invalid)
      .mockRejectedValueOnce(io);
    const handlers = createCoreInitiatedWorkSourceHandlers<Action>({
      readLayers: read,
      isInvalidTarget: (error) => error === invalid,
    });
    const list = async (): Promise<unknown> =>
      handlers.queries['core.initiatedWork.source.list'](
        { sourceKind: 'hook', target },
        context,
      );
    const first: unknown = await list().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(CanopyOperationError);
    expect(first).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.initiatedWork.source.invalidTarget',
        message: 'Invalid workspaceId',
      },
      runtimeCause: invalid,
    });
    await expect(list()).rejects.toBe(io);
  });
});
