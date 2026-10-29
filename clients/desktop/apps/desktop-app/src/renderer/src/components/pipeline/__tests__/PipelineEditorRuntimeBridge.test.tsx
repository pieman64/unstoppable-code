/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelineEditorRendererToolRequest,
  PipelineEditorRendererToolResponse,
  PipelineEditorRow,
} from '@canopy/desktop-shared/types';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/desktop-shared/types/pipeline';
import type { UsePipelineEditorReturn } from '@/hooks/usePipelineEditor';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorControllerAdapter,
  type PipelineEditorControllerTarget,
  type PipelineEditorPageController,
} from '@/stores/pipelineEditorBridgeStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { PipelineEditorRuntimeBridge } from '../PipelineEditorRuntimeBridge';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface BridgeHarness {
  root: Root;
  container: HTMLDivElement;
  toolListener: (request: PipelineEditorRendererToolRequest) => void;
  completeToolRequestMock: jest.Mock<
    Promise<void>,
    [PipelineEditorRendererToolResponse]
  >;
  getSharedUpdateImpactMock: jest.Mock;
  emit: (request: PipelineEditorRendererToolRequest) => Promise<void>;
}

function makePipeline(name: string): Pipeline {
  return {
    name,
    version: '3.0',
    on: 'dispatch',
    jobs: {},
  };
}

const SAVED_INFO: PipelineInfo = {
  id: 'saved-pipeline',
  name: 'Saved',
  filename: 'saved.yaml',
  description: '',
  icon: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  readonly: false,
};

function makeEditor(
  overrides: Partial<UsePipelineEditorReturn> = {},
): UsePipelineEditorReturn {
  return {
    pipeline: makePipeline('Current'),
    pipelineInfo: null,
    loading: false,
    error: null,
    readonly: false,
    jobOrder: [],
    validation: [],
    canSave: true,
    selection: { type: 'none' },
    setSelection: jest.fn(),
    activePanel: 'steps',
    setActivePanel: jest.fn(),
    mainView: 'raw',
    setMainView: jest.fn(),
    updatePipelineField: jest.fn(),
    updateDefaults: jest.fn(),
    updateEnv: jest.fn(),
    addJob: jest.fn(),
    removeJob: jest.fn(),
    updateJob: jest.fn(),
    renameJob: jest.fn(),
    addStep: jest.fn(),
    removeStep: jest.fn(),
    updateStep: jest.fn(),
    reorderSteps: jest.fn(),
    moveStepBetweenJobs: jest.fn(),
    replaceEntirePipeline: jest.fn(),
    canUndo: false,
    canRedo: false,
    undo: jest.fn(),
    redo: jest.fn(),
    isDirty: false,
    saving: false,
    save: jest.fn().mockResolvedValue(SAVED_INFO),
    ...overrides,
  };
}

function makeAdapter(
  editor: UsePipelineEditorReturn,
  overrides: Partial<PipelineEditorControllerAdapter> = {},
): PipelineEditorControllerAdapter {
  return {
    getTarget: () => ({ pipelineId: 'current-pipeline' }),
    getEditor: () => editor,
    isRawMode: () => false,
    getRawYamlText: () => '',
    getRawYamlError: () => null,
    isRawYamlDirty: () => false,
    setRawYamlText: jest.fn(),
    clearRawYamlError: jest.fn(),
    resetRawYamlBaseline: jest.fn(),
    applyRawYaml: jest.fn(() => true),
    ...overrides,
  };
}

function makePageController(
  rows: PipelineEditorRow[],
  overrides: Partial<PipelineEditorPageController> = {},
): PipelineEditorPageController {
  return {
    openEditor: jest.fn(() => Promise.resolve(true)),
    openNewDraft: jest.fn(() =>
      Promise.resolve<PipelineEditorControllerTarget | null>({
        pipelineId: null,
        draftKey: 'draft-1',
      }),
    ),
    goToList: jest.fn(() => Promise.resolve(true)),
    getPipelineRows: jest.fn(() => rows),
    ...overrides,
  };
}

