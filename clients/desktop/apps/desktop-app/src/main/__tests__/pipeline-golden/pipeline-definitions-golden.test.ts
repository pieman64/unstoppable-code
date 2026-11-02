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
import { getStoredPipeline } from '@canopy/desktop-shared/pipelines/store';
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
  GOLDEN_PROJECT_PIPELINE_FILE,
  GOLDEN_PROJECT_PIPELINE_ID,
  GOLDEN_SHARED_DISPATCH_REMOTE_ID,
  GOLDEN_SHARED_REMOTE_ID,
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

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
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
  world.dispose();
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
