import {
  isUsableTerminalResizeCandidate,
  MIN_TERMINAL_RESIZE_COLS,
  MIN_TERMINAL_RESIZE_HEIGHT_PX,
  MIN_TERMINAL_RESIZE_ROWS,
  MIN_TERMINAL_RESIZE_WIDTH_PX,
  proposeUsableTerminalSize,
} from '../terminal-resize-guard';

describe('isUsableTerminalResizeCandidate', () => {
  it('accepts dimensions large enough to resize an attached PTY', () => {
    expect(
      isUsableTerminalResizeCandidate({
        hostWidthPx: MIN_TERMINAL_RESIZE_WIDTH_PX,
        hostHeightPx: MIN_TERMINAL_RESIZE_HEIGHT_PX,
        cols: MIN_TERMINAL_RESIZE_COLS,
        rows: MIN_TERMINAL_RESIZE_ROWS,
      }),
    ).toBe(true);
  });

  it('rejects transient tiny column counts', () => {
    expect(
      isUsableTerminalResizeCandidate({
        hostWidthPx: 900,
        hostHeightPx: 480,
        cols: 8,
        rows: 24,
      }),
    ).toBe(false);
  });

  it('rejects hidden or collapsing hosts', () => {
    expect(
      isUsableTerminalResizeCandidate({
        hostWidthPx: 0,
        hostHeightPx: 480,
        cols: 80,
        rows: 24,
      }),
    ).toBe(false);

    expect(
      isUsableTerminalResizeCandidate({
        hostWidthPx: 900,
        hostHeightPx: 12,
        cols: 80,
        rows: 1,
      }),
    ).toBe(false);
  });
});

describe('proposeUsableTerminalSize', () => {
  function host(
    width: number,
    height: number,
    isConnected = true,
  ): Parameters<typeof proposeUsableTerminalSize>[1] {
    return { isConnected, getBoundingClientRect: () => ({ width, height }) };
  }
  function fit(
    propose: () => { cols: number; rows: number } | undefined,
  ): Parameters<typeof proposeUsableTerminalSize>[0] {
    return { proposeDimensions: propose };
  }

  it("returns the fit's proposal for an attached host of usable size", () => {
    expect(
      proposeUsableTerminalSize(
        fit(() => ({ cols: 151, rows: 53 })),
        host(1200, 800),
      ),
    ).toEqual({ cols: 151, rows: 53 });
  });

  it('rejects a missing, detached, hidden or zero-size host', () => {
    const proposal = fit(() => ({ cols: 151, rows: 53 }));
    expect(proposeUsableTerminalSize(proposal, null)).toBeNull();
    expect(proposeUsableTerminalSize(proposal, undefined)).toBeNull();
    expect(proposeUsableTerminalSize(proposal, host(1200, 800, false))).toBe(
      null,
    );
    expect(proposeUsableTerminalSize(proposal, host(0, 0))).toBeNull();
    expect(proposeUsableTerminalSize(proposal, host(1200, 0))).toBeNull();
  });

  it('rejects a missing, non-finite, fractional or transient proposal', () => {
    const attached = host(1200, 800);
    for (const proposal of [
      undefined,
      { cols: Number.NaN, rows: 53 },
      { cols: 151, rows: Number.POSITIVE_INFINITY },
      { cols: 150.5, rows: 53 },
      { cols: 2, rows: 1 },
    ]) {
      expect(
        proposeUsableTerminalSize(
          fit(() => proposal),
          attached,
        ),
      ).toBe(null);
    }
  });

  it('rejects a fit that throws', () => {
    expect(
      proposeUsableTerminalSize(
        fit(() => {
          throw new Error('xterm is not open');
        }),
        host(1200, 800),
      ),
    ).toBeNull();
  });

  it('does not read the fit for a detached host', () => {
    const propose = jest.fn(() => ({ cols: 151, rows: 53 }));
    expect(
      proposeUsableTerminalSize(fit(propose), host(1200, 800, false)),
    ).toBeNull();
    expect(propose).not.toHaveBeenCalled();
  });
});
