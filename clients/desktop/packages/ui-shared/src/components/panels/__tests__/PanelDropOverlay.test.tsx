/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  computeDropTarget,
  type DropDirection,
} from '../../../panels/drop-geometry';
import {
  PANEL_DROP_ZONE_EDGES,
  PanelDropOverlay,
  type PanelDropZoneEdge,
} from '../PanelDropOverlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function queryByTestId(scope: ParentNode, testId: string): HTMLElement | null {
  const element = scope.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

function getByTestId(scope: ParentNode, testId: string): HTMLElement {
  const element = queryByTestId(scope, testId);

  if (!element) {
    throw new Error(`Expected element with data-testid ${testId}`);
  }

  return element;
}

describe('PanelDropOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const directionalCases: Array<{
    direction: DropDirection;
    box: { top: string; left: string; width: string; height: string };
  }> = [
    {
      direction: 'up',
      box: { top: '0%', left: '0%', width: '100%', height: '50%' },
    },
    {
      direction: 'down',
      box: { top: '50%', left: '0%', width: '100%', height: '50%' },
    },
    {
      direction: 'left',
      box: { top: '0%', left: '0%', width: '50%', height: '100%' },
    },
    {
      direction: 'right',
      box: { top: '0%', left: '50%', width: '50%', height: '100%' },
    },
    {
      direction: 'center',
      box: { top: '0%', left: '0%', width: '100%', height: '100%' },
    },
  ];

  it.each(directionalCases)(
    'renders the $direction overlay box computed by computeDropTarget',
    ({ direction, box }) => {
      // Drive the display component the way the DnD wiring will: from a
      // computeDropTarget result (assert the round trip stays coherent).
      const pointerByDirection: Record<
        DropDirection,
        { x: number; y: number }
      > = {
        up: { x: 100, y: 5 },
        down: { x: 100, y: 95 },
        left: { x: 5, y: 50 },
        right: { x: 195, y: 50 },
        center: { x: 100, y: 50 },
      };
      const result = computeDropTarget(
        { width: 200, height: 100 },
        pointerByDirection[direction],
      );
      expect(result.direction).toBe(direction);

      const { container, root } = render(
        <PanelDropOverlay
          groupId="g1"
          direction={result.direction}
          overlayBox={result.overlayBox}
          visible={true}
        />,
      );

      try {
        const overlay = getByTestId(container, 'panel-drop-overlay-g1');
        expect(overlay.getAttribute('data-direction')).toBe(direction);

        const boxElement = overlay.querySelector(
          '.canopy-panel-drop-overlay-box',
        );

        if (!(boxElement instanceof HTMLElement)) {
          throw new Error('Expected the overlay box element');
        }

        expect(boxElement.style.top).toBe(box.top);
        expect(boxElement.style.left).toBe(box.left);
        expect(boxElement.style.width).toBe(box.width);
        expect(boxElement.style.height).toBe(box.height);
      } finally {
        act(() => {
          root.unmount();
        });
      }
    },
  );

  it('renders nothing when not visible', () => {
    const { container, root } = render(
      <PanelDropOverlay
        groupId="g1"
        direction="center"
        overlayBox={{ top: 0, left: 0, width: 1, height: 1 }}
        visible={false}
      />,
    );

    try {
      expect(queryByTestId(container, 'panel-drop-overlay-g1')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('omits the box (but keeps the container) for a null direction', () => {
    const { container, root } = render(
      <PanelDropOverlay
        groupId="g1"
        direction={null}
        overlayBox={null}
        visible={true}
      />,
    );

    try {
      const overlay = getByTestId(container, 'panel-drop-overlay-g1');
      expect(overlay.hasAttribute('data-direction')).toBe(false);
      expect(
        overlay.querySelector('.canopy-panel-drop-overlay-box'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the five hit zones only in showZones mode, with edge centers that classify to their direction', () => {
    const withoutZones = render(
      <PanelDropOverlay
        groupId="g1"
        direction={null}
        overlayBox={null}
        visible={true}
      />,
    );

    try {
      for (const edge of PANEL_DROP_ZONE_EDGES) {
        expect(
          queryByTestId(withoutZones.container, `panel-drop-zone-g1-${edge}`),
        ).toBeNull();
      }
    } finally {
      act(() => {
        withoutZones.root.unmount();
      });
    }

    const withZones = render(
      <PanelDropOverlay
        groupId="g1"
        direction={null}
        overlayBox={null}
        visible={true}
        showZones={true}
      />,
    );

    try {
      // Zone centers (as fractions of the CSS geometry: 10% edge strips
      // around an 80% center region) must classify to the zone's direction
      // through the same math the DnD wiring uses.
      const zoneCenters: Record<
        PanelDropZoneEdge,
        { x: number; y: number; direction: DropDirection }
      > = {
        top: { x: 0.5, y: 0.05, direction: 'up' },
        bottom: { x: 0.5, y: 0.95, direction: 'down' },
        left: { x: 0.05, y: 0.5, direction: 'left' },
        right: { x: 0.95, y: 0.5, direction: 'right' },
        center: { x: 0.5, y: 0.5, direction: 'center' },
      };

      for (const edge of PANEL_DROP_ZONE_EDGES) {
        const zone = getByTestId(
          withZones.container,
          `panel-drop-zone-g1-${edge}`,
        );
        expect(zone.getAttribute('data-edge')).toBe(edge);

        const center = zoneCenters[edge];
        expect(
          computeDropTarget(
            { width: 400, height: 300 },
            { x: center.x * 400, y: center.y * 300 },
          ).direction,
        ).toBe(center.direction);
      }
    } finally {
      act(() => {
        withZones.root.unmount();
      });
    }
  });
});
