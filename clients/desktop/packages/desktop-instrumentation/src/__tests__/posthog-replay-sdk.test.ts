/** @jest-environment jsdom */
import { gunzipSync } from 'node:zlib';
import { PostHog } from 'posthog-js/dist/module.full.no-external';
import { createPostHogRuntimeController } from '../client/posthog-runtime';
import { buildPostHogSessionRecordingOptions } from '../client/posthog-replay-options';
import { POSTHOG_MAIN_ROUTE } from '../posthog-routes';

jest.mock(
  'posthog-js/dist/module.full.no-external',
  () =>
    jest.requireActual(
      'posthog-js/dist/module.full.no-external.cjs',
    ) as unknown,
);

const replayOptions = buildPostHogSessionRecordingOptions(
  () => POSTHOG_MAIN_ROUTE,
);

function createSdk(rate: number): {
  sdk: PostHog;
  sent: jest.Mock<void, [unknown]>;
  controller: ReturnType<typeof createPostHogRuntimeController>;
} {
  const sdk = new PostHog();
  const sent = jest.fn<void, [unknown]>();
  sdk._send_request = sent;
  sdk.init('phc_replay_test', {
    api_host: 'http://127.0.0.1:18763',
    persistence: 'localStorage',
    opt_out_capturing_by_default: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    disable_session_recording: true,
    capture_pageview: false,
    capture_pageleave: false,
    autocapture: false,
    capture_performance: false,
    enable_recording_console_log: false,
    session_recording: replayOptions,
  });
  const controller = createPostHogRuntimeController(
    sdk,
    {
      enabled: true,
      projectKey: 'phc_replay_test',
      host: 'http://127.0.0.1:18763',
      sessionReplaySampleRate: 100,
    },
    { captureEnabled: true, sessionReplaySampleRate: rate },
    replayOptions,
  );
  return { sdk, sent, controller };
}

function persistedRate(sdk: PostHog): number | undefined {
  const value: unknown = sdk.get_property('$session_recording_remote_config');
  return value && typeof value === 'object' && 'sampleRate' in value
    ? Number(value.sampleRate)
    : undefined;
}

describe('PostHog replay against the pinned SDK', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      value: false,
    });
  });

  it('uses the local rate over either remote sample rate and makes no config request', () => {
    for (const [appRate, remoteRate] of [
      [100, 0],
      [0, 1],
    ] as const) {
      const { sdk, sent, controller } = createSdk(appRate);
      sdk.sessionRecording?.onRemoteConfig({
        ok: true,
        config: {
          sessionRecording: { endpoint: '/s/', sampleRate: String(remoteRate) },
          supportedCompression: [],
          toolbarParams: {},
          toolbarVersion: 'toolbar',
          isAuthenticated: false,
          siteApps: [],
        },
      });
      expect(persistedRate(sdk)).toBe(appRate / 100);
      if (appRate === 0) expect(sdk.sessionRecordingStarted()).toBe(false);
      const urls = sent.mock.calls.map(([request]) =>
        request &&
        typeof request === 'object' &&
        'url' in request &&
        typeof request.url === 'string'
          ? request.url
          : '',
      );
      expect(
        urls.some((url) => /\/array\/.*\/config|\/flags|\/decide/.test(url)),
      ).toBe(false);
      controller.dispose();
      sdk.reset();
      localStorage.clear();
    }
  });

  it('persists a lowered cap through a new session after the SDK has started', () => {
    const { sdk, controller } = createSdk(100);
    expect(persistedRate(sdk)).toBe(1);
    sdk.set_config({
      session_recording: { ...replayOptions, sampleRate: 0.25 },
    });
    expect(persistedRate(sdk)).toBe(1);
    controller.update({ captureEnabled: true, sessionReplaySampleRate: 25 });
    expect(persistedRate(sdk)).toBe(0.25);
    sdk.sessionManager?.resetSessionId();
    expect(persistedRate(sdk)).toBe(0.25);
    controller.dispose();
    sdk.reset();
  });
});

type BufferedReplayEvent = {
  type: number;
  cv?: string;
  data: string | Record<string, unknown>;
};

