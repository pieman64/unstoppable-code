// CAN-5061 golden: pipeline definition list, get and validate results and
// error shapes for every source kind (bundled, user, project, shared and
// curated), through desktop IPC, Portal commands and agent actions. Captured
// on unchanged code before CAN-4139 moves definitions to core ownership.
// Real data root, stores, Git checkout and cloud client; only IPC
// registration and `fetch` are replaced (see ./world.ts). Re-record
// deliberately with
// `pnpm test apps/desktop-app/src/main/__tests__/pipeline-golden -u`
// and review the snapshot diff as a behavior change.
import {
  GOLDEN_AGENT_INVALID_PIPELINE_YAML,
  GOLDEN_BUNDLED_PIPELINE_ID,
  GOLDEN_INVALID_PIPELINE_YAML,
  GOLDEN_NO_JOBS_YAML,
  GOLDEN_UNPARSEABLE_YAML,
  GOLDEN_USER_PIPELINE_YAML,
} from '@canopy/desktop-shared/node/pipelines/__tests__/golden-fixtures';
import {
  deleteStoredPipeline,
  getStoredPipeline,
  getStoredPipelinePath,
  listStoredPipelines,
  saveStoredPipeline,
} from '@canopy/desktop-shared/pipelines/store';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { app } from 'electron';
import * as storeModule from '@canopy/desktop-shared/pipelines/store';
import * as pipelineInstallContext from '../../pipelines/pipeline-install-context';
import * as resourceLanes from '../../pipelines/resource-lanes';
import { PIPELINE_GRANTS } from '@canopy/protocol/canopy-core';
import { readPreferencesFile } from '../../lib/preferences-store';
import type {
  IPCResult,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import { readPipelineLocalMetadata } from '../../pipelines/pipeline-local-metadata-store';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  dispatchAgentAction,
  goldenWorktreeActionRuntime,
  invokeIpc,
  registerGoldenIpcHandler,
  runPortalCommand,
  type GoldenIpcHandler,
} from './harness';
import {
  createPipelineGoldenWorld,
  GOLDEN_CURATED_KEY,
  GOLDEN_CURATED_YAML,
  GOLDEN_PROJECT_PIPELINE_FILE,
  GOLDEN_PROJECT_PIPELINE_ID,
  GOLDEN_SHARED_DISPATCH_REMOTE_ID,
  GOLDEN_SHARED_DISPATCH_YAML,
  GOLDEN_SHARED_REMOTE_ID,
  GOLDEN_SHARED_YAML,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';

const mockRegisterIpcHandler = (
  channel: string,
  handler: GoldenIpcHandler,
): void => registerGoldenIpcHandler(channel, handler);
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: GoldenIpcHandler): void =>
    mockRegisterIpcHandler(channel, handler),
}));

jest.setTimeout(120_000);

let world: GoldenWorld;

let runtime: DesktopCanopyDispatcher;
let userData: jest.SpiedFunction<typeof app.getPath>;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  // Write effects persist Portal state under userData, which the Electron
  // mock otherwise resolves to the checkout.
  userData = jest.spyOn(app, 'getPath').mockReturnValue(world.root);
  // Definition writes reach core through the desktop dispatcher.
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  const { registerPipelineHandlers } =
    await import('../../pipelines/pipeline-handlers');
  registerPipelineHandlers();
});

afterAll(async () => {
  setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  userData.mockRestore();
  await world.dispose();
});

/** Run one call and pin its normalized result with the cloud requests it made. */
async function capture(call: () => Promise<unknown>): Promise<unknown> {
  world.cloudRequests.length = 0;
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    result = {
      thrown: error instanceof Error ? error.message : String(error),
    };
  }
  return world.normalize({
    result,
    cloudRequests: [...world.cloudRequests],
  });
}

async function captureAll(
  calls: Record<string, () => Promise<unknown>>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  // Sequential: the cloud request log is shared.
  for (const [name, call] of Object.entries(calls))
    results[name] = await capture(call);
  return results;
}

