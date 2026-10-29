import { runInNewContext } from 'node:vm';
import {
  APP_ADVISOR_FLOATING_SIZE_LIMITS,
  clampAppAdvisorFloatingSize,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_FLOATING_MARGIN,
  appAdvisorPaintProbe,
  floatingAppAdvisorBounds,
  resolveAppAdvisorWindowLayout,
  shouldRemakeAppAdvisorWindow,
  appAdvisorCloseLeavesBubble,
  appAdvisorLayoutAfterFloatingShow,
  appAdvisorRequestedLayout,
} from '../floating-layout';

describe('App Advisor window layout', () => {
  it('stays the full window without early access, whatever is asked', () => {
    for (const requested of [undefined, 'floating', 'full'] as const) {
      expect(
        resolveAppAdvisorWindowLayout({
          requested,
          current: 'floating',
          visible: true,
          earlyAccess: false,
        }),
      ).toBe('full');
    }
  });

  it('opens floating from hidden under early access', () => {
    expect(
      resolveAppAdvisorWindowLayout({
        requested: undefined,
        current: 'full',
        visible: false,
        earlyAccess: true,
      }),
    ).toBe('floating');
  });

  it('keeps the layout of a visible window when none is asked for', () => {
    expect(
      resolveAppAdvisorWindowLayout({
        requested: undefined,
        current: 'full',
        visible: true,
        earlyAccess: true,
      }),
    ).toBe('full');
  });

  it('switches to the asked layout (Expand asks for full)', () => {
    expect(
      resolveAppAdvisorWindowLayout({
        requested: 'full',
        current: 'floating',
        visible: true,
        earlyAccess: true,
      }),
    ).toBe('full');
  });
});

describe('remaking the App Advisor window for the early access switch', () => {
  const idleHidden = {
    visible: false,
    turnsActive: false,
    unsentDraft: false,
  } as const;

  it('remakes a hidden, idle window made in the other mode, either way', () => {
    // Turned on since the window was made without early access.
    expect(
      shouldRemakeAppAdvisorWindow({
        ...idleHidden,
        hostsView: false,
        earlyAccess: true,
      }),
    ).toBe(true);
    // Turned off since the window was made with early access.
    expect(
      shouldRemakeAppAdvisorWindow({
        ...idleHidden,
        hostsView: true,
        earlyAccess: false,
      }),
    ).toBe(true);
  });

  it('keeps a window made in the current mode', () => {
    for (const earlyAccess of [true, false]) {
      expect(
        shouldRemakeAppAdvisorWindow({
          ...idleHidden,
          hostsView: earlyAccess,
          earlyAccess,
        }),
      ).toBe(false);
    }
  });

  it('keeps a window holding an unsent draft, which a remake would lose', () => {
    expect(
      shouldRemakeAppAdvisorWindow({
        ...idleHidden,
        hostsView: false,
        earlyAccess: true,
        unsentDraft: true,
      }),
    ).toBe(false);
  });

  it('keeps a window that is showing or running a turn', () => {
    expect(
      shouldRemakeAppAdvisorWindow({
        hostsView: true,
        earlyAccess: false,
        visible: true,
        turnsActive: false,
        unsentDraft: false,
      }),
    ).toBe(false);
    expect(
      shouldRemakeAppAdvisorWindow({
        hostsView: false,
        earlyAccess: true,
        visible: false,
        turnsActive: true,
        unsentDraft: false,
      }),
    ).toBe(false);
  });
});

describe('floating App Advisor bounds', () => {
  const content = { width: 1400, height: 900 };

  it('sits in the bottom-right corner of the window content, inset by the margin', () => {
    const bounds = floatingAppAdvisorBounds(content, 1);
    expect(bounds.width).toBe(400);
    expect(bounds.height).toBe(640);
    expect(bounds.x + bounds.width).toBe(
      content.width - APP_ADVISOR_FLOATING_MARGIN,
    );
    expect(bounds.y + bounds.height).toBe(
      content.height - APP_ADVISOR_FLOATING_MARGIN,
    );
  });

  it('scales with the interface zoom, margin included', () => {
    const bounds = floatingAppAdvisorBounds(content, 1.25);
    expect(bounds.width).toBe(500);
    expect(bounds.height).toBe(800);
    expect(content.width - (bounds.x + bounds.width)).toBe(20);
  });

  it('never runs past a small window', () => {
    const small = { width: 380, height: 500 };
    const bounds = floatingAppAdvisorBounds(small, 1);
    expect(bounds.x).toBe(APP_ADVISOR_FLOATING_MARGIN);
    expect(bounds.y).toBe(APP_ADVISOR_FLOATING_MARGIN);
    expect(bounds.width).toBe(small.width - 2 * APP_ADVISOR_FLOATING_MARGIN);
    expect(bounds.height).toBe(small.height - 2 * APP_ADVISOR_FLOATING_MARGIN);
  });

  it('takes the size the user resized the panel to', () => {
    expect(
      floatingAppAdvisorBounds({ width: 1600, height: 1000 }, 1, {
        width: 520,
        height: 800,
      }),
    ).toEqual({
      x: 1600 - 520 - APP_ADVISOR_FLOATING_MARGIN,
      y: 1000 - 800 - APP_ADVISOR_FLOATING_MARGIN,
      width: 520,
      height: 800,
    });
  });
});

