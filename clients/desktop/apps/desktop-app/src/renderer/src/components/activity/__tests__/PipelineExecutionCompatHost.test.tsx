/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  closePipelineCompatDetail,
  openPipelineCompatDetail,
  resetPipelineCompatDetailStoreForTests,
  usePipelineCompatDetailStore,
} from '@/stores/pipelineCompatDetailStore';
import { PipelineExecutionCompatHost } from '../PipelineExecutionCompatHost';

const modalProps: Array<Record<string, unknown>> = [];

jest.mock('../PipelineExecutionDetailModal', () => ({
  PipelineExecutionDetailModal: (
    props: Record<string, unknown>,
  ): JSX.Element => {
    modalProps.push(props);
    return <div data-testid="compat-modal" />;
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('PipelineExecutionCompatHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    modalProps.length = 0;
    resetPipelineCompatDetailStoreForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<PipelineExecutionCompatHost />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders nothing until an ownerless run is opened', () => {
    expect(container.querySelector('[data-testid="compat-modal"]')).toBeNull();
  });

  it('shows the run with an ownerless lease and re-targets it on each open', () => {
    act(() => {
      openPipelineCompatDetail('run-1', { jobId: 'build' });
    });

    expect(
      container.querySelector('[data-testid="compat-modal"]'),
    ).not.toBeNull();
    expect(modalProps.at(-1)).toMatchObject({
      executionId: 'run-1',
      detailOwner: null,
      initialJobId: 'build',
      revealTarget: { nonce: 1, jobId: 'build' },
    });

    act(() => {
      openPipelineCompatDetail('run-1', {
        viewStack: [{ executionId: 'child', label: 'Child' }],
        jobId: 'deploy',
      });
    });
    expect(modalProps.at(-1)).toMatchObject({
      executionId: 'run-1',
      revealTarget: {
        nonce: 2,
        jobId: 'deploy',
        viewStack: [{ executionId: 'child', label: 'Child' }],
      },
    });
  });

  it('closes through its store', () => {
    act(() => {
      openPipelineCompatDetail('run-1');
    });
    const onClose = modalProps.at(-1)?.onClose;
    expect(onClose).toBe(closePipelineCompatDetail);

    act(() => {
      closePipelineCompatDetail();
    });
    expect(usePipelineCompatDetailStore.getState().request).toBeNull();
    expect(container.querySelector('[data-testid="compat-modal"]')).toBeNull();
  });
});
