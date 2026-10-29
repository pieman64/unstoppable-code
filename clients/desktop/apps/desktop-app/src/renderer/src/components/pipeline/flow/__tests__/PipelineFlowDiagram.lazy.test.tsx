/**
 * @jest-environment jsdom
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PipelineFlowDiagram,
  type PipelineFlowSource,
} from '../PipelineFlowDiagram';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('../PipelineFlowDiagramView', () => ({
  PipelineFlowDiagram: ({
    source,
    selection,
  }: {
    source: { kind: string };
    selection?: { type: string; jobId: string };
  }): ReactElement => (
    <div
      data-testid="pipeline-flow-view"
      data-source-kind={source.kind}
      data-selected-job={selection?.jobId}
    />
  ),
}));

const SOURCE = {
  kind: 'definition',
  pipeline: { name: 'Fixture', jobs: {} },
  jobOrder: [],
} as unknown as PipelineFlowSource;

describe('lazily loaded PipelineFlowDiagram', () => {
  // React Flow loads once per module registry, so this test must run before
  // the one that renders it loaded.
  it('leaves its container empty while React Flow loads', () => {
    expect(renderToStaticMarkup(<PipelineFlowDiagram source={SOURCE} />)).toBe(
      '',
    );
  });

  it('renders the loaded diagram with its props', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(() => {
      root.render(
        <PipelineFlowDiagram
          source={SOURCE}
          selection={{ type: 'job', jobId: 'build' }}
        />,
      );
      // An async act scope lets the lazy import resolve and render.
      return Promise.resolve();
    });

    const view = container.querySelector('[data-testid="pipeline-flow-view"]');
    expect(view?.getAttribute('data-source-kind')).toBe('definition');
    expect(view?.getAttribute('data-selected-job')).toBe('build');

    act(() => root.unmount());
    container.remove();
  });
});
