'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d';
import type {
  ExplorerEntityGraph,
  ExplorerGraphNode,
} from '@canopy/protocol/settings/organization-memory';
import {
  INACTIVE_HOVER,
  buildLinkHoverState,
  buildNodeHoverState,
  buildRetrievalPaintState,
  mergeEntityGraphData,
  type EntityGraphLinkDatum,
  type EntityGraphSimData,
  type HoverHighlightState,
  type RetrievalHighlight,
  type RetrievalPaintState,
} from './graph-helpers';

interface EntityForceGraphProps {
  graph: ExplorerEntityGraph;
  onSelectNode: (node: ExplorerGraphNode) => void;
  onSelectEdge: (
    sourceName: string,
    targetName: string,
    factIds: string[],
  ) => void;
  // Retrieval spotlight: entities of injected facts get a strong ring, near-
  // miss candidate entities a dashed ring, everything else dims slightly.
  highlight?: RetrievalHighlight | null;
}

type GraphNode = NodeObject<ExplorerGraphNode>;
type GraphLink = LinkObject<ExplorerGraphNode, EntityGraphLinkDatum>;

// Labels drawn while nothing is hovered: the selected node plus this many of
// the highest-fact-count nodes. Hovering reveals labels for the neighborhood.
const IDLE_LABEL_COUNT = 12;

// Ticks before the simulation stops and the initial zoom-to-fit runs. Bounding
// this (instead of the library's 15s cooldown) keeps the settling jitter — and
// the hover churn it causes while nodes drift under the cursor — short.
const SIMULATION_COOLDOWN_TICKS = 200;

// The default tooltip is disabled (labels are drawn on canvas instead). Kept as
// a module constant so re-renders don't hand the graph a new accessor.
const NO_TOOLTIP = (): string => '';

interface GraphPalette {
  service: string;
  code: string;
  tool: string;
  label: string;
  link: string;
  linkFaded: string;
}

function cssColor(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

// Canvas fill styles cannot resolve `var(...)`, so the theme tokens the SVG
// version used are resolved to concrete colors for the active theme. Normalizing
// through a scratch canvas yields `#rrggbb` for opaque colors, `rgba(...)` for
// translucent ones, and `color(<space> ... / a)` inside display-p3 blocks.
function normalizeColor(value: string): string {
  const scratch = document.createElement('canvas');
  const context = scratch.getContext('2d');
  if (context === null) {
    return value;
  }
  context.fillStyle = value;
  return typeof context.fillStyle === 'string' ? context.fillStyle : value;
}

function scaleAlpha(existing: string | undefined, factor: number): number {
  if (existing === undefined) {
    return factor;
  }
  const trimmed = existing.trim();
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed)) {
    return factor;
  }
  return (trimmed.endsWith('%') ? parsed / 100 : parsed) * factor;
}

// Scales whatever alpha a normalized color already carries rather than only
// handling `#rrggbb`. A translucent token would otherwise fail the hex guard,
// collapse the highlighted and faded link variants into one color, and silently
// turn the neighbor de-emphasis into a no-op.
function withAlpha(color: string, alpha: number): string | null {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const red = parseInt(color.slice(1, 3), 16);
    const green = parseInt(color.slice(3, 5), 16);
    const blue = parseInt(color.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb !== null) {
    const [red, green, blue, existingAlpha] = rgb[1]
      .split(/[\s,/]+/)
      .filter((part) => part.length > 0);
    if (red === undefined || green === undefined || blue === undefined) {
      return null;
    }
    return `rgba(${red}, ${green}, ${blue}, ${scaleAlpha(existingAlpha, alpha)})`;
  }
  const colorFn = /^color\(([^)]+)\)$/i.exec(color);
  if (colorFn !== null) {
    const [channels, existingAlpha] = colorFn[1].split('/');
    if (channels !== undefined && channels.trim().length > 0) {
      return `color(${channels.trim()} / ${scaleAlpha(existingAlpha, alpha)})`;
    }
  }
  return null;
}