const projectFile = (): string =>
  `${world.worktreePath}/.canopy/pipelines/${GOLDEN_PROJECT_PIPELINE_FILE}`;

describe('desktop IPC', () => {
  it('lists bundled, user and curated definitions and discovers project ones', async () => {
    expect(
      await captureAll({
        list: () => invokeIpc(PIPELINE_CHANNELS.LIST),
        discoverProject: () =>
          invokeIpc(PIPELINE_CHANNELS.DISCOVER_PROJECT, world.worktreePath),
        discoverRelativeCwd: () =>
          invokeIpc(PIPELINE_CHANNELS.DISCOVER_PROJECT, 'relative/path'),
        discoverMissingCwd: () =>
          invokeIpc(
            PIPELINE_CHANNELS.DISCOVER_PROJECT,
            `${world.root}/missing`,
          ),
        curatedList: () => invokeIpc(PIPELINE_CHANNELS.CURATED_LIST, {}),
        sharedList: () => invokeIpc(PIPELINE_CHANNELS.SHARED_LIST, {}),
        sharedListPlanReady: () =>
          invokeIpc(PIPELINE_CHANNELS.SHARED_LIST, {
            triggerType: 'plan_ready',
          }),
      }),
    ).toMatchSnapshot();
  });

  it('gets each source kind and refuses unknown ones', async () => {
    expect(
      await captureAll({
        userById: () => invokeIpc(PIPELINE_CHANNELS.GET, world.userPipelineId),
        userStored: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'user',
            id: world.userPipelineId,
          }),
        bundledById: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, GOLDEN_BUNDLED_PIPELINE_ID),
        bundledStored: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'bundled',
            id: GOLDEN_BUNDLED_PIPELINE_ID,
          }),
        bundledAsUser: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'user',
            id: GOLDEN_BUNDLED_PIPELINE_ID,
          }),
        project: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: projectFile(),
          }),
        projectOutsideCheckout: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: `${world.root}/resources/pipelines/golden-review.yaml`,
          }),
        shared: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'shared',
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
        sharedMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'shared',
            remoteId: 'shared-missing',
          }),
        sharedGet: () =>
          invokeIpc(PIPELINE_CHANNELS.SHARED_GET, {
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
        curated: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, `curated:${GOLDEN_CURATED_KEY}`),
        curatedMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, 'curated:missing-curated'),
        curatedGet: () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_GET, GOLDEN_CURATED_KEY),
        curatedGetMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_GET, 'missing-curated'),
        missing: () => invokeIpc(PIPELINE_CHANNELS.GET, 'missing-pipeline'),
        invalidLookup: () => invokeIpc(PIPELINE_CHANNELS.GET, { nope: true }),
      }),
    ).toMatchSnapshot();
  });

  it('refuses invalid definitions on save without persisting them', async () => {
    const save = (content: unknown): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: 'Golden refused',
        description: '',
        icon: '',
        content,
      });
    expect(
      await captureAll({
        unknownDependency: () =>
          save(parsePipelineText(GOLDEN_INVALID_PIPELINE_YAML)),
        noJobs: () => save(parsePipelineText(GOLDEN_NO_JOBS_YAML)),
        notAPipeline: () => save({ name: 'x' }),
        listAfter: () => invokeIpc(PIPELINE_CHANNELS.LIST),
      }),
    ).toMatchSnapshot();
  });
});

