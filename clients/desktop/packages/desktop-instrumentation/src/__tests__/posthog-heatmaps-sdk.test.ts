/** @jest-environment jsdom */
import {
  PostHog,
  type CaptureResult,
} from 'posthog-js/dist/module.full.no-external';
import { createPostHogRuntimeController } from '../client/posthog-runtime';
import { POSTHOG_CLICK_INIT_OPTIONS } from '../client/posthog-autocapture-options';
import {
  flushPostHogHeatmaps,
  POSTHOG_HEATMAP_EVENT,
} from '../client/posthog-heatmaps';
import {
  POSTHOG_PROPERTY_DENYLIST,
  sanitizePostHogEvent,
} from '../posthog-privacy';
import type { PostHogRoute } from '../posthog-routes';

jest.mock(
  'posthog-js/dist/module.full.no-external',
  () =>
    jest.requireActual(
      'posthog-js/dist/module.full.no-external.cjs',
    ) as unknown,
);

const BLOCKED_TEXT = 'blocked123';

function createSdk(
  autocaptureEnabled: boolean,
  getRoute: () => PostHogRoute,
): {
  sdk: PostHog;
  heatmaps: () => CaptureResult[];
  controller: ReturnType<typeof createPostHogRuntimeController>;
} {
  const sdk = new PostHog();
  sdk._send_request = jest.fn();
  const events: CaptureResult[] = [];
  let controller: ReturnType<typeof createPostHogRuntimeController> | null =
    null;
  sdk.init('phc_heatmap_test', {
    api_host: 'http://127.0.0.1:18763',
    persistence: 'localStorage',
    opt_out_capturing_by_default: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    disable_session_recording: true,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    ...POSTHOG_CLICK_INIT_OPTIONS,
    property_denylist: [...POSTHOG_PROPERTY_DENYLIST],
    before_send: (event) => {
      if (!event || !controller?.allowsEvent(event.event)) return null;
      const sanitized = sanitizePostHogEvent(event, {
        screenRoute: getRoute(),
      });
      if (sanitized) events.push(sanitized);
      return sanitized;
    },
  });
  controller = createPostHogRuntimeController(
    sdk,
    {
      enabled: true,
      projectKey: 'phc_heatmap_test',
      host: 'http://127.0.0.1:18763',
      sessionReplaySampleRate: 0,
    },
    { captureEnabled: true, sessionReplaySampleRate: 0, autocaptureEnabled },
  );
  return {
    sdk,
    heatmaps: () =>
      events.filter((event) => event.event === POSTHOG_HEATMAP_EVENT),
    controller,
  };
}

function click(element: Element, clientX: number, clientY: number): void {
  element.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }),
  );
}

function samples(event: CaptureResult | undefined): unknown {
  return event?.properties.$heatmap_data;
}

function clickAt(x: number, y: number): Record<string, unknown> {
  return { x, y, target_fixed: false, type: 'click' };
}