function readGraphPalette(): GraphPalette {
  const styles = getComputedStyle(document.documentElement);
  // `--line-base` sits at ~8-14% alpha in every
  // theme — too little headroom for the 0.75/0.12 highlight split to read, and
  // nearly invisible on its own. Links derive from the opaque body token instead.
  const link = normalizeColor(cssColor(styles, '--fg-tertiary', '#94a3b8'));
  return {
    service: cssColor(styles, '--bg-accent', '#6366f1'),
    code: cssColor(styles, '--bg-success', '#22c55e'),
    tool: cssColor(styles, '--bg-warning', '#f59e0b'),
    label: cssColor(styles, '--fg-primary', '#171717'),
    link: withAlpha(link, 0.75) ?? link,
    linkFaded: withAlpha(link, 0.12) ?? link,
  };
}

// A theme class toggling for unrelated reasons (e.g. a modal adding a class to
// <html>) must not force a full canvas repaint when the tokens are unchanged.
function samePalette(left: GraphPalette, right: GraphPalette): boolean {
  return (
    left.service === right.service &&
    left.code === right.code &&
    left.tool === right.tool &&
    left.label === right.label &&
    left.link === right.link &&
    left.linkFaded === right.linkFaded
  );
}

function nodeRadius(factCount: number): number {
  return 4 + Math.min(9, Math.sqrt(factCount) * 1.5);
}

function endpointId(endpoint: GraphLink['source']): string | null {
  if (typeof endpoint === 'string') {
    return endpoint;
  }
  if (typeof endpoint === 'number') {
    return String(endpoint);
  }
  if (endpoint !== undefined && typeof endpoint.id === 'string') {
    return endpoint.id;
  }
  return null;
}

interface CanvasSize {
  width: number;
  height: number;
}

interface FontCache {
  scale: number;
  font: string;
}