describe('Portal', () => {
  it('lists and gets each source kind for a routed worktree', async () => {
    const get = (
      pipelineId: string,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> =>
      runPortalCommand('portal.pipeline.get', {
        pipelineId,
        projectId: GOLDEN_WORKSPACE_ID,
        worktreeId: GOLDEN_WORKTREE_ID,
        ...extra,
      });
    expect(
      await captureAll({
        list: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: GOLDEN_WORKTREE_ID,
          }),
        listDefaultWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
          }),
        listWithoutProject: () => runPortalCommand('portal.pipeline.list', {}),
        listUnknownWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: 'missing-wt',
          }),
        listInvalidWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: '../escape',
          }),
        getUser: () => get(world.userPipelineId),
        getBundled: () => get(GOLDEN_BUNDLED_PIPELINE_ID),
        getProject: () => get(GOLDEN_PROJECT_PIPELINE_ID),
        getShared: () => get(`shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`),
        getSharedDispatchOnly: () =>
          get(`shared:canopy-cloud:${GOLDEN_SHARED_DISPATCH_REMOTE_ID}`),
        getCurated: () => get(`curated:${GOLDEN_CURATED_KEY}`),
        getMissing: () => get('missing-pipeline'),
        getWithoutWorktree: () =>
          runPortalCommand('portal.pipeline.get', {
            pipelineId: world.userPipelineId,
            projectId: GOLDEN_WORKSPACE_ID,
          }),
        getInvalidPayload: () =>
          runPortalCommand('portal.pipeline.get', { pipelineId: 7 }),
      }),
    ).toMatchSnapshot();
  });
});

describe('agent actions', () => {
  it('lists and gets each source kind and refuses invalid definitions', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const directory = goldenWorktreeActionRuntime(world.worktreePath, {
      executionScope: 'directory',
    });
    const get = (pipelineId: string): Promise<unknown> =>
      dispatchAgentAction(
        { type: 'pipeline.get', pipelineId, includeYaml: true },
        runtime,
      );
    expect(
      await captureAll({
        list: () => dispatchAgentAction({ type: 'pipeline.list' }, runtime),
        listDirectory: () =>
          dispatchAgentAction({ type: 'pipeline.list' }, directory),
        listQuery: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', query: 'golden user', limit: 1 },
            runtime,
          ),
        listPlanReady: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', runModes: ['plan_ready'] },
            runtime,
          ),
        getUser: () => get(world.userPipelineId),
        getBundled: () => get(GOLDEN_BUNDLED_PIPELINE_ID),
        getProject: () => get(GOLDEN_PROJECT_PIPELINE_ID),
        getShared: () => get(`shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`),
        getCurated: () => get(`curated:${GOLDEN_CURATED_KEY}`),
        getMissing: () => get('missing-pipeline'),
        createUnparseable: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_UNPARSEABLE_YAML,
            },
            runtime,
          ),
        createShellSteps: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_INVALID_PIPELINE_YAML,
            },
            runtime,
          ),
        createInvalid: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_AGENT_INVALID_PIPELINE_YAML,
            },
            runtime,
          ),
        createNoJobs: () =>
          dispatchAgentAction(
            { type: 'pipeline.create', rawYaml: GOLDEN_NO_JOBS_YAML },
            runtime,
          ),
        listAfter: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', includeDisabled: true },
            runtime,
          ),
      }),
    ).toMatchSnapshot();
  });
});

// CAN-4139: every caller's writes reach core, which owns user revisions.
describe('core definition writes', () => {
  it("refuses an editor save over another writer's edit, then deletes with its effects", async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const content = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
    const save = (input: Record<string, unknown>): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: 'Golden conflict',
        description: '',
        icon: '',
        content,
        ...input,
      });
    // Raw bytes the parsed content doesn't match are refused, as before.
    expect(
      await save({
        rawContent: GOLDEN_USER_PIPELINE_YAML.replace('Golden', 'Other'),
      }),
    ).toEqual({
      success: false,
      error: 'Raw pipeline document does not match parsed pipeline content.',
    });
    const created = (await save({})) as IPCResult<PipelineInfo>;
    const id = created.data?.id ?? '';
    expect(created.data).toMatchObject({ source: 'user', revision: 1 });
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id })
        .owner,
    ).toBe('personal');
    expect(
      await dispatchAgentAction(
        { type: 'pipeline.update', pipelineId: id, name: 'Agent edit' },
        runtime,
      ),
    ).toMatchObject({ isError: false });
    expect(
      await save({ id, expectedRevision: 1, name: 'Editor edit' }),
    ).toEqual({
      success: false,
      error: `Workflow changed since it was loaded: ${id}`,
    });
    expect(getStoredPipeline(id).data?.info).toMatchObject({
      name: 'Agent edit',
      revision: 2,
    });
    expect(
      await save({ id, expectedRevision: 2, name: 'Editor edit' }),
    ).toMatchObject({ success: true, data: { revision: 3 } });
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id }),
    ).toEqual({});
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: false,
      error: `Workflow not found: ${id}`,
    });
  });
});

