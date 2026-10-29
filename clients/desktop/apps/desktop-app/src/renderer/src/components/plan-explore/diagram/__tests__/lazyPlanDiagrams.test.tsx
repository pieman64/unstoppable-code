/**
 * @jest-environment jsdom
 */
import { act, createRef, type ComponentType } from 'react';
import type * as ReactModule from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import { PlanDataModelDiffDiagram } from '../PlanDataModelDiffDiagram';
import { PlanLogicDiffDiagram } from '../PlanLogicDiffDiagram';
import { PlanSequenceDiagram } from '../PlanSequenceDiagram';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// Each view stands in for the React Flow implementation: it renders its props
// and exposes a search handle, so the tests can see both cross the wrapper.
function mockDiagramView(testId: string): unknown {
  const React = jest.requireActual<typeof ReactModule>('react');
  return React.forwardRef(function MockDiagramView(
    props: { isGenerating?: boolean },
    ref: React.Ref<DiagramSearchHandle>,
  ) {
    React.useImperativeHandle(ref, () => ({
      search: (query: string): string[] => [`${testId}:${query}`],
      reveal: (): void => undefined,
      clear: (): void => undefined,
    }));
    return React.createElement('div', {
      'data-testid': testId,
      'data-generating': String(props.isGenerating ?? false),
    });
  });
}

jest.mock('../PlanSequenceDiagramView', () => ({
  PlanSequenceDiagram: mockDiagramView('sequence-view'),
}));
jest.mock('../PlanLogicDiffDiagramView', () => ({
  PlanLogicDiffDiagram: mockDiagramView('logic-diff-view'),
}));
jest.mock('../PlanDataModelDiffDiagramView', () => ({
  PlanDataModelDiffDiagram: mockDiagramView('data-model-view'),
}));

const WRAPPERS = [
  ['sequence-view', PlanSequenceDiagram],
  ['logic-diff-view', PlanLogicDiffDiagram],
  ['data-model-view', PlanDataModelDiffDiagram],
] as const;

describe('lazily loaded plan diagrams', () => {
  // React Flow loads once per module registry, so this test must run before
  // the one that renders the diagrams loaded.
  it('show the empty diagram frame while React Flow loads', () => {
    for (const [testId, Diagram] of WRAPPERS) {
      const markup = renderToStaticMarkup(<Diagram artifact={undefined} />);
      expect(markup).toBe('<div class="flex min-h-0 flex-1 flex-col"></div>');
      expect(markup).not.toContain(testId);
    }
  });

  it('render the loaded diagram with its props and search handle', async () => {
    for (const [testId, Diagram] of WRAPPERS) {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      const ref = createRef<DiagramSearchHandle>();
      const Component: ComponentType<{
        diagramRef: typeof ref;
      }> = ({ diagramRef }) => (
        <Diagram artifact={undefined} isGenerating ref={diagramRef} />
      );

      await act(() => {
        root.render(<Component diagramRef={ref} />);
        // An async act scope lets the lazy import resolve and render.
        return Promise.resolve();
      });

      const view = container.querySelector(`[data-testid="${testId}"]`);
      expect(view?.getAttribute('data-generating')).toBe('true');
      expect(ref.current?.search('needle')).toEqual([`${testId}:needle`]);

      act(() => root.unmount());
      container.remove();
    }
  });
});
