/** @jest-environment jsdom */
import {
  PostHog,
  type CaptureResult,
} from 'posthog-js/dist/module.full.no-external';
import { createPostHogRuntimeController } from '../client/posthog-runtime';
import { POSTHOG_CLICK_INIT_OPTIONS } from '../client/posthog-autocapture-options';
import {
  POSTHOG_PROPERTY_DENYLIST,
  sanitizePostHogEvent,
} from '../posthog-privacy';

jest.mock(
  'posthog-js/dist/module.full.no-external',
  () =>
    jest.requireActual(
      'posthog-js/dist/module.full.no-external.cjs',
    ) as unknown,
);

const EMAIL = 'harbor.lantern@orchard.example';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function createSdk(autocaptureEnabled: boolean): {
  sdk: PostHog;
  sent: jest.Mock<void, [unknown]>;
  events: CaptureResult[];
  controller: ReturnType<typeof createPostHogRuntimeController>;
} {
  const sdk = new PostHog();
  const sent = jest.fn<void, [unknown]>();
  sdk._send_request = sent;
  const events: CaptureResult[] = [];
  let controller: ReturnType<typeof createPostHogRuntimeController> | null =
    null;
  sdk.init('phc_autocapture_test', {
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
      const sanitized = sanitizePostHogEvent(event);
      if (sanitized) events.push(sanitized);
      return sanitized;
    },
  });
  controller = createPostHogRuntimeController(
    sdk,
    {
      enabled: true,
      projectKey: 'phc_autocapture_test',
      host: 'http://127.0.0.1:18763',
      sessionReplaySampleRate: 0,
    },
    { captureEnabled: true, sessionReplaySampleRate: 0, autocaptureEnabled },
  );
  return { sdk, sent, events, controller };
}

function click(element: Element, clientX = 0): void {
  element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX }),
  );
}

function firstElement(event: CaptureResult | undefined): unknown {
  const elements: unknown = event?.properties.$elements;
  return Array.isArray(elements) ? elements[0] : undefined;
}

function clickEvents(events: CaptureResult[]): CaptureResult[] {
  // Heatmap batches are covered by posthog-heatmaps-sdk.test.ts.
  return events.filter(
    (event) => event.event !== '$opt_in' && event.event !== '$$heatmap',
  );
}