// CAN-5368: duplicates, enablement and replay go through core too.
describe('core definition copies, enablement and replay', () => {
  it('copies a bundled definition under an id core assigns, as a user definition', async () => {
    const before = new Set(
      (listStoredPipelines().data ?? []).map((info) => info.id),
    );
    const copied = (await invokeIpc(
      PIPELINE_CHANNELS.DUPLICATE,
      GOLDEN_BUNDLED_PIPELINE_ID,
    )) as IPCResult<PipelineInfo>;
    expect(copied).toMatchObject({
      success: true,
      data: { source: 'user', readonly: false, revision: 1 },
    });
    const id = copied.data?.id ?? '';
    expect(before.has(id)).toBe(false);
    const stored = getStoredPipeline(id).data;
    expect(stored?.info.name).toBe(`${stored?.content.name ?? ''}`);
    expect(stored?.info.name).toMatch(/ \(Copy\)$/);
    expect(stored?.content.readonly).toBeUndefined();
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id })
        .owner,
    ).toBe('personal');
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
  });

  it("never copies an organization's project workflow out as Personal", async () => {
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    const owner = jest
      .spyOn(pipelineInstallContext, 'readProjectPipelineOwner')
      .mockResolvedValue({
        type: 'organization',
        id: 'org-golden',
        name: null,
      });
    const before = listStoredPipelines().data?.length;
    try {
      await expect(
        runtime.instruction(
          'core.pipeline.definition.duplicate',
          {
            sourceDefinitionId: GOLDEN_PROJECT_PIPELINE_ID,
            scope: {
              workspaceId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
            },
            _meta: { idempotencyKey: 'golden-org-copy' },
          },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'golden-org-copy',
              authorityId: 'local-desktop',
              interfaceKind: 'test',
              grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
            },
            metadata: { idempotencyKey: 'golden-org-copy' },
          },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'core.pipeline.contextMismatch' },
      });
      expect(listStoredPipelines().data?.length).toBe(before);
    } finally {
      owner.mockRestore();
      contexts.mockRestore();
    }
  });

  it('enables and disables read-only definitions through core', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    for (const pipelineId of [
      GOLDEN_BUNDLED_PIPELINE_ID,
      `curated:${GOLDEN_CURATED_KEY}`,
    ]) {
      expect(
        await dispatchAgentAction(
          { type: 'pipeline.set_enabled', pipelineId, enabled: false },
          runtime,
        ),
      ).toMatchObject({ isError: false });
      expect((await readPreferencesFile()).disabledPipelineIds).toContain(
        pipelineId,
      );
      await dispatchAgentAction(
        { type: 'pipeline.set_enabled', pipelineId, enabled: true },
        runtime,
      );
      expect((await readPreferencesFile()).disabledPipelineIds).not.toContain(
        pipelineId,
      );
    }
  });

  it('reads a bundled definition a user one shadows by its explicit source', async () => {
    const bundled = getStoredPipeline(GOLDEN_BUNDLED_PIPELINE_ID).data;
    expect(bundled?.info.source).toBe('bundled');
    const shadow = saveStoredPipeline(
      {
        name: 'Golden shadow',
        description: '',
        icon: '',
        content: parsePipelineText(GOLDEN_USER_PIPELINE_YAML),
      },
      { id: GOLDEN_BUNDLED_PIPELINE_ID },
    );
    expect(shadow).toMatchObject({
      success: true,
      data: { id: GOLDEN_BUNDLED_PIPELINE_ID },
    });
    try {
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, {
          source: 'bundled',
          id: GOLDEN_BUNDLED_PIPELINE_ID,
        }),
      ).toMatchObject({
        success: true,
        data: { info: { source: 'bundled', name: bundled?.info.name } },
      });
      // An unreadable shadow never blocks the bundled read.
      const shadowFile = getStoredPipelinePath(GOLDEN_BUNDLED_PIPELINE_ID).data;
      if (shadowFile) rmSync(shadowFile);
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, {
          source: 'bundled',
          id: GOLDEN_BUNDLED_PIPELINE_ID,
        }),
      ).toMatchObject({ success: true, data: { info: { source: 'bundled' } } });
    } finally {
      deleteStoredPipeline(GOLDEN_BUNDLED_PIPELINE_ID);
    }
  });

  it('answers a get with the revision of the document it read', async () => {
    const read = getStoredPipeline(world.userPipelineId).data;
    // A save landing between core's read and the row's index lookup.
    const index = jest
      .spyOn(storeModule, 'getStoredPipelineIndexEntry')
      .mockImplementation((id, source) => {
        index.mockRestore();
        const entry = storeModule.getStoredPipelineIndexEntry(id, source);
        return entry ? { ...entry, revision: (entry.revision ?? 0) + 1 } : null;
      });
    try {
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, world.userPipelineId),
      ).toMatchObject({
        success: true,
        data: { info: { revision: read?.info.revision } },
      });
    } finally {
      index.mockRestore();
    }
  });

  it('replays a committed write for its key after a restart', async () => {
    const caller = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'golden-replay',
      authorityId: 'local-desktop',
      interfaceKind: 'test' as const,
      grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
    };
    const params = {
      definitionId: null,
      expectedRevision: null,
      scope: {},
      source: 'user' as const,
      name: 'Golden replay',
      format: 'yaml' as const,
      document: GOLDEN_USER_PIPELINE_YAML,
      _meta: { idempotencyKey: 'golden-replay-key' },
    };
    const upsert = (
      dispatcher: DesktopCanopyDispatcher,
    ): ReturnType<DesktopCanopyDispatcher['instruction']> =>
      dispatcher.instruction('core.pipeline.definition.upsert', params, {
        caller,
        metadata: { idempotencyKey: 'golden-replay-key' },
      });
    const first = await upsert(runtime);
    const count = listStoredPipelines().data?.length;
    const restarted = createDesktopRuntime();
    try {
      expect(await upsert(restarted)).toEqual(first);
      expect(listStoredPipelines().data?.length).toBe(count);
    } finally {
      await restarted.shutdown();
    }
  });
});