describe('PostHog heatmaps against the pinned SDK', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
    document.body.innerHTML =
      '<button data-testid="sidebar-nav-pipelines">Pipelines</button>' +
      `<div class="ph-no-capture"><p data-testid="blocked">${BLOCKED_TEXT}</p></div>`;
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('captures no heatmap while the autocapture flag is off', () => {
    const { sdk, heatmaps, controller } = createSdk(
      false,
      () => 'app://main/home',
    );
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    if (!nav) throw new Error('fixture missing');
    click(nav, 10, 20);
    jest.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event('beforeunload'));
    expect(heatmaps()).toEqual([]);
    expect(sdk.heatmaps?.isEnabled).toBe(false);
    controller.dispose();
    sdk.reset();
  });

  it('keys periodic flushes by the current route and sends coordinates only', () => {
    const { sdk, heatmaps, controller } = createSdk(
      true,
      () => 'app://main/home',
    );
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    const blocked = document.querySelector('[data-testid="blocked"]');
    if (!nav || !blocked) throw new Error('fixture missing');
    click(nav, 10, 20);
    click(blocked, 300, 400);
    jest.advanceTimersByTime(5_000);
    const [heatmap] = heatmaps();
    expect(heatmaps()).toHaveLength(1);
    // Clicks that change nothing also add `deadclick` samples.
    expect(samples(heatmap)).toEqual({
      'app://main/home': expect.arrayContaining([
        clickAt(10, 20),
        clickAt(300, 400),
      ]) as unknown,
    });
    // The before_send result is the outgoing payload.
    const wire = JSON.stringify(heatmap);
    expect(wire).not.toContain(window.location.href);
    expect(wire).not.toContain(BLOCKED_TEXT);
    expect(wire).not.toContain('sidebar-nav-pipelines');
    controller.dispose();
    sdk.reset();
  });

  it('flushes samples under the route being left', () => {
    let route: PostHogRoute = 'app://main/home';
    const { sdk, heatmaps, controller } = createSdk(true, () => route);
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    if (!nav) throw new Error('fixture missing');
    click(nav, 10, 20);
    flushPostHogHeatmaps(sdk, route);
    route = 'app://settings/display';
    click(nav, 50, 60);
    jest.advanceTimersByTime(5_000);
    expect(heatmaps().map(samples)).toEqual([
      { 'app://main/home': [clickAt(10, 20)] },
      {
        'app://settings/display': expect.arrayContaining([
          clickAt(50, 60),
        ]) as unknown,
      },
    ]);
    expect(samples(heatmaps()[1])).not.toEqual({
      'app://settings/display': expect.arrayContaining([
        clickAt(10, 20),
      ]) as unknown,
    });
    // An empty buffer sends nothing.
    flushPostHogHeatmaps(sdk, route);
    expect(heatmaps()).toHaveLength(2);
    controller.dispose();
    sdk.reset();
  });

  it.each([false, true])(
    'cancels pending mousemove on route leave (buffered click: %s)',
    (bufferedClick) => {
      let route: PostHogRoute = 'app://main/home';
      const { sdk, heatmaps, controller } = createSdk(true, () => route);
      sdk.get_session_id();
      const captureHeatmaps = { flush_interval_milliseconds: 2_000 };
      sdk.set_config({ capture_heatmaps: captureHeatmaps });
      const nav = document.querySelector(
        '[data-testid="sidebar-nav-pipelines"]',
      );
      if (!nav) throw new Error('fixture missing');
      if (bufferedClick) click(nav, 10, 20);
      nav.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 30,
          clientY: 40,
        }),
      );
      jest.advanceTimersByTime(100);
      flushPostHogHeatmaps(sdk, route);
      route = 'app://settings/display';
      jest.advanceTimersByTime(500);
      nav.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 50,
          clientY: 60,
        }),
      );
      jest.advanceTimersByTime(5_000);
      if (bufferedClick) {
        expect(samples(heatmaps()[0])).toEqual({
          'app://main/home': [clickAt(10, 20)],
        });
      }
      // The SDK's dead-click cleanup does not cancel its pending callbacks.
      // Check mousemove attribution independently of that documented behavior.
      const newMovement: unknown = expect.arrayContaining([
        { x: 50, y: 60, target_fixed: false, type: 'mousemove' },
      ]);
      const oldMovement: unknown = expect.arrayContaining([
        { x: 30, y: 40, target_fixed: false, type: 'mousemove' },
      ]);
      expect(heatmaps().map(samples)).toContainEqual({
        'app://settings/display': newMovement,
      });
      expect(heatmaps().map(samples)).not.toContainEqual({
        'app://settings/display': oldMovement,
      });
      expect(sdk.heatmaps?.isEnabled).toBe(true);
      expect(sdk.config.capture_heatmaps).toEqual(captureHeatmaps);
      controller.dispose();
      sdk.reset();
    },
  );

  it('does not report a click that navigates as a dead click on the next route', async () => {
    let route: PostHogRoute = 'app://main/home';
    const { sdk, heatmaps, controller } = createSdk(true, () => route);
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    if (!nav) throw new Error('fixture missing');
    // Like a real navigation: the route source publishes from the click
    // handler, then the next screen renders.
    nav.addEventListener('click', () => {
      flushPostHogHeatmaps(sdk, route);
      route = 'app://settings/display';
      document.body.append(document.createElement('section'));
    });
    click(nav, 10, 20);
    // Deliver mutation records before the dead-click checks run.
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    expect(heatmaps()).not.toHaveLength(0);
    expect(JSON.stringify(heatmaps().map(samples))).not.toContain(
      '"type":"deadclick"',
    );
    controller.dispose();
    sdk.reset();
  });

  it('stops collecting and discards buffered samples when the flag turns off', () => {
    const { sdk, heatmaps, controller } = createSdk(
      true,
      () => 'app://main/home',
    );
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    if (!nav) throw new Error('fixture missing');
    click(nav, 10, 20);
    controller.update({
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
    });
    click(nav, 30, 40);
    jest.advanceTimersByTime(10_000);
    flushPostHogHeatmaps(sdk, 'app://main/home');
    expect(heatmaps()).toEqual([]);
    expect(sdk.heatmaps?.isEnabled).toBe(false);
    expect(sdk.config.capture_heatmaps).toBe(false);
    controller.dispose();
    sdk.reset();
  });
});
