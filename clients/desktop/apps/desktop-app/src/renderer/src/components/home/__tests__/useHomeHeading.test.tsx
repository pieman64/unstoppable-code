/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HOME_HEADINGS } from '../homeHeadings';
import { __resetHomeHeadingForTests, useHomeHeading } from '../useHomeHeading';

interface HookProbe {
  current: string | null;
}

/**
 * Tiny render harness that surfaces the hook's return value into a probe ref
 * since this repo does not depend on @testing-library/react's renderHook.
 */
function HookHarness({ probe }: { probe: HookProbe }): null {
  probe.current = useHomeHeading();
  return null;
}

/** Renders two independent `HookHarness` instances side by side. */
function TwoHookHarness({
  probeA,
  probeB,
}: {
  probeA: HookProbe;
  probeB: HookProbe;
}): JSX.Element {
  return (
    <>
      <HookHarness probe={probeA} />
      <HookHarness probe={probeB} />
    </>
  );
}

describe('useHomeHeading', () => {
  let container: HTMLDivElement;
  let root: Root;
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    __resetHomeHeadingForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    randomSpy.mockRestore();
    __resetHomeHeadingForTests();
  });

  it('returns a member of HOME_HEADINGS', () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.1);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    expect(probe.current).not.toBeNull();
    expect(HOME_HEADINGS).toContain(probe.current);
  });

  it('holds the same heading across rerenders of the same mount', () => {
    // First render picks index 0, but Math.random is only consulted once
    // (React's lazy useState initializer runs on mount only) — flip the
    // mock between renders to prove a rerender does NOT repick.
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    const firstHeading = probe.current;
    expect(firstHeading).toBe(HOME_HEADINGS[0]);

    randomSpy.mockReturnValue(0.9999999999);
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    expect(probe.current).toBe(firstHeading);
  });

  it('repicks on a fresh mount once every prior instance has unmounted', () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const probe: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    expect(probe.current).toBe(HOME_HEADINGS[0]);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    randomSpy.mockReturnValue(0.9999999999);
    act(() => {
      root.render(<HookHarness probe={probe} />);
    });
    expect(probe.current).toBe(HOME_HEADINGS[HOME_HEADINGS.length - 1]);
  });

  it('two overlapping instances mounted at the same time return the same phrase', () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const probeA: HookProbe = { current: null };
    const probeB: HookProbe = { current: null };
    act(() => {
      root.render(<TwoHookHarness probeA={probeA} probeB={probeB} />);
    });

    expect(probeA.current).toBe(HOME_HEADINGS[0]);
    expect(probeB.current).toBe(probeA.current);
  });

  it('hands the phrase to a keyed replacement instance across a same-commit unmount + mount', () => {
    // Pins the same-commit REPLACEMENT race the mount effect's
    // `heldHeading = heading` re-assertion exists to guard. (This is NOT the
    // Code <-> New Task repro — that flow never unmounts either instance and
    // is covered by the Electron spec in code-tab-empty-state.spec.mjs.)
    // Swapping `key="a"` for `key="b"` inside a stable fragment forces React
    // to unmount A and mount B within ONE commit. B's lazy initializer runs
    // during render, while A is still mounted and the held phrase is set —
    // but React flushes passive UNMOUNT effects for deleted fibers before
    // passive MOUNT effects, so A's cleanup (count 1 -> 0, hold nulled) runs
    // before B's mount effect. Without the re-assertion, B would keep
    // showing A's phrase but leave the module-level hold permanently null.
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const probeA: HookProbe = { current: null };
    act(() => {
      root.render(
        <>
          <HookHarness key="a" probe={probeA} />
        </>,
      );
    });
    expect(probeA.current).toBe(HOME_HEADINGS[0]);
    const heldHeading = probeA.current;

    // A different mock value proves the replacement does NOT repick — it
    // must pick up the already-held heading instead of consulting
    // Math.random again.
    randomSpy.mockReturnValue(0.9999999999);
    const probeB: HookProbe = { current: null };
    act(() => {
      root.render(
        <>
          <HookHarness key="b" probe={probeB} />
        </>,
      );
    });
    expect(probeB.current).toBe(heldHeading);

    // Load-bearing assertion for the re-assertion line: a THIRD instance
    // mounted while B is still alive must converge on the same held phrase.
    // If B's mount effect had not re-asserted the hold after A's cleanup
    // nulled it, this fresh initializer would find `heldHeading === null`,
    // consult Math.random, and diverge from B.
    const probeC: HookProbe = { current: null };
    act(() => {
      root.render(
        <>
          <HookHarness key="b" probe={probeB} />
          <HookHarness key="c" probe={probeC} />
        </>,
      );
    });
    expect(probeC.current).toBe(heldHeading);
    expect(probeB.current).toBe(heldHeading);
  });

  it('repicks only after ALL instances have unmounted', () => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
    const probeA: HookProbe = { current: null };
    const probeB: HookProbe = { current: null };
    act(() => {
      root.render(<TwoHookHarness probeA={probeA} probeB={probeB} />);
    });
    const heldHeading = probeA.current;
    expect(heldHeading).toBe(HOME_HEADINGS[0]);

    // Unmount everything.
    act(() => {
      root.unmount();
    });

    root = createRoot(container);
    randomSpy.mockReturnValue(0.9999999999);
    const probeFresh: HookProbe = { current: null };
    act(() => {
      root.render(<HookHarness probe={probeFresh} />);
    });
    expect(probeFresh.current).toBe(HOME_HEADINGS[HOME_HEADINGS.length - 1]);
    expect(probeFresh.current).not.toBe(heldHeading);
  });
});