// CAN-5076: curated imports and share installs, captured on unchanged code
// before they move behind core definition ownership.
describe('installs from the curated catalog and shares', () => {
  const curatedHash = createHash('sha256')
    .update(GOLDEN_CURATED_YAML)
    .digest('hex');

  /** What an install left behind for one local id. */
  async function installedState(id: string): Promise<unknown> {
    const { flushSharedItemSubscriptions, readSharedItemSubscriptionLedger } =
      await import('../../canopy-cloud/shared-item-subscriptions');
    const { listPackageInstalls } =
      await import('../../pipelines/pipeline-package-service');
    await flushSharedItemSubscriptions();
    const stored = getStoredPipeline(id).data;
    return {
      info: stored?.info,
      text: readFileSync(getStoredPipelinePath(id).data ?? '', 'utf8'),
      owner: readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: id,
      }).owner,
      context: await pipelineInstallContext
        .readStoredPipelineContext(id)
        .catch((error: unknown) => ({ thrown: String(error) })),
      subscriptions: (await readSharedItemSubscriptionLedger()).installs.filter(
        (install) => install.localIds.includes(id),
      ),
      packageInstalls: (await listPackageInstalls()).filter(
        (install) => install.localPipelineId === id,
      ),
    };
  }

  async function capturedInstall(
    install: () => Promise<unknown>,
    idOf: (result: unknown) => string | undefined,
  ): Promise<unknown> {
    const before = new Set(
      (listStoredPipelines().data ?? []).map((info) => info.id),
    );
    let installedId: string | undefined;
    const result = await capture(async () => {
      const value = await install();
      installedId = idOf(value);
      return value;
    });
    const added = (listStoredPipelines().data ?? [])
      .map((info) => info.id)
      .filter((id) => !before.has(id));
    const state =
      installedId === undefined
        ? undefined
        : world.normalize(await installedState(installedId));
    for (const id of added) deleteStoredPipeline(id);
    return { result, added: added.length, state };
  }

  const ipcId = (value: unknown): string | undefined => {
    const result = value as IPCResult<PipelineInfo>;
    return result.success ? result.data?.id : undefined;
  };

  it('imports a curated revision as a user definition and refuses a stale one', async () => {
    expect({
      ipc: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: curatedHash,
          }),
        ipcId,
      ),
      ipcStale: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: '0'.repeat(64),
          }),
        ipcId,
      ),
      ipcMissing: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: 'missing-curated',
            expectedContentHash: curatedHash,
          }),
        ipcId,
      ),
      ipcInvalid: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
          }),
        ipcId,
      ),
      portal: await capturedInstall(
        () =>
          runPortalCommand('portal.pipeline.install_curated', {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: curatedHash,
          }),
        (value) => {
          const payload = (value as { payload?: { result?: unknown } }).payload;
          const result = payload?.result as { pipelineId?: string } | undefined;
          return result?.pipelineId;
        },
      ),
      portalStale: await capturedInstall(
        () =>
          runPortalCommand('portal.pipeline.install_curated', {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: '0'.repeat(64),
          }),
        () => undefined,
      ),
    }).toMatchSnapshot();
  });

  it('installs a share through pipelines:save with its provenance and refuses a missing one', async () => {
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    // The fields the share landing page sends: the reviewed snapshot's own.
    const save = (
      sourceRemoteId: string,
      yaml: string,
      id?: string,
    ): Promise<unknown> => {
      const content = parsePipelineText(yaml);
      return invokeIpc(PIPELINE_CHANNELS.SAVE, {
        ...(id === undefined ? {} : { id }),
        sourceRemoteId,
        name: content.name,
        description: content.description ?? '',
        icon: content.icon ?? '',
        content,
      });
    };
    try {
      const reinstallTarget = await world.saveUserPipeline(
        GOLDEN_USER_PIPELINE_YAML,
        'reinstall-target',
      );
      expect({
        install: await capturedInstall(
          () => save(GOLDEN_SHARED_REMOTE_ID, GOLDEN_SHARED_YAML),
          ipcId,
        ),
        missing: await capturedInstall(
          () => save('shared-missing', GOLDEN_SHARED_YAML),
          ipcId,
        ),
        reinstall: await capturedInstall(
          () =>
            save(
              GOLDEN_SHARED_DISPATCH_REMOTE_ID,
              GOLDEN_SHARED_DISPATCH_YAML,
              reinstallTarget,
            ),
          ipcId,
        ),
        reinstallUnknown: await capturedInstall(
          () =>
            save(
              GOLDEN_SHARED_REMOTE_ID,
              GOLDEN_SHARED_YAML,
              'missing-pipeline',
            ),
          ipcId,
        ),
      }).toMatchSnapshot();
      deleteStoredPipeline(reinstallTarget);
    } finally {
      contexts.mockRestore();
    }
  });
});