const VALID_YAML = [
  'pipeline:',
  '  name: New Name',
  '  version: "3.0"',
  '  on: dispatch',
  '  jobs: {}',
  '',
].join('\n');

function setupBridge(): BridgeHarness {
  const completeToolRequestMock = jest.fn<
    Promise<void>,
    [PipelineEditorRendererToolResponse]
  >(() => Promise.resolve());
  let toolListener: (
    request: PipelineEditorRendererToolRequest,
  ) => void = () => {};
  const getSharedUpdateImpactMock = jest.fn().mockResolvedValue({
    success: true,
    data: { automations: [] },
  });

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pipelineEditor: {
        onToolRequest: jest.fn(
          (
            listener: (request: PipelineEditorRendererToolRequest) => void,
          ): (() => void) => {
            toolListener = listener;
            return jest.fn();
          },
        ),
        completeToolRequest: completeToolRequestMock,
      },
    },
  });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: { getSharedUpdateImpact: getSharedUpdateImpactMock },
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(PipelineEditorRuntimeBridge));
  });

  return {
    root,
    container,
    completeToolRequestMock,
    getSharedUpdateImpactMock,
    get toolListener(): (request: PipelineEditorRendererToolRequest) => void {
      return toolListener;
    },
    emit: async (request: PipelineEditorRendererToolRequest): Promise<void> => {
      await act(async (): Promise<void> => {
        toolListener(request);
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
      });
    },
  };
}

function teardownBridge(harness: BridgeHarness): void {
  act(() => {
    harness.root.unmount();
  });
  harness.container.remove();
}

function getToolResponseAt(
  mock: jest.Mock<Promise<void>, [PipelineEditorRendererToolResponse]>,
  index: number,
): PipelineEditorRendererToolResponse {
  const response = mock.mock.calls[index]?.[0];
  if (!response) {
    throw new Error(`Expected Pipeline Editor tool response at index ${index}`);
  }
  return response;
}

