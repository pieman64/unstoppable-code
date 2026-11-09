/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  Pipeline,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';

jest.mock('@/hooks/useShareAccess', () => ({
  useShareAccess: (): object => ({
    requestShare: (): undefined => undefined,
    shareGateModal: null,
  }),
}));
jest.mock('../../../hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): undefined => undefined,
}));
jest.mock('../SharePipelineModal', () => ({
  SharePipelineModal: (): null => null,
}));
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openCloudAccountSettings: (): undefined => undefined,
}));
jest.mock('@/client/interface-tools-client', () => ({
  contributeInterfaceTools: (): (() => void) => (): undefined => undefined,
}));

import {
  usePipelineEditorSession,
  type PipelineEditorSession,
} from '../usePipelineEditorSession';
import { usePipelineEditorBridgeStore } from '../../../stores/pipelineEditorBridgeStore';
import { PipelineEditorRuntimeBridge } from '../PipelineEditorRuntimeBridge';
import type {
  PipelineEditorRendererToolRequest,
  PipelineEditorRendererToolResponse,
} from '@canopy/desktop-shared/types';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const pipelineNamed = (name: string): Pipeline => ({
  name,
  on: 'dispatch',
  jobs: { build: { steps: [{ run: `echo ${name}` }] } },
});
const savedInfo: PipelineInfo = {
  id: 'pipe-1',
  name: 'Agent draft',
  filename: 'pipe-1.yaml',
  description: '',
  icon: '',
  createdAt: '',
  updatedAt: '',
  triggerTypes: ['dispatch'],
  stepCount: 1,
  revision: 1,
  source: 'user',
  readonly: false,
};

let session: PipelineEditorSession | null = null;
function Harness(): null {
  session = usePipelineEditorSession(
    { pipelineId: null, draftKey: 'draft-1' },
    { bindShortcuts: false },
  );
  return null;
}

const current = (): PipelineEditorSession => {
  if (!session) throw new Error('not rendered');
  return session;
};

describe('Pipeline Editor agent saves (CAN-5822 review fixes)', () => {
  let root: Root;
  const save = jest.fn();

  beforeEach(() => {
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { save },
    });
    root = createRoot(document.createElement('div'));
    act(() => {
      root.render(<Harness />);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    session = null;
    save.mockReset();
  });

  it('a held agent save refuses every overlapping save until it is released', async () => {
    // Same tick, same render: the race where two saves of a new draft both
    // reached core and created two pipelines.
    const editor = current().editor;
    let release: (() => void) | null = null;
    await act(async () => {
      release = editor.holdSave();
      expect(editor.holdSave()).toBeNull();
      expect(await editor.save(pipelineNamed('x'))).toBeNull();
    });
    expect(release).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    act(() => release?.());
    let again: (() => void) | null = null;
    act(() => {
      again = current().editor.holdSave();
    });
    expect(again).not.toBeNull();
    act(() => again?.());
  });

  it('a save adopted while the draft is dirty becomes what Discard restores', () => {
    const controller = usePipelineEditorBridgeStore.getState().editorController;
    if (!controller) throw new Error('no editor controller');
    const agentDraft = pipelineNamed('Agent draft');
    act(() => {
      current().editor.replaceEntirePipeline(agentDraft);
    });
    // The user keeps editing while core saves the agent's draft.
    act(() => {
      current().editor.replaceEntirePipeline(pipelineNamed('User edit'));
    });
    act(() => {
      controller.adoptSaved(agentDraft, savedInfo);
    });
    expect(current().editor.pipeline?.name).toBe('User edit');
    expect(current().editor.isDirty).toBe(true);
    expect(current().editor.pipelineInfo?.revision).toBe(1);
    act(() => {
      current().discard();
    });
    expect(current().editor.pipeline).toEqual(agentDraft);
    expect(current().editor.isDirty).toBe(false);
  });

  it('only the editor that handed over the draft adopts its save', async () => {
    let deliver: (request: PipelineEditorRendererToolRequest) => void = () =>
      undefined;
    const replies: PipelineEditorRendererToolResponse[] = [];
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pipelineEditor: {
          onToolRequest: (
            listener: (request: PipelineEditorRendererToolRequest) => void,
          ): (() => void) => {
            deliver = listener;
            return (): undefined => undefined;
          },
          completeToolRequest: (
            response: PipelineEditorRendererToolResponse,
          ): Promise<void> => {
            replies.push(response);
            return Promise.resolve();
          },
        },
      },
    });
    const renderEditor = (editorKey: string): void => {
      act(() => {
        root.render(
          <>
            <PipelineEditorRuntimeBridge />
            <Harness key={editorKey} />
          </>,
        );
      });
    };
    const send = async (
      request: PipelineEditorRendererToolRequest,
    ): Promise<PipelineEditorRendererToolResponse | undefined> => {
      const before = replies.length;
      await act(async () => {
        deliver(request);
        for (let tick = 0; tick < 20 && replies.length === before; tick += 1)
          await Promise.resolve();
      });
      return replies.at(-1);
    };
    const prepareAndAdopt = async (
      reopen: boolean,
      requestId: string,
    ): Promise<void> => {
      const prepared = await send({ kind: 'prepare_save', requestId });
      const snapshotId = prepared?.snapshot?.id;
      if (!snapshotId) throw new Error('no snapshot');
      // The editor is closed and the same new draft opened again while
      // core saves.
      if (reopen) renderEditor(`${requestId}-reopened`);
      await send({
        kind: 'adopt_saved',
        requestId: `${requestId}-adopt`,
        snapshotId,
        saved: { kind: 'stored', info: savedInfo },
      });
    };

    renderEditor('first');
    await prepareAndAdopt(true, 'reopened');
    expect(current().editor.pipelineInfo).toBeNull();
    await prepareAndAdopt(false, 'same');
    expect(current().editor.pipelineInfo?.id).toBe('pipe-1');
  });
});