function bufferedReplayEvents(sdk: PostHog): BufferedReplayEvent[] {
  const recording = sdk.sessionRecording as unknown as {
    _lazyLoadedSessionRecording?: {
      _buffer?: { data?: BufferedReplayEvent[] };
    };
  };
  return recording._lazyLoadedSessionRecording?._buffer?.data ?? [];
}

function decodedEvent(event: BufferedReplayEvent): string {
  if (!event.cv) return JSON.stringify(event.data);
  if (typeof event.data === 'string') {
    return gunzipSync(Buffer.from(event.data, 'latin1')).toString();
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    data[key] =
      typeof value === 'string'
        ? JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString())
        : value;
  }
  return JSON.stringify(data);
}

describe('replay payload against the pinned SDK', () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      value: false,
    });
  });

  it('records text and attributes, masking only inputs and blocked subtrees, in snapshots and mutations', async () => {
    const css = document.createElement('style');
    css.textContent = '.reviewed { color: red }';
    document.head.append(css);
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="reviewed">Static <span>private123</span></div><div class="ph-no-capture"><b>blocked123</b></div><a class="reviewed" style="color:red" id="private123" href="https://example.test/private123" aria-label="private123" data-foo="private123">Chrome label</a><p>masked123 <em>nested123</em></p><input type="hidden" value="hidden-only123"><input type="file"><input type="text" value="input-only123">';
    document.body.append(root, document.createComment('comment-only123'));
    const { sdk, controller } = createSdk(100);
    sdk.sessionRecording?.onRemoteConfig({
      ok: true,
      config: {
        sessionRecording: {
          endpoint: '/s/',
          sampleRate: '1',
          masking: { maskAllElementAttributes: true },
        },
        supportedCompression: [],
        toolbarParams: {},
        toolbarVersion: 'toolbar',
        isAuthenticated: false,
        siteApps: [],
      },
    });
    const full = decodedEvent(
      bufferedReplayEvents(sdk).find((event) => event.type === 2) ?? {
        type: 2,
        data: '',
      },
    );
    expect(full).toContain('Static');
    expect(full).toContain('Chrome label');
    // Text and every attribute are recorded, including a project-level
    // request to mask all attributes.
    expect(full).toContain('masked123');
    expect(full).toContain('nested123');
    expect(full).toContain('https://example.test/private123');
    expect(full).toContain('color:red');
    expect(full).toMatch(/"aria-label":"private123"/);
    expect(full).toMatch(/"data-foo":"private123"/);
    expect(full).toContain('class\":\"reviewed');
    expect(full).toContain('class\":\"ph-no-capture');
    expect(full).toContain('rr_width');
    expect(full).toContain('rr_height');
    expect(full).toMatch(/\.reviewed \{color: red;\}/);
    expect(full).not.toMatch(
      /blocked123|hidden-only123|comment-only123|input-only123/,
    );

    const label = root.querySelector('.reviewed');
    const anchor = root.querySelector('a');
    const hidden = root.querySelector<HTMLInputElement>('input[type="hidden"]');
    const maskedText = root.querySelector('span');
    if (
      !label?.firstChild ||
      !anchor?.firstChild ||
      !hidden ||
      !maskedText?.firstChild
    )
      throw new Error('fixture missing');
    label.firstChild.textContent = 'Static changed';
    anchor.firstChild.textContent = 'Chrome changed';
    maskedText.firstChild.textContent = 'masked456 ';
    anchor.setAttribute('data-foo', 'private456');
    anchor.setAttribute('class', 'reviewed changed');
    hidden.value = 'hidden-only456';
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
    root.append(document.createComment('comment-later456'));
    const textInput =
      root.querySelector<HTMLInputElement>('input[type="text"]');
    if (!textInput) throw new Error('text input fixture missing');
    textInput.value = 'input-only456';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const payload = bufferedReplayEvents(sdk).map(decodedEvent).join('\n');
    expect(payload).toContain('Static changed');
    expect(payload).toContain('Chrome changed');
    expect(payload).toContain('reviewed changed');
    expect(payload).toContain('masked456');
    expect(payload).toContain('private456');
    expect(payload).not.toMatch(
      /blocked123|hidden-only123|hidden-only456|comment-only123|comment-later456|input-only123|input-only456/,
    );
    controller.dispose();
    sdk.reset();
  });
});