describe('floating App Advisor size', () => {
  it('clamps a resize to the allowed range', () => {
    const limits = APP_ADVISOR_FLOATING_SIZE_LIMITS;
    expect(clampAppAdvisorFloatingSize({ width: 100, height: 100 })).toEqual({
      width: limits.minWidth,
      height: limits.minHeight,
    });
    expect(clampAppAdvisorFloatingSize({ width: 5000, height: 5000 })).toEqual({
      width: limits.maxWidth,
      height: limits.maxHeight,
    });
    expect(
      clampAppAdvisorFloatingSize({ width: 480.4, height: 700.6 }),
    ).toEqual({ width: 480, height: 701 });
  });
});

describe('appAdvisorPaintProbe', () => {
  /**
   * Runs the probe against a fake page whose animation frames the test
   * steps, returning a step function and the probe's result.
   */
  function runProbe(
    page: {
      floating: boolean;
      innerWidth: number;
      innerHeight: number;
      now: number;
    },
    zoom = 1,
  ): { frame: () => Promise<void>; result: Promise<unknown> } {
    let frames: Array<() => void> = [];
    const body = {
      hasAttribute: (name: string): boolean =>
        name === 'data-app-advisor-floating' && page.floating,
    };
    const probe = appAdvisorPaintProbe({
      layout: 'floating',
      size: { width: 400, height: 640 },
      zoom,
      waitMs: 500,
    });
    const result: unknown = runInNewContext(probe, {
      document: { body },
      window: page,
      performance: { now: (): number => page.now },
      requestAnimationFrame: (callback: () => void): void => {
        frames.push(callback);
      },
    });
    return {
      frame: async (): Promise<void> => {
        const due = frames;
        frames = [];
        due.forEach((callback) => callback());
        await Promise.resolve();
      },
      result: Promise.resolve(result),
    };
  }

  it('resolves two frames after the page renders the layout at the size', async () => {
    const page = { floating: false, innerWidth: 0, innerHeight: 0, now: 0 };
    const { frame, result } = runProbe(page);
    let settled: unknown = 'pending';
    void result.then((value) => {
      settled = value;
    });

    await frame();
    expect(settled).toBe('pending');
    // Rendered floating, but not yet resized to the panel.
    page.floating = true;
    await frame();
    expect(settled).toBe('pending');
    page.innerWidth = 400;
    page.innerHeight = 640;
    await frame();
    await frame();
    expect(settled).toBe('pending');
    await frame();
    await result;
    expect(settled).toBe(true);
  });

  it('compares the size in CSS px at the page zoom', async () => {
    const page = { floating: true, innerWidth: 320, innerHeight: 512, now: 0 };
    const { frame, result } = runProbe(page, 1.25);
    await frame();
    await frame();
    expect(await result).toBe(true);
  });

  it('gives up after the wait', async () => {
    const page = { floating: false, innerWidth: 400, innerHeight: 640, now: 0 };
    const { frame, result } = runProbe(page);
    page.now = 501;
    await frame();
    expect(await result).toBe(false);
  });
});

describe('appAdvisorCloseLeavesBubble', () => {
  it('leaves the bubble only when the floating panel is minimized', () => {
    expect(
      appAdvisorCloseLeavesBubble({
        options: { minimize: true },
        floating: true,
      }),
    ).toBe(true);
    // Close, a plain hide, and the full window leave no bubble.
    expect(
      appAdvisorCloseLeavesBubble({
        options: { minimize: false },
        floating: true,
      }),
    ).toBe(false);
    expect(
      appAdvisorCloseLeavesBubble({ options: undefined, floating: true }),
    ).toBe(false);
    expect(
      appAdvisorCloseLeavesBubble({
        options: { minimize: true },
        floating: false,
      }),
    ).toBe(false);
  });

  it('ignores anything but a `minimize: true` request', () => {
    for (const options of [null, 'minimize', 1, { minimize: 'yes' }, []]) {
      expect(appAdvisorCloseLeavesBubble({ options, floating: true })).toBe(
        false,
      );
    }
  });
});

describe('the layout an open lands in after asking for the floating panel', () => {
  it('floats when the panel showed', () => {
    expect(appAdvisorLayoutAfterFloatingShow('shown')).toBe('floating');
  });

  it('shows nothing when a close replaced it while the panel painted', () => {
    // Falling back to the full window here would show and focus it.
    expect(appAdvisorLayoutAfterFloatingShow('superseded')).toBe('superseded');
  });

  it('uses the full window only without a main window to float in', () => {
    expect(appAdvisorLayoutAfterFloatingShow('unavailable')).toBe('full');
  });
});

describe('the layout an open request asks for', () => {
  it('asks for the full window for an archive view', () => {
    expect(
      appAdvisorRequestedLayout({
        archivedContainer: { containerId: 'c-1' },
        background: true,
      }),
    ).toBe('full');
    expect(appAdvisorRequestedLayout({ archivedOverview: {} })).toBe('full');
    // A chat id main resolved to an archived chat.
    expect(
      appAdvisorRequestedLayout({ chatId: 'chat-1' }, { archivedChat: true }),
    ).toBe('full');
  });

  it("keeps the request's own layout otherwise", () => {
    expect(appAdvisorRequestedLayout({ layout: 'floating' })).toBe('floating');
    expect(appAdvisorRequestedLayout({ chatId: 'chat-1' })).toBeUndefined();
    expect(appAdvisorRequestedLayout(undefined)).toBeUndefined();
  });
});