describe('PipelineEditorRuntimeBridge', () => {
  let harness: BridgeHarness;

  beforeEach(() => {
    jest.clearAllMocks();
    usePipelineEditorBridgeStore.setState({
      editorController: null,
      pageController: null,
    });
    useNavigationStore.setState({ activePage: 'overview' });
    harness = setupBridge();
  });

  afterEach(() => {
    teardownBridge(harness);
    usePipelineEditorBridgeStore.setState({
      editorController: null,
      pageController: null,
    });
    useNavigationStore.setState({ activePage: 'overview' });
  });

  it('saves dirty raw YAML through applyRawYaml and the parsed save override', async () => {
    const rawText = [
      'pipeline:',
      '  name: Raw Saved',
      '  version: "3.0"',
      '  on: dispatch',
      '  jobs: {}',
      '',
    ].join('\n');
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const applyRawYamlMock = jest.fn(() => true);
    const editor = makeEditor({ save: saveMock });
    const adapter: PipelineEditorControllerAdapter = {
      getTarget: () => ({ pipelineId: 'current-pipeline' }),
      getEditor: () => editor,
      isRawMode: () => true,
      getRawYamlText: () => rawText,
      getRawYamlError: () => null,
      isRawYamlDirty: () => true,
      setRawYamlText: jest.fn(),
      clearRawYamlError: jest.fn(),
      resetRawYamlBaseline: jest.fn(),
      applyRawYaml: applyRawYamlMock,
    };
    usePipelineEditorBridgeStore.getState().registerEditorController(adapter);

    await harness.emit({ requestId: 'save-1', kind: 'save' });

    expect(applyRawYamlMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Raw Saved' }),
    );
    expect(adapter.resetRawYamlBaseline).toHaveBeenCalledWith(rawText);
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'save-1',
        ok: true,
        isDirty: false,
      },
    );
  });

  it('get_current in form mode returns serialized YAML and validation', async () => {
    const editor = makeEditor({
      mainView: 'list',
      pipeline: makePipeline('Form Pipeline'),
      validation: [{ type: 'warning', path: 'jobs', message: 'heads up' }],
    });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({ requestId: 'gc-1', kind: 'get_current' });

    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response).toMatchObject({
      requestId: 'gc-1',
      ok: true,
      readonly: false,
    });
    expect(response.pipelineYaml).toContain('name: Form Pipeline');
    expect(response.validation).toEqual([
      { type: 'warning', path: 'jobs', message: 'heads up' },
    ]);
  });

  it('get_current in raw mode surfaces the raw parse error as a single issue', async () => {
    const editor = makeEditor();
    const adapter = makeAdapter(editor, {
      isRawMode: () => true,
      getRawYamlText: () => 'pipeline: broken',
      getRawYamlError: () => 'Unexpected token',
      isRawYamlDirty: () => true,
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(adapter);

    await harness.emit({ requestId: 'gc-raw', kind: 'get_current' });

    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response).toMatchObject({
      requestId: 'gc-raw',
      ok: true,
      pipelineYaml: 'pipeline: broken',
      isDirty: true,
    });
    expect(response.validation).toEqual([
      { type: 'error', path: '', message: 'Unexpected token' },
    ]);
  });

  it('get_current in raw mode validates the current raw YAML text', async () => {
    const editor = makeEditor({
      pipeline: {
        name: 'Stale invalid applied pipeline',
        version: '3.0',
        on: 'dispatch',
        jobs: {
          'bad-job-id': { steps: [] },
        },
      },
    });
    const adapter = makeAdapter(editor, {
      isRawMode: () => true,
      getRawYamlText: () => VALID_YAML,
      getRawYamlError: () => null,
      isRawYamlDirty: () => true,
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(adapter);

    await harness.emit({ requestId: 'gc-raw-current', kind: 'get_current' });

    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response).toMatchObject({
      requestId: 'gc-raw-current',
      ok: true,
      pipelineYaml: VALID_YAML,
      isDirty: true,
    });
    expect(response.validation).toEqual([]);
  });

  it('set_yaml in form mode replaces the pipeline and saves the parsed override', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    const adapter = makeAdapter(editor);
    usePipelineEditorBridgeStore.getState().registerEditorController(adapter);

    await harness.emit({
      requestId: 'sy-1',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    // Form mode must not touch the raw textarea buffer.
    expect(adapter.setRawYamlText).not.toHaveBeenCalled();
    expect(adapter.clearRawYamlError).not.toHaveBeenCalled();
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'sy-1',
        ok: true,
        isDirty: false,
        readonly: false,
      },
    );
  });

  it('adds the affected-automation note to shared set_yaml and save successes', async () => {
    const editor = makeEditor();
    usePipelineEditorBridgeStore.getState().registerEditorController(
      makeAdapter(editor, {
        getTarget: () => ({
          pipelineId: 'shared:canopy-cloud:remote-1',
          sharedRemoteId: 'remote-1',
        }),
      }),
    );
    harness.getSharedUpdateImpactMock.mockResolvedValue({
      success: true,
      data: {
        automations: [{ id: 'activity-1', name: 'Nightly', kind: 'installed' }],
      },
    });

    await harness.emit({
      requestId: 'sy-shared',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });
    await harness.emit({ requestId: 'save-shared', kind: 'save' });

    const expectedNote =
      'People using this pipeline in their automations will need to approve your changes before they run again.';
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      { requestId: 'sy-shared', ok: true, note: expectedNote },
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      { requestId: 'save-shared', ok: true, note: expectedNote },
    );
    expect(harness.getSharedUpdateImpactMock).toHaveBeenNthCalledWith(
      1,
      'remote-1',
    );
    expect(harness.getSharedUpdateImpactMock).toHaveBeenNthCalledWith(
      2,
      'remote-1',
    );
  });

  it('set_yaml in raw mode clears stale raw YAML errors after saving', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const editor = makeEditor({ save: saveMock });
    const adapter = makeAdapter(editor, {
      isRawMode: () => true,
      getRawYamlError: () => 'Previous parse error',
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(adapter);

    await harness.emit({
      requestId: 'sy-raw',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(adapter.setRawYamlText).toHaveBeenCalledWith(VALID_YAML);
    expect(adapter.clearRawYamlError).toHaveBeenCalledTimes(1);
    expect(adapter.resetRawYamlBaseline).toHaveBeenCalledWith(VALID_YAML);
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'sy-raw',
        ok: true,
        isDirty: false,
      },
    );
  });

  it('set_yaml refuses to mutate a read-only pipeline', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      readonly: true,
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({
      requestId: 'sy-ro',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response).toMatchObject({
      requestId: 'sy-ro',
      ok: false,
      readonly: true,
    });
    expect(response.error).toMatch(/read-only/i);
  });

  it('set_yaml reports parse failures without mutating the editor', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({
      requestId: 'sy-bad',
      kind: 'set_yaml',
      yaml: 'pipeline:\n  name: "unterminated',
    });

    expect(replaceMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'sy-bad',
        ok: false,
      },
    );
  });

  it('returns a clear error when no editor is mounted', async () => {
    await harness.emit({ requestId: 'no-editor', kind: 'get_current' });
    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/No pipeline is open/i);
  });

  it('reports a still-loading editor when the pipeline is null', async () => {
    const editor = makeEditor({ pipeline: null });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({
      requestId: 'loading',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    const response = getToolResponseAt(harness.completeToolRequestMock, 0);
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/still loading/i);
  });

  it('refuses mutating writes while the editor is loading stale state', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      loading: true,
      pipeline: makePipeline('Previously Loaded'),
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({
      requestId: 'loading-set',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });
    await harness.emit({ requestId: 'loading-save', kind: 'save' });

    expect(replaceMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'loading-set',
        ok: false,
      },
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 0).error).toMatch(
      /still loading/i,
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      {
        requestId: 'loading-save',
        ok: false,
      },
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1).error).toMatch(
      /still loading/i,
    );
  });

  it('navigates to Pipelines and waits for a page controller when currently off-page', async () => {
    const rows: PipelineEditorRow[] = [
      { pipelineId: 'p1', name: 'P1', source: 'user', readonly: false },
    ];
    const controller = makePageController(rows);

    harness.toolListener({ requestId: 'list-offpage', kind: 'list' });
    await act(async (): Promise<void> => {
      await Promise.resolve();
      usePipelineEditorBridgeStore
        .getState()
        .registerPageController(controller);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'list-offpage',
        ok: true,
        pipelines: rows,
      },
    );
  });

  it('routes list/open/create/to_list through the page controller', async () => {
    const rows: PipelineEditorRow[] = [
      { pipelineId: 'p1', name: 'P1', source: 'user', readonly: false },
    ];
    const controller = makePageController(rows);
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({ requestId: 'list-ok', kind: 'list' });
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'list-ok',
        ok: true,
        pipelines: rows,
      },
    );

    await harness.emit({
      requestId: 'open-ok',
      kind: 'open',
      locator: { pipelineId: 'p1' },
    });
    expect(controller.openEditor).toHaveBeenCalledWith({ pipelineId: 'p1' });

    await harness.emit({ requestId: 'create-ok', kind: 'create' });
    expect(controller.openNewDraft).toHaveBeenCalledTimes(1);

    await harness.emit({ requestId: 'tolist-ok', kind: 'to_list' });
    expect(controller.goToList).toHaveBeenCalledTimes(1);

    expect(
      harness.completeToolRequestMock.mock.calls.map(([response]) => response),
    ).toEqual([
      expect.objectContaining({ requestId: 'list-ok', ok: true }),
      { requestId: 'open-ok', ok: true },
      { requestId: 'create-ok', ok: true },
      { requestId: 'tolist-ok', ok: true },
    ]);
  });

  it.each([
    [
      'open',
      { requestId: 'open-kept', kind: 'open', locator: { pipelineId: 'p1' } },
      { openEditor: jest.fn(() => Promise.resolve(false)) },
    ],
    [
      'create',
      { requestId: 'create-kept', kind: 'create' },
      { openNewDraft: jest.fn(() => Promise.resolve(null)) },
    ],
    [
      'to_list',
      { requestId: 'to_list-kept', kind: 'to_list' },
      { goToList: jest.fn(() => Promise.resolve(false)) },
    ],
  ] satisfies ReadonlyArray<
    [
      string,
      PipelineEditorRendererToolRequest,
      Partial<PipelineEditorPageController>,
    ]
  >)(
    'answers %s with the kept-editing error when the person keeps editing',
    async (_kind, request, overrides) => {
      usePipelineEditorBridgeStore
        .getState()
        .registerPageController(makePageController([], overrides));

      await harness.emit(request);

      expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toEqual({
        requestId: request.requestId,
        ok: false,
        error: 'The person kept editing unsaved changes.',
      });
    },
  );

  it('answers once the unsaved-changes prompt is answered, never before', async () => {
    let answer: (opened: boolean) => void = () => undefined;
    const controller = makePageController([], {
      openEditor: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({
      requestId: 'open-waits',
      kind: 'open',
      locator: { pipelineId: 'p1' },
    });
    expect(harness.completeToolRequestMock).not.toHaveBeenCalled();

    await act(async (): Promise<void> => {
      answer(false);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toEqual({
      requestId: 'open-waits',
      ok: false,
      error: 'The person kept editing unsaved changes.',
    });
  });

  it('keeps editing the shown pipeline after a declined open', async () => {
    const replaceMock = jest.fn();
    const editor = makeEditor({ replaceEntirePipeline: replaceMock });
    usePipelineEditorBridgeStore.getState().registerEditorController(
      makeAdapter(editor, {
        getTarget: () => ({ pipelineId: 'current-pipeline' }),
      }),
    );
    usePipelineEditorBridgeStore.getState().registerPageController(
      makePageController([], {
        openEditor: jest.fn(() => Promise.resolve(false)),
      }),
    );

    await harness.emit({
      requestId: 'open-declined',
      kind: 'open',
      locator: { pipelineId: 'next-pipeline' },
    });
    // No pending target: the next edit applies to the pipeline still shown.
    await harness.emit({
      requestId: 'set-after-declined',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      { requestId: 'set-after-declined', ok: true },
    );
  });

  it('applies follow-up editor calls after an opened pipeline target is active', async () => {
    let activeTarget: PipelineEditorControllerTarget = {
      pipelineId: 'old-pipeline',
    };
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      pipeline: makePipeline('Previously Loaded'),
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(
      makeAdapter(editor, {
        getTarget: () => activeTarget,
      }),
    );
    const controller = makePageController([]);
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({
      requestId: 'open-next',
      kind: 'open',
      locator: { pipelineId: 'next-pipeline' },
    });

    expect(controller.openEditor).toHaveBeenCalledWith({
      pipelineId: 'next-pipeline',
    });

    activeTarget = { pipelineId: 'next-pipeline' };
    await harness.emit({
      requestId: 'set-after-active',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      {
        requestId: 'set-after-active',
        ok: true,
      },
    );
  });

  it('applies follow-up editor calls after a newly created draft target is active', async () => {
    let activeTarget: PipelineEditorControllerTarget = {
      pipelineId: null,
      draftKey: 'draft-1',
    };
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      pipeline: makePipeline('Previous Draft'),
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(
      makeAdapter(editor, {
        getTarget: () => activeTarget,
      }),
    );
    const controller = makePageController([], {
      openNewDraft: jest.fn(() =>
        Promise.resolve<PipelineEditorControllerTarget | null>({
          pipelineId: null,
          draftKey: 'draft-2',
        }),
      ),
    });
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({ requestId: 'create-next', kind: 'create' });

    expect(controller.openNewDraft).toHaveBeenCalledTimes(1);

    activeTarget = { pipelineId: null, draftKey: 'draft-2' };
    await harness.emit({
      requestId: 'set-after-new-draft-active',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      {
        requestId: 'set-after-new-draft-active',
        ok: true,
      },
    );
  });

  it('surfaces failed pending pipeline loads and clears the pending target', async () => {
    let activeTarget: PipelineEditorControllerTarget = {
      pipelineId: 'old-pipeline',
    };
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const replaceMock = jest.fn();
    const editor = makeEditor({
      pipeline: makePipeline('Previously Loaded'),
      save: saveMock,
      replaceEntirePipeline: replaceMock,
    });
    usePipelineEditorBridgeStore.getState().registerEditorController(
      makeAdapter(editor, {
        getTarget: () => activeTarget,
      }),
    );
    const controller = makePageController([]);
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({
      requestId: 'open-failing',
      kind: 'open',
      locator: { pipelineId: 'failing-pipeline' },
    });

    activeTarget = { pipelineId: 'failing-pipeline' };
    editor.loading = false;
    editor.pipeline = null;
    editor.error = 'Pipeline load failed';
    await harness.emit({
      requestId: 'set-after-failed-load',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      {
        requestId: 'set-after-failed-load',
        ok: false,
        error: 'Pipeline load failed',
      },
    );

    activeTarget = { pipelineId: 'other-pipeline' };
    editor.pipeline = makePipeline('Other Pipeline');
    editor.error = null;
    await harness.emit({
      requestId: 'set-after-pending-cleared',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    expect(replaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Name' }),
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 2)).toMatchObject(
      {
        requestId: 'set-after-pending-cleared',
        ok: true,
      },
    );
  });

  it('returns the cached response for a repeated requestId without re-dispatching', async () => {
    const saveMock = jest.fn<Promise<PipelineInfo | null>, [Pipeline?]>(() =>
      Promise.resolve(SAVED_INFO),
    );
    const editor = makeEditor({ save: saveMock });
    usePipelineEditorBridgeStore
      .getState()
      .registerEditorController(makeAdapter(editor));

    await harness.emit({
      requestId: 'dup',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });
    await harness.emit({
      requestId: 'dup',
      kind: 'set_yaml',
      yaml: VALID_YAML,
    });

    // Second emit must hit the response cache, not re-run the save.
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(harness.completeToolRequestMock).toHaveBeenCalledTimes(2);
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toEqual(
      getToolResponseAt(harness.completeToolRequestMock, 0),
    );
  });

  it('scopes cached responses to the originating chat (CAN-3976)', async () => {
    const rows: PipelineEditorRow[] = [
      { pipelineId: 'p1', name: 'P1', source: 'user', readonly: false },
    ];
    const controller = makePageController(rows);
    usePipelineEditorBridgeStore.getState().registerPageController(controller);

    await harness.emit({ requestId: '1', kind: 'list', originChatId: 'a' });
    await harness.emit({ requestId: '1', kind: 'create', originChatId: 'b' });
    await harness.emit({ requestId: '1', kind: 'list', originChatId: 'a' });

    expect(controller.openNewDraft).toHaveBeenCalledTimes(1);
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      { requestId: '1', originChatId: 'a', pipelines: rows },
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toMatchObject(
      { requestId: '1', originChatId: 'b', ok: true },
    );
    expect(getToolResponseAt(harness.completeToolRequestMock, 2)).toBe(
      getToolResponseAt(harness.completeToolRequestMock, 0),
    );
  });
});
