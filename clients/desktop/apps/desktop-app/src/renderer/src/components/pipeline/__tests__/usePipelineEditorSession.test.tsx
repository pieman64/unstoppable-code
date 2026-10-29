/**
 * @jest-environment jsdom
 *
 * CAN-4072: a host that owns ⌘S hosts the editor session without its
 * shortcuts, and still saves through the session.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UsePipelineEditorReturn } from '@/hooks/usePipelineEditor';
import type { UnsavedChangesSaveResult } from '@canopy/ui-app/workflows';

const mockEditor: UsePipelineEditorReturn = {
  pipeline: {
    name: 'Review',
    description: 'Review a change.',
    version: '1',
    on: 'dispatch',
    jobs: {
      review: { steps: [{ id: 'review-step', uses: 'builtin/agent-prompt' }] },
    },
  },
  pipelineInfo: {
    id: 'review',
    name: 'Review',
    filename: 'review.yaml',
    description: '',
    icon: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
  },
  loading: false,
  error: null,
  readonly: false,
  jobOrder: ['review'],
  validation: [],
  canSave: true,
  selection: { type: 'none' },
  setSelection: jest.fn(),
  activePanel: 'steps',
  setActivePanel: jest.fn(),
  mainView: 'flowchart',
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
  canUndo: true,
  canRedo: false,
  undo: jest.fn(),
  redo: jest.fn(),
  isDirty: true,
  saving: false,
  save: jest.fn().mockResolvedValue(null),
};

jest.mock('@/hooks/usePipelineEditor', () => ({
  usePipelineEditor: (): UsePipelineEditorReturn => mockEditor,
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));
jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): {
    requestShare: jest.Mock;
    shareGateModal: null;
  } => ({
    requestShare: jest.fn(),
    shareGateModal: null,
  }),
}));
jest.mock('@/stores/pipelineEditorBridgeStore', () => ({
  usePipelineEditorBridgeStore: (
    selector: (state: {
      registerEditorController: jest.Mock;
      unregisterEditorController: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      registerEditorController: jest.fn(),
      unregisterEditorController: jest.fn(),
    }),
}));

import {
  usePipelineEditorSession,
  type PipelineEditorSession,
  type PipelineEditorSessionOptions,
} from '../usePipelineEditorSession';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let root: Root | null = null;
let session: PipelineEditorSession | null = null;

function Harness({
  options,
}: {
  options?: PipelineEditorSessionOptions;
}): JSX.Element | null {
  session = usePipelineEditorSession({ pipelineId: 'review' }, options);
  return null;
}

function renderSession(options?: PipelineEditorSessionOptions): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness options={options} />));
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEditor.save = jest.fn().mockResolvedValue(null);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  session = null;
  document.body.innerHTML = '';
});

describe('usePipelineEditorSession', () => {
  it('binds ⌘S and ⌘Z by default', async () => {
    renderSession();

    expect(press('s').defaultPrevented).toBe(true);
    await flush();
    expect(mockEditor.save).toHaveBeenCalledTimes(1);

    press('z');
    expect(mockEditor.undo).toHaveBeenCalledTimes(1);
  });

  it('leaves ⌘S and ⌘Z to the host with bindShortcuts off', async () => {
    renderSession({ bindShortcuts: false });

    expect(press('s').defaultPrevented).toBe(false);
    press('z');
    press('z', { shiftKey: true });
    await flush();

    expect(mockEditor.save).not.toHaveBeenCalled();
    expect(mockEditor.undo).not.toHaveBeenCalled();
    expect(mockEditor.redo).not.toHaveBeenCalled();
    expect(session?.isDirty).toBe(true);
    expect(session?.canSave).toBe(true);
  });

  it('keeps ⌘Z and ⇧⌘Z but leaves ⌘S to the host with bindSaveShortcut off', async () => {
    renderSession({ bindSaveShortcut: false });

    expect(press('s').defaultPrevented).toBe(false);
    await flush();
    expect(mockEditor.save).not.toHaveBeenCalled();

    expect(press('z').defaultPrevented).toBe(true);
    press('z', { shiftKey: true });
    expect(mockEditor.undo).toHaveBeenCalledTimes(1);
    expect(mockEditor.redo).toHaveBeenCalledTimes(1);
  });

  it('still saves for the App Advisor save action without the shortcut', async () => {
    renderSession({ bindSaveShortcut: false });

    act(() => {
      window.dispatchEvent(new Event('canopy:pipeline-save-active'));
    });
    await flush();

    expect(mockEditor.save).toHaveBeenCalledTimes(1);
  });

  it('saves on request and reports a failed save without leaving clean', async () => {
    renderSession({ bindShortcuts: false });

    let result: UnsavedChangesSaveResult | undefined;
    await act(async () => {
      result = await session?.save();
    });

    expect(mockEditor.save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      message: 'The pipeline could not be saved.',
    });
    expect(session?.isDirty).toBe(true);
  });

  it('reports a successful save to the host', async () => {
    const saved = mockEditor.pipelineInfo;
    mockEditor.save = jest.fn().mockResolvedValue(saved);
    const onSaved = jest.fn();
    renderSession({ bindShortcuts: false, onSaved });

    let result: UnsavedChangesSaveResult | undefined;
    await act(async () => {
      result = await session?.save();
    });

    expect(result).toEqual({ ok: true });
    expect(onSaved).toHaveBeenCalledWith(saved, { wasDraft: false });
  });
});
