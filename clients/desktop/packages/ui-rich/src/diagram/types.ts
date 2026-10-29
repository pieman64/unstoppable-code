import type { ReactNode } from 'react';

/**
 * One positioned card on the diagram canvas. The caller owns layout: `x` and
 * `y` are the card's top-left corner in layout units (pixels at zoom 1). The
 * canvas adds no chrome around `content`.
 */
export interface DiagramCanvasNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly content: ReactNode;
  readonly selected?: boolean;
  readonly ariaLabel?: string;
  readonly testId?: string;
}

/** A left-to-right connection from `source`'s right edge to `target`'s left edge. */
export interface DiagramCanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly dashed?: boolean;
  /** Short caption drawn on the edge, such as the hidden parents it skips. */
  readonly label?: string;
}

export interface DiagramCanvasViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface DiagramCanvasProps {
  readonly nodes: readonly DiagramCanvasNode[];
  readonly edges: readonly DiagramCanvasEdge[];
  readonly ariaLabel: string;
  /** Smallest zoom the fit and the zoom controls may reach. Defaults to 0.25. */
  readonly minZoom?: number;
  /** The view refits whenever this value changes. */
  readonly fitViewKey?: string | number;
  readonly onNodeClick?: (id: string) => void;
  readonly onNodeDoubleClick?: (id: string) => void;
  readonly onPaneClick?: () => void;
  /** Reports the canvas viewport's size on mount and whenever it changes. */
  readonly onViewportSize?: (size: DiagramCanvasViewportSize) => void;
  readonly testId?: string;
}
