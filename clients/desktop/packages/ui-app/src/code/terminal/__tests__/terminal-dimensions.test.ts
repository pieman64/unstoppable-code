/** @jest-environment jsdom */
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { measureTerminalDimensions } from '../terminal-dimensions';
import {
  createTerminalHostContainer,
  TERMINAL_GEOMETRY_OPTIONS,
} from '../terminal-geometry';

// Real xterm geometry needs a real browser (the cloud e2e covers it). These
// tests pin how the probe is built and that it is always torn down.
interface ProbeTerminal {
  options: unknown;
  parent: HTMLElement | null;
  disposed: boolean;
}
const probes: ProbeTerminal[] = [];
let propose: () => { cols: number; rows: number } | undefined = () => ({
  cols: 151,
  rows: 53,
});
let openError: Error | null = null;

jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn((options: unknown) => {
    const probe: ProbeTerminal = { options, parent: null, disposed: false };
    probes.push(probe);
    return {
      loadAddon: (): void => undefined,
      open: (parent: HTMLElement): void => {
        if (openError) throw openError;
        probe.parent = parent;
      },
      dispose: (): void => {
        probe.disposed = true;
      },
    };
  }),
}));
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn(() => ({
    proposeDimensions: (): { cols: number; rows: number } | undefined =>
      propose(),
  })),
}));

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    x: 0,
    y: 0,
    toJSON: (): Record<string, never> => ({}),
  };
}

describe('createTerminalHostContainer', () => {
  it('creates the xterm host already blocked from session replay', () => {
    // Every TerminalPane host comes from here (via `terminal-instances`), and
    // xterm renders terminal text as DOM inside it. The class is set before
    // the host is attached, so a recorder never sees it unblocked.
    const host = createTerminalHostContainer(document);
    expect(host.isConnected).toBe(false);
    expect(host.className).toBe(
      `${REPLAY_BLOCK_CLASS} canopy-terminal-host h-full w-full`,
    );
    expect(host.style.height).toBe('100%');
    expect(host.style.width).toBe('100%');
  });
});

describe('measureTerminalDimensions', () => {
  let area: HTMLDivElement;
  let bounds: jest.SpyInstance<DOMRect, []>;

  beforeEach(() => {
    probes.length = 0;
    propose = (): { cols: number; rows: number } => ({ cols: 151, rows: 53 });
    openError = null;
    area = document.createElement('div');
    document.body.append(area);
    bounds = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect(1200, 817));
  });

  afterEach(() => {
    bounds.mockRestore();
    area.remove();
  });

  it("returns the proposal of an xterm with the pane's geometry opened over the area", () => {
    const seen: { layer: HTMLElement | null; area: HTMLElement | null } = {
      layer: null,
      area: null,
    };
    propose = (): { cols: number; rows: number } => {
      seen.layer = probes[0]?.parent?.parentElement ?? null;
      seen.area = seen.layer?.parentElement ?? null;
      return { cols: 151, rows: 53 };
    };

    expect(measureTerminalDimensions(area)).toEqual({ cols: 151, rows: 53 });
    expect(probes).toHaveLength(1);
    expect(probes[0]?.options).toEqual(TERMINAL_GEOMETRY_OPTIONS);
    // The xterm opens in a pane-style host inside a hidden, full-size layer
    // of the area, so it measures the space the pane will fill.
    expect(probes[0]?.parent?.className).toBe(
      `${REPLAY_BLOCK_CLASS} canopy-terminal-host h-full w-full`,
    );
    expect(seen.area).toBe(area);
    expect(seen.layer?.style.position).toBe('absolute');
    expect(seen.layer?.style.visibility).toBe('hidden');
  });

  it('disposes the probe and removes its layer after measuring', () => {
    measureTerminalDimensions(area);
    expect(probes[0]?.disposed).toBe(true);
    expect(area.childElementCount).toBe(0);
  });

  it('disposes the probe and returns null when xterm cannot open', () => {
    openError = new Error('no renderer');
    expect(measureTerminalDimensions(area)).toBeNull();
    expect(probes[0]?.disposed).toBe(true);
    expect(area.childElementCount).toBe(0);
  });

  it('returns null for a hidden or too small area', () => {
    bounds.mockReturnValue(rect(0, 0));
    propose = (): { cols: number; rows: number } => ({ cols: 2, rows: 1 });
    expect(measureTerminalDimensions(area)).toBeNull();
    expect(probes[0]?.disposed).toBe(true);
    expect(area.childElementCount).toBe(0);
  });

  it('measures afresh each time rather than reusing an earlier cell size', () => {
    expect(measureTerminalDimensions(area)).toEqual({ cols: 151, rows: 53 });
    propose = (): { cols: number; rows: number } => ({ cols: 75, rows: 26 });
    expect(measureTerminalDimensions(area)).toEqual({ cols: 75, rows: 26 });
    expect(probes).toHaveLength(2);
  });
});
