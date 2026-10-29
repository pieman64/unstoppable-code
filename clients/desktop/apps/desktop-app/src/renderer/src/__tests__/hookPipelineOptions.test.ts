import {
  loadHookPipelineOptions,
  resolveHookPipelineOption,
} from '../lib/hookPipelineOptions';
import type {
  IPCResult,
  PipelineData,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';

function createPipelineInfo(
  overrides: Partial<PipelineInfo> = {},
): PipelineInfo {
  return {
    id: 'code-review',
    name: 'Code Review',
    filename: 'code-review-multi-provider.yaml',
    description: '',
    icon: '',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    source: 'bundled',
    readonly: true,
    ...overrides,
  };
}

function createPipelineData(info: PipelineInfo): PipelineData {
  return {
    info,
    content: {
      name: info.name,
      on: 'dispatch',
      jobs: {
        test: {
          steps: [{ run: 'echo ok' }],
        },
      },
    },
  };
}

describe('loadHookPipelineOptions', () => {
  const previousWindow = globalThis.window;

  afterEach((): void => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  });

  it('lists curated dispatch metadata without downloading definitions', async () => {
    const info = createPipelineInfo({
      id: 'curated:review',
      source: 'curated',
      triggerTypes: ['dispatch'],
      scopes: ['worktree'],
    });
    const get = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        pipelines: {
          list: jest.fn().mockResolvedValue({ success: true, data: [info] }),
          get,
        },
        api: {
          loadPreferences: jest
            .fn()
            .mockResolvedValue({ disabledPipelineIds: [] }),
        },
      },
    });
    expect(await loadHookPipelineOptions()).toEqual([
      { actionSource: 'curated', actionId: 'curated:review', data: { info } },
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it('surfaces selected curated content failures and rejects changed trigger metadata', async () => {
    const info = createPipelineInfo({
      id: 'curated:review',
      source: 'curated',
      triggerTypes: ['dispatch'],
    });
    const get = jest.fn().mockResolvedValue({
      success: false,
      error: 'Content failed verification.',
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { pipelines: { get } },
    });
    const option = {
      actionSource: 'curated' as const,
      actionId: info.id,
      data: { info },
    };
    await expect(resolveHookPipelineOption(option)).rejects.toThrow(
      'Content failed verification.',
    );
    get.mockResolvedValue({
      success: true,
      data: { info, content: { name: 'Updated', on: 'task_ready', jobs: {} } },
    });
    await expect(resolveHookPipelineOption(option)).rejects.toThrow('dispatch');
    expect(get).toHaveBeenCalledWith({ source: 'curated', id: info.id });
  });

  it('loads project pipeline data with the discovery cwd', async (): Promise<void> => {
    const cwd = '/tmp/repo';
    const projectInfo = createPipelineInfo({
      id: 'project:review.yaml',
      name: 'Project Review',
      filename: 'review.yaml',
      source: 'project',
      readonly: true,
      filePath: '/tmp/repo/.canopy/pipelines/review.yaml',
    });
    const projectData = createPipelineData(projectInfo);
    const listMock = jest.fn<Promise<IPCResult<PipelineInfo[]>>, []>(() =>
      Promise.resolve({ success: true, data: [] }),
    );
    const discoverProjectMock = jest.fn<
      Promise<IPCResult<PipelineInfo[]>>,
      [string]
    >(() => Promise.resolve({ success: true, data: [projectInfo] }));
    const getMock = jest.fn<
      Promise<IPCResult<PipelineData>>,
      [string | { id: string; cwd: string; filePath: string }]
    >(() => Promise.resolve({ success: true, data: projectData }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        pipelines: {
          list: listMock,
          discoverProject: discoverProjectMock,
          get: getMock,
        },
        api: {
          loadPreferences: jest.fn(() =>
            Promise.resolve({ disabledPipelineIds: [] }),
          ),
        },
      },
    });

    await expect(loadHookPipelineOptions({ cwd })).resolves.toEqual([
      {
        actionSource: 'project',
        actionId: 'review.yaml',
        data: projectData,
      },
    ]);
    expect(discoverProjectMock).toHaveBeenCalledWith(cwd);
    expect(getMock).toHaveBeenCalledWith({
      id: 'project:review.yaml',
      cwd,
      filePath: '/tmp/repo/.canopy/pipelines/review.yaml',
    });
  });

  it('loads bundled and local stored pipelines with source-aware lookup', async (): Promise<void> => {
    const bundledInfo = createPipelineInfo({
      id: 'review',
      name: 'Bundled Review',
      source: 'bundled',
      readonly: true,
    });
    const localInfo = createPipelineInfo({
      id: 'review',
      name: 'Local Review',
      source: 'user',
      readonly: false,
    });
    const bundledData = createPipelineData(bundledInfo);
    const localData = createPipelineData(localInfo);
    const listMock = jest.fn<Promise<IPCResult<PipelineInfo[]>>, []>(() =>
      Promise.resolve({ success: true, data: [bundledInfo, localInfo] }),
    );
    const discoverProjectMock = jest.fn<
      Promise<IPCResult<PipelineInfo[]>>,
      [string]
    >(() => Promise.resolve({ success: true, data: [] }));
    const getMock = jest.fn<
      Promise<IPCResult<PipelineData>>,
      [string | { id: string; source: 'bundled' | 'user' }]
    >((request) => {
      if (typeof request === 'string') {
        return Promise.resolve({ success: false, error: 'unexpected string' });
      }
      return Promise.resolve({
        success: true,
        data: request.source === 'bundled' ? bundledData : localData,
      });
    });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        pipelines: {
          list: listMock,
          discoverProject: discoverProjectMock,
          get: getMock,
        },
        api: {
          loadPreferences: jest.fn(() =>
            Promise.resolve({ disabledPipelineIds: [] }),
          ),
        },
      },
    });

    await expect(loadHookPipelineOptions()).resolves.toEqual([
      {
        actionSource: 'bundled',
        actionId: 'review',
        data: bundledData,
      },
      {
        actionSource: 'local',
        actionId: 'review',
        data: localData,
      },
    ]);
    expect(discoverProjectMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenNthCalledWith(1, {
      id: 'review',
      source: 'bundled',
    });
    expect(getMock).toHaveBeenNthCalledWith(2, {
      id: 'review',
      source: 'user',
    });
  });

  it('excludes disabled pipelines from the picker', async (): Promise<void> => {
    const enabledInfo = createPipelineInfo({
      id: 'enabled',
      name: 'Enabled',
      source: 'user',
      readonly: false,
    });
    const disabledInfo = createPipelineInfo({
      id: 'disabled',
      name: 'Disabled',
      source: 'user',
      readonly: false,
    });
    const enabledData = createPipelineData(enabledInfo);
    const listMock = jest.fn<Promise<IPCResult<PipelineInfo[]>>, []>(() =>
      Promise.resolve({ success: true, data: [enabledInfo, disabledInfo] }),
    );
    const discoverProjectMock = jest.fn<
      Promise<IPCResult<PipelineInfo[]>>,
      [string]
    >(() => Promise.resolve({ success: true, data: [] }));
    const getMock = jest.fn<
      Promise<IPCResult<PipelineData>>,
      [string | { id: string; source: 'bundled' | 'user' }]
    >(() => Promise.resolve({ success: true, data: enabledData }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        pipelines: {
          list: listMock,
          discoverProject: discoverProjectMock,
          get: getMock,
        },
        api: {
          loadPreferences: jest.fn(() =>
            Promise.resolve({ disabledPipelineIds: ['disabled'] }),
          ),
        },
      },
    });

    const options = await loadHookPipelineOptions();
    expect(options).toEqual([
      { actionSource: 'local', actionId: 'enabled', data: enabledData },
    ]);
    // The disabled pipeline is filtered before hydration, so `get` is only
    // called for the enabled one.
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith({ id: 'enabled', source: 'user' });
  });

  it('loads options when disabled pipeline ids fail to load', async (): Promise<void> => {
    const info = createPipelineInfo({
      id: 'enabled',
      name: 'Enabled',
      source: 'user',
      readonly: false,
    });
    const data = createPipelineData(info);
    const listMock = jest.fn<Promise<IPCResult<PipelineInfo[]>>, []>(() =>
      Promise.resolve({ success: true, data: [info] }),
    );
    const discoverProjectMock = jest.fn<
      Promise<IPCResult<PipelineInfo[]>>,
      [string]
    >(() => Promise.resolve({ success: true, data: [] }));
    const getMock = jest.fn<
      Promise<IPCResult<PipelineData>>,
      [string | { id: string; source: 'bundled' | 'user' }]
    >(() => Promise.resolve({ success: true, data }));

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        pipelines: {
          list: listMock,
          discoverProject: discoverProjectMock,
          get: getMock,
        },
        api: {
          loadPreferences: jest.fn(() =>
            Promise.reject(new Error('Preferences unavailable')),
          ),
        },
      },
    });

    await expect(loadHookPipelineOptions()).resolves.toEqual([
      { actionSource: 'local', actionId: 'enabled', data },
    ]);
    expect(getMock).toHaveBeenCalledWith({ id: 'enabled', source: 'user' });
  });
});
