/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EntityForceGraph } from '../EntityForceGraph';
import type { ExplorerEntityGraph } from '@canopy/protocol/settings/organization-memory';

interface MockGraphLink {
  source: string;
  target: string;
  weight: number;
  factIds: string[];
}

interface MockForceGraphProps {
  linkColor: (link: MockGraphLink) => string;
  nodeCanvasObject: unknown;
  linkWidth: unknown;
  graphData: { nodes: unknown[]; links: unknown[] };
}

let mockLinkColor: ((link: MockGraphLink) => string) | null = null;
let mockProps: MockForceGraphProps | null = null;

jest.mock('react-force-graph-2d', () => ({
  __esModule: true,
  default: (props: MockForceGraphProps): null => {
    mockLinkColor = props.linkColor;
    mockProps = props;
    return null;
  },
}));

const GRAPH: ExplorerEntityGraph = {
  nodes: [
    {
      id: 'a',
      canonicalName: 'Alpha',
      entityType: 'SERVICE',
      factCount: 2,
      factIds: ['f1'],
    },
    {
      id: 'b',
      canonicalName: 'Beta',
      entityType: 'CODE',
      factCount: 1,
      factIds: ['f2'],
    },
  ],
  edges: [{ source: 'a', target: 'b', weight: 1, factIds: ['f1'] }],
  truncated: false,
};

class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function setTertiaryToken(value: string): void {
  document.documentElement.style.setProperty('--fg-tertiary', value);
}

describe('EntityForceGraph palette', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.ResizeObserver = StubResizeObserver;
    // The graph only mounts once the container reports a size, which jsdom
    // otherwise always reports as 0.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 600,
    });
    mockLinkColor = null;
    mockProps = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('class');
    document.documentElement.removeAttribute('data-theme');
  });

  function render(graph: ExplorerEntityGraph = GRAPH): void {
    act(() => {
      root.render(
        <EntityForceGraph
          graph={graph}
          onSelectNode={() => {}}
          onSelectEdge={() => {}}
        />,
      );
    });
  }

  function cloneGraph(graph: ExplorerEntityGraph): ExplorerEntityGraph {
    return {
      nodes: graph.nodes.map((node) => ({
        ...node,
        factIds: [...node.factIds],
      })),
      edges: graph.edges.map((edge) => ({
        ...edge,
        factIds: [...edge.factIds],
      })),
      truncated: graph.truncated,
    };
  }

  async function renderAsync(graph: ExplorerEntityGraph): Promise<void> {
    // The graph-merge effect applies new payloads through a microtask hop, so
    // renders that may swap graphData need the async act to flush it.
    await act(async () => {
      root.render(
        <EntityForceGraph
          graph={graph}
          onSelectNode={() => {}}
          onSelectEdge={() => {}}
        />,
      );
      await Promise.resolve();
    });
  }

  it('keeps paint callbacks and graphData identity stable across an equal refresh', async () => {
    await renderAsync(GRAPH);
    expect(mockProps).not.toBeNull();
    const first = mockProps;

    // A refresh delivering the same node/edge set (new payload identity) must
    // not hand the library new paint callbacks (repaint churn) or a new
    // graphData object (which would reheat the simulation and jitter).
    const refreshed = cloneGraph(GRAPH);
    refreshed.nodes[0].factCount = 5;
    await renderAsync(refreshed);

    expect(mockProps?.linkColor).toBe(first?.linkColor);
    expect(mockProps?.linkWidth).toBe(first?.linkWidth);
    expect(mockProps?.nodeCanvasObject).toBe(first?.nodeCanvasObject);
    expect(mockProps?.graphData).toBe(first?.graphData);

    // A changed node set must produce a new graphData object.
    const grown = cloneGraph(GRAPH);
    grown.nodes.push({
      id: 'c',
      canonicalName: 'Gamma',
      entityType: 'TOOL',
      factCount: 1,
      factIds: ['f3'],
    });
    await renderAsync(grown);
    expect(mockProps?.graphData).not.toBe(first?.graphData);
    expect(mockProps?.nodeCanvasObject).toBe(first?.nodeCanvasObject);
  });

  it('re-reads the tokens when the theme class changes after mount', async () => {
    setTertiaryToken('#94a3b8');
    render();

    expect(mockLinkColor).not.toBeNull();
    expect(mockLinkColor?.(GRAPH.edges[0])).toBe('rgba(148, 163, 184, 0.75)');

    // Mirrors a next-themes toggle: the tokens resolve to the new theme's
    // values and the class lands on <html>. Reading the palette during render
    // (or from an effect in this component) would sample the outgoing theme,
    // because next-themes applies the class from an effect in its provider and
    // React flushes passive effects child-first.
    await act(async () => {
      setTertiaryToken('#ffffff');
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });

    expect(mockLinkColor?.(GRAPH.edges[0])).toBe('rgba(255, 255, 255, 0.75)');
  });

  it('re-reads the tokens when the named theme attribute changes', async () => {
    setTertiaryToken('#94a3b8');
    render();

    expect(mockLinkColor?.(GRAPH.edges[0])).toBe('rgba(148, 163, 184, 0.75)');

    await act(async () => {
      setTertiaryToken('#000000');
      document.documentElement.setAttribute('data-theme', 'ocean');
      await Promise.resolve();
    });

    expect(mockLinkColor?.(GRAPH.edges[0])).toBe('rgba(0, 0, 0, 0.75)');
  });
});