describe('PostHog click capture against the pinned SDK', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML =
      '<nav><button data-testid="sidebar-nav-pipelines" aria-label="Pipelines" class="nav-row">Pipelines</button></nav>' +
      `<button data-testid="chat-row" title="${EMAIL}">Board thread ${TOKEN}</button>` +
      '<a data-testid="docs-link" href="https://example.test/docs?token=private123#frag">Docs</a>' +
      '<div class="ph-no-capture"><button data-testid="blocked-button">blocked123</button></div>' +
      '<p id="plain">Plain text</p>';
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('captures nothing from clicks while the autocapture flag is off', () => {
    const { sdk, events, controller } = createSdk(false);
    const button = document.querySelector('[data-testid="chat-row"]');
    if (!button) throw new Error('fixture missing');
    for (let index = 0; index < 3; index++) click(button);
    expect(clickEvents(events)).toEqual([]);
    expect(controller.allowsEvent('$autocapture')).toBe(false);
    expect(controller.allowsEvent('$rageclick')).toBe(false);
    expect(controller.allowsEvent('$dead_click')).toBe(false);
    expect(controller.allowsEvent('app_opened')).toBe(true);
    controller.dispose();
    sdk.reset();
  });

  it('records element text and attributes through the outbound sanitizer', () => {
    const { sdk, sent, events, controller } = createSdk(true);
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    const chat = document.querySelector('[data-testid="chat-row"]');
    const link = document.querySelector('[data-testid="docs-link"]');
    if (!nav || !chat || !link) throw new Error('fixture missing');
    // Far apart, so these clicks are not a rage-click streak.
    click(nav, 0);
    click(chat, 200);
    link.addEventListener('click', (event) => event.preventDefault());
    click(link, 400);
    const captured = clickEvents(events);
    expect(captured.map((event) => event.event)).toEqual([
      '$autocapture',
      '$autocapture',
      '$autocapture',
    ]);
    const [navClick, chatClick, linkClick] = captured;
    expect(navClick?.properties.$el_text).toBe('Pipelines');
    expect(firstElement(navClick)).toMatchObject({
      tag_name: 'button',
      'attr__data-testid': 'sidebar-nav-pipelines',
      'attr__aria-label': 'Pipelines',
      attr__class: 'nav-row',
    });
    // Credentials and emails in recorded text and attributes are redacted.
    const chatWire = JSON.stringify(chatClick);
    expect(chatWire).toContain('Board thread');
    expect(chatWire).not.toContain(TOKEN);
    expect(chatWire).not.toContain(EMAIL);
    // URLs keep their origin and path only; the chain string never ships.
    expect(firstElement(linkClick)).toMatchObject({
      attr__href: 'https://example.test/docs',
    });
    for (const event of captured) {
      expect(event.properties).not.toHaveProperty('$elements_chain');
    }
    expect(JSON.stringify(sent.mock.calls)).not.toContain('private123');
    controller.dispose();
    sdk.reset();
  });

  it('redacts credentials in click text and non-URL attributes before sending', () => {
    const { sdk, sent, events, controller } = createSdk(true);
    const button = document.createElement('button');
    button.dataset.testid = 'connect-control';
    button.textContent = 'Connect --token private-review-secret';
    button.title =
      'Continue at https://example.test/oauth/callback?code=oauth-private-code&state=oauth-private-state';
    document.body.append(button);

    click(button);

    const captured = clickEvents(events);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties.$el_text).toBe('Connect --token ***');
    expect(firstElement(captured[0])).toMatchObject({
      'attr__data-testid': 'connect-control',
      attr__title:
        'Continue at https://example.test/oauth/callback?code=***&state=***',
    });
    const wire = JSON.stringify(sent.mock.calls);
    expect(wire).not.toContain('private-review-secret');
    expect(wire).not.toContain('oauth-private-code');
    expect(wire).not.toContain('oauth-private-state');
    controller.dispose();
    sdk.reset();
  });

  it('captures nothing inside a replay block or from copied text', () => {
    jest.useFakeTimers();
    const { sdk, events, controller } = createSdk(true);
    const blocked = document.querySelector('[data-testid="blocked-button"]');
    if (!blocked) throw new Error('fixture missing');
    for (let index = 0; index < 3; index++) click(blocked);
    document.dispatchEvent(new Event('copy', { bubbles: true }));
    jest.advanceTimersByTime(5_000);
    expect(clickEvents(events)).toEqual([]);
    controller.dispose();
    sdk.reset();
  });

  it('reports a rage click once per streak alongside each click', () => {
    const { sdk, events, controller } = createSdk(true);
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    if (!nav) throw new Error('fixture missing');
    for (let index = 0; index < 3; index++) click(nav);
    const names = clickEvents(events).map((event) => event.event);
    expect(names.filter((name) => name === '$autocapture')).toHaveLength(3);
    expect(names.filter((name) => name === '$rageclick')).toHaveLength(1);
    const rage = clickEvents(events).find(
      (event) => event.event === '$rageclick',
    );
    expect(firstElement(rage)).toMatchObject({
      'attr__data-testid': 'sidebar-nav-pipelines',
    });
    controller.dispose();
    sdk.reset();
  });

  it('reports a click that changes nothing as a dead click', () => {
    jest.useFakeTimers();
    const { sdk, events, controller } = createSdk(true);
    const plain = document.getElementById('plain');
    if (!plain) throw new Error('fixture missing');
    click(plain);
    jest.advanceTimersByTime(5_000);
    const dead = clickEvents(events).filter(
      (event) => event.event === '$dead_click',
    );
    expect(dead).toHaveLength(1);
    expect(firstElement(dead[0])).toMatchObject({
      tag_name: 'p',
      attr__id: 'plain',
    });
    expect(dead[0]?.properties).not.toHaveProperty('$elements_chain');
    controller.dispose();
    sdk.reset();
  });

  it('stops click capture when the flag turns off at runtime', () => {
    jest.useFakeTimers();
    const { sdk, events, controller } = createSdk(true);
    controller.update({
      captureEnabled: true,
      sessionReplaySampleRate: 0,
      autocaptureEnabled: false,
    });
    const nav = document.querySelector('[data-testid="sidebar-nav-pipelines"]');
    const plain = document.getElementById('plain');
    if (!nav || !plain) throw new Error('fixture missing');
    for (let index = 0; index < 3; index++) click(nav);
    click(plain);
    jest.advanceTimersByTime(5_000);
    expect(clickEvents(events)).toEqual([]);
    controller.dispose();
    sdk.reset();
  });
});
