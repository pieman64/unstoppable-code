/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePipelineEditor } from '../usePipelineEditor';
import type {
  Pipeline,
  PipelineData,
  PipelineInfo,
  SharedPipelineDetail,
} from '@canopy/desktop-shared/types/pipeline';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let latestEditor: ReturnType<typeof usePipelineEditor> | null = null;
let saveMock: jest.Mock;
let getMock: jest.Mock;
let getSharedMock: jest.Mock;
let editorRequest: Parameters<typeof usePipelineEditor>[0] = {
  pipelineId: 'plugin-collection-skills',
};

const oldPipeline: Pipeline = {
  name: 'Plugin Collection Skills Example',
  on: 'dispatch',
  plugin_collections: [
    {
      id: 'skill_inventory_tools',
      name: 'Skill Inventory Tools',
      defaults: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'canopy-config',
          required: true,
        },
      ],
    },
  ],
  jobs: {
    list_available_skills: {
      steps: [{ id: 'list_skills', run: 'echo old' }],
    },
  },
};

const fixedPipeline: Pipeline = {
  ...oldPipeline,
  plugin_collections: [
    {
      id: 'skill_inventory_tools',
      name: 'Skill Inventory Tools',
      defaults: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'canopy-config',
          required: true,
        },
      ],
    },
  ],
  jobs: {
    list_available_skills: {
      steps: [{ id: 'list_skills', run: 'echo fixed' }],
    },
  },
};

function makePipelineInfo(name: string): PipelineInfo {
  return {
    id: 'plugin-collection-skills',
    name,
    source: 'user',
    readonly: false,
    filename: 'plugin-collection-skills.yaml',
    filePath: '',
    triggerTypes: ['dispatch'],
  } as PipelineInfo;
}

function installPipelineApi(): void {
  const info = makePipelineInfo(oldPipeline.name);
  const pipelineData: PipelineData = {
    info,
    content: oldPipeline,
  };
  const sharedDetail: SharedPipelineDetail = {
    id: 'remote-1',
    name: 'Shared Test Pipeline',
    description: 'Shared description',
    icon: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    triggerTypes: ['dispatch'],
    canUpdate: true,
    canDelete: true,
    shareScope: 'private',
    rawPipeline: [
      'pipeline:',
      '  name: Shared Test Pipeline',
      '  version: "3.0"',
      '  on: dispatch',
      '  jobs: {}',
      '',
    ].join('\n'),
  };

  saveMock = jest
    .fn()
    .mockResolvedValueOnce({
      success: false,
      error:
        'Pipeline plugin_collections[0].defaults[0] builtin skill source id must be "app"',
    })
    .mockResolvedValueOnce({
      success: true,
      data: makePipelineInfo(fixedPipeline.name),
    });
  getMock = jest.fn().mockResolvedValue({ success: true, data: pipelineData });
  getSharedMock = jest
    .fn()
    .mockResolvedValue({ success: true, data: sharedDetail });

  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      get: getMock,
      getShared: getSharedMock,
      save: saveMock,
    },
  });
}

function Harness(): JSX.Element {
  latestEditor = usePipelineEditor(editorRequest);
  return <div />;
}

async function renderHarness(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('usePipelineEditor save', () => {
  beforeEach(() => {
    editorRequest = { pipelineId: 'plugin-collection-skills' };
    installPipelineApi();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    latestEditor = null;
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  it('saves an override pipeline and clears a previously shown save error on success', async () => {
    await renderHarness();

    await act(async () => {
      const saved = await latestEditor?.save();
      expect(saved).toBeNull();
    });

    expect(latestEditor?.error).toContain('builtin skill source id');

    await act(async () => {
      const saved = await latestEditor?.save(fixedPipeline);
      expect(saved).toMatchObject({
        id: 'plugin-collection-skills',
        source: 'user',
      });
    });

    expect(saveMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: fixedPipeline,
        name: fixedPipeline.name,
      }),
    );
    expect(latestEditor?.error).toBeNull();
  });

  it('loads shared pipelines by sharedRemoteId even when pipelineId is null', async () => {
    editorRequest = { pipelineId: null, sharedRemoteId: 'remote-1' };

    await renderHarness();

    expect(getSharedMock).toHaveBeenCalledWith({
      remoteId: 'remote-1',
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(latestEditor?.pipeline?.name).toBe('Shared Test Pipeline');
    expect(latestEditor?.pipelineInfo?.remoteId).toBe('remote-1');
  });

  it('applies model_aliases edits through the generic updatePipelineField path', async () => {
    await renderHarness();

    expect(latestEditor?.pipeline?.model_aliases).toBeUndefined();

    const aliases = [
      {
        id: 'reviewer',
        name: 'Reviewer',
        defaults: { base: 'claude-sonnet-4-6' },
      },
    ];
    act(() => {
      latestEditor?.updatePipelineField('model_aliases', aliases);
    });

    expect(latestEditor?.pipeline?.model_aliases).toEqual(aliases);
    expect(latestEditor?.isDirty).toBe(true);
  });

  it('is clean after saving the edited pipeline in place', async () => {
    await renderHarness();
    await act(async () => {
      await latestEditor?.save(fixedPipeline);
    });
    act(() => {
      latestEditor?.updatePipelineField('description', 'Edited');
    });
    expect(latestEditor?.isDirty).toBe(true);

    // A Flow or List save passes no override: it saves the editor's own
    // pipeline object.
    await act(async () => {
      await latestEditor?.save();
    });

    expect(latestEditor?.error).toBeNull();
    expect(latestEditor?.isDirty).toBe(false);
    expect(latestEditor?.canSave).toBe(false);
  });
});