function EntityForceGraphInner({
  graph,
  onSelectNode,
  onSelectEdge,
  highlight = null,
}: EntityForceGraphProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(
    undefined,
  );
  const didInitialFitRef = useRef(false);
  const didConfigureForcesRef = useRef(false);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  // Everything the canvas paint callbacks read lives in refs: pointer hover
  // toggles constantly (wide link hit areas), and routing it through React
  // state used to rebuild every paint callback identity per move, forcing the
  // library to re-diff props and repaint via state churn. The callbacks below
  // are created exactly once and repaints are requested explicitly.
  const hoverRef = useRef<HoverHighlightState>(INACTIVE_HOVER);
  const retrievalRef = useRef<RetrievalPaintState | null>(null);
  const selectedNodeIdRef = useRef<string | null>(null);
  const selectedLinkKeyRef = useRef<string | null>(null);
  const neighborIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const idleLabelIdsRef = useRef<ReadonlySet<string>>(new Set());
  const nodeNameByIdRef = useRef<Map<string, string>>(new Map());
  const fontCacheRef = useRef<FontCache>({ scale: 0, font: '' });

  // The tokens have to be sampled from `<html>` *after* the theme lands on it.
  // next-themes applies the class from an effect in its provider, and React
  // flushes passive effects child-first, so both a render-phase read and an
  // effect here keyed on `resolvedTheme` would still observe the outgoing
  // theme. Watching the attribute itself runs after the swap either way, and
  // also covers `data-theme` — the generated token sheet redefines these
  // variables per named theme, which `resolvedTheme` does not track.
  const paletteRef = useRef<GraphPalette | null>(null);
  if (paletteRef.current === null) {
    paletteRef.current = readGraphPalette();
  }

  // With autoPauseRedraw (the default) force-graph only repaints while the
  // engine runs or when a styling prop changes; hover/selection/highlight live
  // in refs precisely so no prop changes. Setting the zoom to its current
  // value is the lightest public API that marks the canvas dirty for exactly
  // one frame without moving the camera or touching the simulation.
  const requestRepaint = useCallback((): void => {
    const forceGraph = graphRef.current;
    if (forceGraph === undefined) {
      return;
    }
    const zoom = forceGraph.zoom();
    if (typeof zoom === 'number') {
      forceGraph.zoom(zoom);
    }
  }, []);

  // force-graph mutates node/link objects (positions, resolved endpoints), so
  // it gets its own copies. The merge preserves object identities: refreshes
  // with an unchanged node/edge set update the SAME graphData object in place
  // (no prop change, no simulation reheat, zero flicker — React bails out of
  // the redundant setData), while set changes carry the previous x/y/vx/vy
  // (and fx/fy pins) onto the new node objects so existing nodes stay in place
  // and only new nodes get laid out by the library's reheat.
  const [data, setData] = useState<EntityGraphSimData>(
    () => mergeEntityGraphData(null, graph).data,
  );
  // Mirror for the merge effect and event handlers (engine-stop fit) so they
  // read the latest sim data without re-subscribing per data change.
  const dataRef = useRef<EntityGraphSimData>(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    // The microtask hop keeps the setState off the synchronous effect path
    // (mirrors the data-loading effects elsewhere in this feature).
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const { data: merged, reused } = mergeEntityGraphData(
        dataRef.current,
        graph,
      );
      if (!reused) {
        setData(merged);
        return;
      }
      // Same-set refresh: fields may have changed (factCount radii, names)
      // without a graphData identity change, so paint one frame explicitly.
      requestRepaint();
    });
    return (): void => {
      cancelled = true;
    };
  }, [graph, requestRepaint]);

  const previousNodeCountRef = useRef(0);
  useEffect(() => {
    const neighborIds = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      const forward = neighborIds.get(edge.source) ?? new Set<string>();
      forward.add(edge.target);
      neighborIds.set(edge.source, forward);
      const backward = neighborIds.get(edge.target) ?? new Set<string>();
      backward.add(edge.source);
      neighborIds.set(edge.target, backward);
    }
    neighborIdsRef.current = neighborIds;
    nodeNameByIdRef.current = new Map(
      graph.nodes.map((node) => [node.id, node.canonicalName]),
    );
    const ranked = [...graph.nodes].sort(
      (left, right) => right.factCount - left.factCount,
    );
    idleLabelIdsRef.current = new Set(
      ranked.slice(0, IDLE_LABEL_COUNT).map((node) => node.id),
    );
    // Refit only when the graph appears for the first time (empty → nonempty
    // after an over-narrow filter); ordinary refreshes and filter tweaks keep
    // the user's pan/zoom untouched.
    if (previousNodeCountRef.current === 0 && graph.nodes.length > 0) {
      didInitialFitRef.current = false;
    }
    previousNodeCountRef.current = graph.nodes.length;
  }, [graph]);

  useEffect(() => {
    const observer = new MutationObserver((): void => {
      const next = readGraphPalette();
      const current = paletteRef.current;
      if (current !== null && samePalette(current, next)) {
        // Any class toggle on <html> lands here; skip the repaint when the
        // resolved token values are unchanged.
        return;
      }
      paletteRef.current = next;
      requestRepaint();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return (): void => {
      observer.disconnect();
    };
  }, [requestRepaint]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    // Rounding and bailing on no-change matters: every width/height change
    // resizes (and clears) the canvas, so subpixel ResizeObserver churn —
    // e.g. a scrollbar appearing when the facts panel fills — reads as
    // flicker if passed through raw.
    const applySize = (nextWidth: number, nextHeight: number): void => {
      const width = Math.round(nextWidth);
      const height = Math.round(nextHeight);
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        applySize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(container);
    applySize(container.clientWidth, container.clientHeight);
    return (): void => observer.disconnect();
  }, []);

  const hasCanvas = size.width > 0 && size.height > 0;

  // Spread the default d3 layout out enough for the sized nodes; the default
  // link distance/charge pack a few hundred nodes too tightly to read. This
  // must land before the first simulation tick (the graph mounts in the same
  // commit `hasCanvas` flips true, and ticks run in rAF after this layout
  // effect), and exactly once — the d3 force instances persist across data
  // updates, so re-applying per data/size change only re-initialized forces
  // and made the layout visibly re-spread.
  useLayoutEffect(() => {
    if (!hasCanvas || didConfigureForcesRef.current) {
      return;
    }
    const forceGraph = graphRef.current;
    if (forceGraph === undefined) {
      return;
    }
    didConfigureForcesRef.current = true;
    // d3 force accessors are untyped; call them only when present.
    const linkForce = forceGraph.d3Force('link');
    const distance: unknown = linkForce?.distance;
    if (typeof distance === 'function') {
      Reflect.apply(distance, linkForce, [70]);
    }
    const chargeForce = forceGraph.d3Force('charge');
    const strength: unknown = chargeForce?.strength;
    if (typeof strength === 'function') {
      Reflect.apply(strength, chargeForce, [-120]);
    }
  }, [hasCanvas]);

  // Retrieval highlight changes are rare; they update the paint refs, repaint,
  // and fly the camera to the highlighted node set when any of it is visible.
  useEffect(() => {
    retrievalRef.current =
      highlight === null ? null : buildRetrievalPaintState(highlight);
    requestRepaint();
    if (highlight === null) {
      return;
    }
    const forceGraph = graphRef.current;
    const nodes = data.nodes;
    const isHighlighted = (id: string): boolean =>
      highlight.injectedIds.has(id) || highlight.candidateIds.has(id);
    if (
      forceGraph !== undefined &&
      nodes.some((node) => isHighlighted(node.id))
    ) {
      forceGraph.zoomToFit(400, 60, (node) =>
        typeof node.id === 'string' ? isHighlighted(node.id) : false,
      );
    }
  }, [highlight, data, requestRepaint]);

  // --- Stable paint callbacks (created once; read refs only) ---

  const drawNode = useCallback(
    (node: GraphNode, context: CanvasRenderingContext2D, scale: number) => {
      if (typeof node.x !== 'number' || typeof node.y !== 'number') {
        return;
      }
      const palette = paletteRef.current ?? readGraphPalette();
      const hover = hoverRef.current;
      const retrieval = retrievalRef.current;
      const selectedNodeId = selectedNodeIdRef.current;
      const radius = nodeRadius(node.factCount);
      const hoverFaded = hover.dim && !hover.nodeIds.has(node.id);
      const injected = retrieval !== null && retrieval.injectedIds.has(node.id);
      const candidate =
        retrieval !== null && retrieval.candidateIds.has(node.id);
      let alpha = 0.9;
      if (hoverFaded) {
        alpha = 0.15;
      } else if (retrieval !== null && !injected && !candidate) {
        // Retrieval spotlight active: everything unrelated recedes slightly.
        alpha = 0.35;
      }
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      context.fillStyle =
        node.entityType === 'SERVICE'
          ? palette.service
          : node.entityType === 'CODE'
            ? palette.code
            : palette.tool;
      context.fill();
      if (!hoverFaded && (injected || candidate)) {
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(node.x, node.y, radius + 3 / scale + 1.5, 0, 2 * Math.PI);
        context.lineWidth = (injected ? 2.5 : 1.5) / scale;
        if (candidate) {
          context.setLineDash([4 / scale, 3 / scale]);
        }
        context.strokeStyle = palette.label;
        context.stroke();
        context.setLineDash([]);
      }
      if (node.id === selectedNodeId) {
        context.globalAlpha = hoverFaded ? 0.15 : 1;
        context.beginPath();
        context.arc(node.x, node.y, radius, 0, 2 * Math.PI);
        context.lineWidth = 2 / scale;
        context.strokeStyle = palette.label;
        context.stroke();
      }
      const showLabel = hover.active
        ? hover.labelIds.has(node.id) ||
          (!hover.dim &&
            (node.id === selectedNodeId ||
              idleLabelIdsRef.current.has(node.id)))
        : retrieval !== null
          ? retrieval.labelIds.has(node.id) || node.id === selectedNodeId
          : node.id === selectedNodeId || idleLabelIdsRef.current.has(node.id);
      if (showLabel) {
        context.globalAlpha = hoverFaded ? 0.15 : 1;
        const fontCache = fontCacheRef.current;
        if (fontCache.scale !== scale) {
          // The font string only depends on the zoom scale; rebuilding it per
          // node per frame showed up as avoidable string churn.
          fontCache.scale = scale;
          fontCache.font = `500 ${Math.max(12 / scale, 2.5)}px sans-serif`;
        }
        context.font = fontCache.font;
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.fillStyle = palette.label;
        context.fillText(node.canonicalName, node.x + radius + 2, node.y);
      }
      context.globalAlpha = 1;
    },
    [],
  );

  const paintNodePointerArea = useCallback(
    (
      node: GraphNode,
      paintColor: string,
      context: CanvasRenderingContext2D,
    ) => {
      if (typeof node.x !== 'number' || typeof node.y !== 'number') {
        return;
      }
      context.fillStyle = paintColor;
      context.beginPath();
      context.arc(
        node.x,
        node.y,
        nodeRadius(node.factCount) + 3,
        0,
        2 * Math.PI,
      );
      context.fill();
    },
    [],
  );

  const linkColor = useCallback((link: GraphLink): string => {
    const palette = paletteRef.current ?? readGraphPalette();
    const hover = hoverRef.current;
    if (hover.dim) {
      return hover.linkKeys.has(link.key) ? palette.link : palette.linkFaded;
    }
    if (retrievalRef.current !== null) {
      // Node spotlight mode: links recede so the highlighted entities read.
      return palette.linkFaded;
    }
    return palette.link;
  }, []);

  const linkWidth = useCallback((link: GraphLink): number => {
    const base = Math.min(5, 1 + link.weight);
    const hover = hoverRef.current;
    if (hover.active && hover.linkKeys.has(link.key)) {
      return base + 1.5;
    }
    return link.key === selectedLinkKeyRef.current ? base + 1.5 : base;
  }, []);

  // --- Interaction handlers (stable; write refs, then request one repaint) ---

  const handleNodeHover = useCallback(
    (node: GraphNode | null) => {
      hoverRef.current =
        node !== null && typeof node.id === 'string'
          ? buildNodeHoverState(node.id, neighborIdsRef.current.get(node.id))
          : INACTIVE_HOVER;
      requestRepaint();
    },
    [requestRepaint],
  );

  const handleLinkHover = useCallback(
    (link: GraphLink | null) => {
      hoverRef.current =
        link === null ? INACTIVE_HOVER : buildLinkHoverState(link.key);
      requestRepaint();
    },
    [requestRepaint],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (typeof node.id !== 'string') {
        return;
      }
      selectedNodeIdRef.current = node.id;
      selectedLinkKeyRef.current = null;
      requestRepaint();
      onSelectNode({
        id: node.id,
        canonicalName: node.canonicalName,
        entityType: node.entityType,
        factCount: node.factCount,
        factIds: node.factIds,
      });
    },
    [onSelectNode, requestRepaint],
  );

  const handleLinkClick = useCallback(
    (link: GraphLink) => {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      if (sourceId === null || targetId === null) {
        return;
      }
      selectedLinkKeyRef.current = link.key;
      selectedNodeIdRef.current = null;
      requestRepaint();
      const names = nodeNameByIdRef.current;
      onSelectEdge(
        names.get(sourceId) ?? 'Entity',
        names.get(targetId) ?? 'Entity',
        link.factIds,
      );
    },
    [onSelectEdge, requestRepaint],
  );

  const handleNodeDragEnd = useCallback((node: GraphNode) => {
    // force-graph pins the node (fx/fy) while dragging; release it on drop so
    // the reheated simulation settles the neighborhood naturally.
    node.fx = undefined;
    node.fy = undefined;
  }, []);

  const handleEngineStop = useCallback(() => {
    // Fit exactly once per mount (or once more after an empty → nonempty
    // transition); refreshes and filter changes preserve the user's camera.
    if (didInitialFitRef.current) {
      return;
    }
    didInitialFitRef.current = true;
    if (dataRef.current.nodes.length > 0) {
      graphRef.current?.zoomToFit(400, 40);
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      role="img"
      aria-label="Organization memory entity graph"
    >
      {hasCanvas && (
        <ForceGraph2D<ExplorerGraphNode, EntityGraphLinkDatum>
          ref={graphRef}
          graphData={data}
          width={size.width}
          height={size.height}
          cooldownTicks={SIMULATION_COOLDOWN_TICKS}
          nodeLabel={NO_TOOLTIP}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={paintNodePointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkHoverPrecision={4}
          onNodeHover={handleNodeHover}
          onLinkHover={handleLinkHover}
          onNodeClick={handleNodeClick}
          onLinkClick={handleLinkClick}
          onNodeDragEnd={handleNodeDragEnd}
          onEngineStop={handleEngineStop}
        />
      )}
    </div>
  );
}

// Memoized so parent re-renders (selection fact loads, retrieval panel state)
// with unchanged props cost nothing.
export const EntityForceGraph = memo(EntityForceGraphInner);
