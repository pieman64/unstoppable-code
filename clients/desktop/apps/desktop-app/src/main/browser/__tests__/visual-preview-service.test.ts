/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type -- Electron test doubles deliberately use Jest's dynamic APIs. */
import { EventEmitter } from 'node:events';

jest.mock('../visual-preview-theme', () => ({
  resolveVisualPreviewTheme: jest.fn(async () => ({
    appearance: 'light',
    variables: {},
  })),
}));

const windows: MockWindow[] = [];
const operations: string[] = [];
const loadBarriers = new Map<number, Promise<void>>();
let requestListener:
  | ((
      details: { url: string; webContentsId?: number },
      callback: (result: { cancel: boolean }) => void,
    ) => void)
  | undefined;
let requestInstallCount = 0;
const partition = jest.fn(() => ({
  webRequest: {
    onBeforeRequest: jest.fn((listener) => {
      requestInstallCount++;
      requestListener = listener;
    }),
  },
  setPermissionRequestHandler: jest.fn(),
  setPermissionCheckHandler: jest.fn(),
  setDevicePermissionHandler: jest.fn(),
  on: jest.fn(),
  isPersistent: () => false,
}));

let frameValue: unknown = 120;
let agentSettleDelayMs = 0;
class MockFrame {
  url = 'about:srcdoc';
  detached = false;
  origin = 'null';
  frameTreeNodeId = 33;
  // The relay (wrapper) frame sits between the agent frame and the shell.
  parent: { frameTreeNodeId: number; parent: { frameTreeNodeId: number } } = {
    frameTreeNodeId: 22,
    parent: { frameTreeNodeId: 1 },
  };
  executeJavaScript = jest.fn<
    Promise<unknown>,
    [code: string, userGesture?: boolean]
  >(async (code: string) => {
    const kind = code.includes('documentHeight()') ? 'measure' : 'agent-settle';
    operations.push(kind);
    if (kind === 'agent-settle' && agentSettleDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, agentSettleDelayMs));
    return kind === 'measure' ? frameValue : true;
  });
}
class MockContents extends EventEmitter {
  id: number;
  mainFrame = { frameTreeNodeId: 1, framesInSubtree: [new MockFrame()] };
  setZoomFactor = jest.fn();
  setVisualZoomLevelLimits = jest.fn(async () => undefined);
  setAudioMuted = jest.fn();
  setWindowOpenHandler = jest.fn();
  executeJavaScript = jest.fn(async (code: string) => {
    operations.push(
      code.includes('document.write(')
        ? 'document'
        : code.includes('querySelector')
          ? 'resize-frame'
          : 'shell-settle',
    );
    return true;
  });
  capturePage = jest.fn(async () => {
    operations.push('capture');
    return {
      resize: jest.fn(function (this: MockImage) {
        return this;
      }),
      getSize: () => ({ width: 720, height: 120 }),
      toPNG: () => Buffer.alloc(100),
      toJPEG: () => Buffer.alloc(70),
    };
  });
  constructor(id: number) {
    super();
    this.id = id;
  }
}
interface MockImage {
  resize: jest.Mock;
}
class MockWindow extends EventEmitter {
  webContents: MockContents;
  options: Record<string, unknown>;
  destroyed = false;
  loadURL = jest.fn(() => {
    if (!requestListener) throw new Error('loadURL before session policy');
    return loadBarriers.get(this.webContents.id) ?? Promise.resolve();
  });
  setContentSize = jest.fn(() => {
    operations.push('resize-window');
  });
  isDestroyed = () => this.destroyed;
  destroy = jest.fn(() => {
    this.destroyed = true;
    this.emit('closed');
  });
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    this.webContents = new MockContents(windows.length + 1);
    windows.push(this);
  }
}
const app = new EventEmitter();
jest.mock('electron', () => ({
  app,
  BrowserWindow: MockWindow,
  session: { fromPartition: partition },
  nativeTheme: { shouldUseDarkColors: false },
}));

const loadService = () => import('../visual-preview-service');
let serviceModule: Awaited<ReturnType<typeof loadService>>;
beforeAll(async () => {
  serviceModule = await loadService();
});

const prepared = { html: '<div>Hello</div>', unresolvedImagePaths: [] };

beforeEach(() => {
  windows.length = 0;
  partition.mockClear();
  frameValue = 120;
  agentSettleDelayMs = 0;
  loadBarriers.clear();
  operations.length = 0;
});

function holdLoad(id: number): () => void {
  let release: () => void = () => undefined;
  loadBarriers.set(
    id,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return release;
}

it('uses a hidden, hardened window and destroys it after preview', async () => {
  const result = await serviceModule.getVisualPreviewService().preview({
    prepared,
    width: 720,
    imageBudgetBytes: 1000,
  });
  expect(result.status).toBe('ok');
  expect(result.contentHeight).toBe(120);
  expect(result.capturedHeight).toBe(120);
  expect(result.image?.mime).toBe('image/jpeg');
  expect(windows[0]?.options).toMatchObject({
    show: false,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    useContentSize: true,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      webviewTag: false,
      spellcheck: false,
      safeDialogs: true,
      backgroundThrottling: false,
    },
  });
  expect(windows[0]?.options).not.toHaveProperty('offscreen');
  expect(windows[0]?.options).not.toHaveProperty('preload');
  expect(windows[0]?.options.webPreferences).not.toHaveProperty('offscreen');
  expect(windows[0]?.options.webPreferences).not.toHaveProperty('preload');
  expect(windows[0]?.loadURL).toHaveBeenCalledWith('about:blank');
  expect(
    windows[0]?.webContents.executeJavaScript.mock.calls[0]?.[0],
  ).toContain('document.write(');
  expect(windows[0]?.destroy).toHaveBeenCalledTimes(1);
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
  expect(partition).toHaveBeenCalledWith('visual-preview');
  expect(requestListener).toBeDefined();
  expect(requestInstallCount).toBe(1);
});

it('measures each width in one window without capturing', async () => {
  const result = await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360, 520],
    maxHeight: 100,
    deadlineMs: 3000,
  });
  expect(result).toEqual({
    status: 'ok',
    heights: [
      [360, 100],
      [520, 100],
    ],
  });
  expect(windows).toHaveLength(1);
  expect(windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
});

it('omits a zero-budget image and rejects forged non-primitive measurement', async () => {
  const result = await serviceModule.getVisualPreviewService().preview({
    prepared,
    width: 720,
    imageBudgetBytes: 0,
  });
  expect(result.image).toBeNull();
  expect(result.imageOmittedReason).toBe('Image omitted by provider budget.');
  // Nothing can be returned, so the page is never captured.
  expect(result.status).toBe('ok');
  expect(result.contentHeight).toBe(120);
  expect(windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
  expect(result.timing.captureMs).toBe(0);
  frameValue = ['forged'];
  const forged = await serviceModule.getVisualPreviewService().preview({
    prepared,
    width: 720,
    imageBudgetBytes: 1000,
  });
  expect(forged.status).toBe('error');
});

it('encodes within the budget or omits', () => {
  const image = {
    resize: jest.fn(function (this: unknown) {
      return this;
    }),
    getSize: () => ({ width: 720, height: 120 }),
    toPNG: () => Buffer.alloc(100),
    toJPEG: () => Buffer.alloc(70),
  };
  expect(
    serviceModule.encodeForBudget(image as never, 1000, 720, 120).image?.bytes,
  ).toBe(70);
  expect(
    serviceModule.encodeForBudget(image as never, 128 * 1024, 720, 120).image
      ?.mime,
  ).toBe('image/png');
  expect(
    serviceModule.encodeForBudget(image as never, 0, 720, 120).image,
  ).toBeNull();
  expect(
    serviceModule.encodeForBudget(image as never, 1, 720, 120).image,
  ).toBeNull();
});

it('keeps the policy active for run B after run A finishes', async () => {
  const releaseB = holdLoad(2);
  const service = serviceModule.getVisualPreviewService();
  const a = service.preview({ prepared, width: 720, imageBudgetBytes: 0 });
  const b = service.preview({ prepared, width: 720, imageBudgetBytes: 0 });
  expect((await a).status).toBe('ok');
  expect(windows[1]?.destroyed).toBe(false);
  const callback = jest.fn();
  requestListener?.({ url: 'file:///tmp/leak', webContentsId: 2 }, callback);
  expect(callback).toHaveBeenCalledWith({ cancel: true });
  releaseB();
  expect((await b).blockedRequests).toEqual(['file:///tmp/leak']);
  expect(partition).not.toHaveBeenCalled(); // The singleton session is reused.
  expect(requestInstallCount).toBe(1);
});

it('admits two runs and one waiter, then returns busy', async () => {
  const releaseA = holdLoad(1);
  const releaseB = holdLoad(2);
  const service = serviceModule.getVisualPreviewService();
  const a = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const b = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const c = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const d = await service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  expect(d.status).toBe('busy');
  expect(windows).toHaveLength(2);
  releaseA();
  releaseB();
  expect((await a).status).toBe('ok');
  expect((await b).status).toBe('ok');
  expect((await c).status).toBe('ok');
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it('settles deadline, abort, and crash without leaving a window', async () => {
  const service = serviceModule.getVisualPreviewService();
  holdLoad(1);
  expect(
    (
      await service.measure({
        prepared,
        widths: [360],
        maxHeight: 2000,
        deadlineMs: 20,
      })
    ).status,
  ).toBe('timeout');
  expect(windows[0]?.destroy).toHaveBeenCalled();
  const controller = new AbortController();
  holdLoad(2);
  const aborted = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  expect((await aborted).status).toBe('aborted');
  holdLoad(3);
  const crashed = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  windows[2]?.webContents.emit('render-process-gone');
  expect((await crashed).status).toBe('error');
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it('lets a pre-aborted caller win without creating a window', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 0,
    signal: controller.signal,
  });
  expect(result.status).toBe('aborted');
  expect(windows).toHaveLength(0);
});

it('destroys and unregisters after capture failure, then admits the next run', async () => {
  const release = holdLoad(1);
  const service = serviceModule.getVisualPreviewService();
  const pending = service.preview({
    prepared,
    width: 720,
    imageBudgetBytes: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  windows[0]?.webContents.capturePage.mockRejectedValue(
    new Error('capture failed'),
  );
  release();
  const result = await pending;
  expect(result.status).toBe('error');
  expect(windows[0]?.destroy).toHaveBeenCalledTimes(1);
  const callback = jest.fn();
  requestListener?.(
    { url: 'file:///tmp/after-error', webContentsId: 1 },
    callback,
  );
  expect(result.blockedRequests).toEqual([]);
  expect(
    (await service.preview({ prepared, width: 720, imageBudgetBytes: 0 }))
      .status,
  ).toBe('ok');
});

it('applies every navigation, popup, webview, audio, and zoom guard', async () => {
  const release = holdLoad(1);
  const pending = serviceModule
    .getVisualPreviewService()
    .preview({ prepared, width: 720, imageBudgetBytes: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const window = windows[0];
  expect(window?.webContents.setZoomFactor).toHaveBeenCalledWith(1);
  expect(window?.webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(
    1,
    1,
  );
  expect(window?.webContents.setAudioMuted).toHaveBeenCalledWith(true);
  expect(window?.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual(
    { action: 'deny' },
  );
  for (const kind of ['will-navigate', 'will-attach-webview']) {
    const preventDefault = jest.fn();
    window?.webContents.emit(kind, { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  }
  for (const details of [
    { url: 'https://evil.test/', isMainFrame: true, frame: null },
    {
      url: 'https://evil.test/',
      isMainFrame: false,
      frame: { origin: 'null', url: 'about:srcdoc', detached: false },
    },
  ]) {
    const preventDefault = jest.fn();
    window?.webContents.emit('will-frame-navigate', {
      ...details,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
  }
  const preventDefault = jest.fn();
  window?.webContents.emit('will-frame-navigate', {
    url: 'about:srcdoc',
    isMainFrame: false,
    frame: { origin: 'null', url: 'about:srcdoc', detached: false },
    preventDefault,
  });
  expect(preventDefault).not.toHaveBeenCalled();
  release();
  expect((await pending).status).toBe('ok');
});

it('orders settle, primitive measure, resize, second settle, and capture', async () => {
  await serviceModule
    .getVisualPreviewService()
    .preview({ prepared, width: 720, imageBudgetBytes: 1000 });
  expect(operations).toEqual([
    'document',
    'agent-settle',
    'shell-settle',
    'measure',
    'resize-frame',
    'resize-window',
    'agent-settle',
    'shell-settle',
    'capture',
  ]);
  const frameCalls =
    windows[0]?.webContents.mainFrame.framesInSubtree[0]?.executeJavaScript.mock
      .calls ?? [];
  expect(frameCalls[1]?.[1]).toBe(false);
  expect(frameCalls[1]?.[0]).toContain("typeof h === 'number'");
});

it.each([null, '123', [], {}, Number.NaN, Infinity, -1, 1_000_001])(
  'rejects forged measurement %p',
  async (value) => {
    frameValue = value;
    const result = await serviceModule
      .getVisualPreviewService()
      .preview({ prepared, width: 720, imageBudgetBytes: 0 });
    expect(result.status).toBe('error');
    expect(windows[0]?.destroy).toHaveBeenCalledTimes(1);
  },
);

it('rejects oversized forged array and string results without capture', async () => {
  for (const value of [Array(100_000).fill(1), 'x'.repeat(100_000)]) {
    frameValue = value;
    const result = await serviceModule
      .getVisualPreviewService()
      .preview({ prepared, width: 720, imageBudgetBytes: 0 });
    expect(result.status).toBe('error');
    expect(
      windows[windows.length - 1]?.webContents.capturePage,
    ).not.toHaveBeenCalled();
  }
});

it('clamps each measurement width height in one window', async () => {
  frameValue = 1_000_000;
  const result = await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360, 520, 720],
    maxHeight: 2000,
    deadlineMs: 3000,
  });
  expect(result.heights).toEqual([
    [360, 2000],
    [520, 2000],
    [720, 2000],
  ]);
  expect(windows).toHaveLength(1);
  expect(windows[0]?.setContentSize.mock.calls).toEqual([
    [360, 2000],
    [520, 2000],
    [720, 2000],
  ]);
  expect(windows[0]?.webContents.capturePage).not.toHaveBeenCalled();
  frameValue = 1;
  const short = await serviceModule
    .getVisualPreviewService()
    .measure({ prepared, widths: [360], maxHeight: 2000, deadlineMs: 3000 });
  expect(short.heights).toEqual([[360, 80]]);
});

it('reports page output from the visual frames only, bounded and without Chromium repeats', async () => {
  const release = holdLoad(1);
  const resultPromise = serviceModule
    .getVisualPreviewService()
    .preview({ prepared, width: 720, imageBudgetBytes: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const contents = windows[0]?.webContents;
  const agent = contents?.mainFrame.framesInSubtree[0];
  const nested = new MockFrame();
  nested.frameTreeNodeId = 44;
  nested.parent = { frameTreeNodeId: 33, parent: { frameTreeNodeId: 22 } };
  contents?.mainFrame.framesInSubtree.push(nested);
  const event = (
    frame: unknown,
    message: string,
    level = 'error',
    lineNumber = 7,
  ) => ({ frame, message, level, lineNumber, sourceId: 'agent.js' });
  // The shell, an unknown frame, and a frame nested in the visual are not it.
  contents?.emit('console-message', event({ frameTreeNodeId: 1 }, 'shell'));
  contents?.emit('console-message', event({ frameTreeNodeId: 999 }, 'other'));
  contents?.emit('console-message', event(nested, 'nested frame'));
  // Electron attributes console API calls in the visual to the relay frame,
  // and Chromium's own messages (CSP, uncaught errors) to the agent frame.
  contents?.emit(
    'console-message',
    event({ frameTreeNodeId: 22 }, 'from console.log', 'info'),
  );
  contents?.emit('console-message', event(agent, 'Uncaught Error: boom'));
  // Both CSP layers report the same violation, so it arrives twice.
  const csp = (url: string, directive: string): string =>
    `Loading the image '${url}' violates the following Content Security Policy directive: "${directive}". The action has been blocked.`;
  for (let repeat = 0; repeat < 2; repeat++)
    contents?.emit(
      'console-message',
      event(agent, csp('http://127.0.0.1:9/y.png', 'img-src data: blob:')),
    );
  contents?.emit(
    'console-message',
    event(
      agent,
      `Refused to load 'https://old.test/x' because it violates the following Content Security Policy directive: "script-src 'unsafe-inline'"`,
    ),
  );
  release();
  const result = await resultPromise;
  expect(result.console.map((item) => [item.level, item.message])).toEqual([
    ['info', 'from console.log'],
    ['error', 'Uncaught Error: boom'],
    ['error', csp('http://127.0.0.1:9/y.png', 'img-src data: blob:')],
    [
      'error',
      `Refused to load 'https://old.test/x' because it violates the following Content Security Policy directive: "script-src 'unsafe-inline'"`,
    ],
  ]);
  expect(result.cspViolations).toEqual([
    { directive: 'img-src', blockedUri: 'http://127.0.0.1:9/y.png' },
    { directive: 'script-src', blockedUri: 'https://old.test/x' },
  ]);
});

it('bounds console and CSP reports', async () => {
  const release = holdLoad(1);
  const resultPromise = serviceModule
    .getVisualPreviewService()
    .preview({ prepared, width: 720, imageBudgetBytes: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const contents = windows[0]?.webContents;
  const agent = contents?.mainFrame.framesInSubtree[0];
  const event = (message: string) => ({
    frame: agent,
    message,
    level: 'error',
    lineNumber: 7,
    sourceId: 'agent.js',
  });
  for (let index = 0; index < 110; index++)
    contents?.emit('console-message', event(`Uncaught error ${index}`));
  for (let index = 0; index < 60; index++)
    contents?.emit(
      'console-message',
      event(
        `Loading the image 'https://evil.test/${index}' violates the following Content Security Policy directive: "img-src data:". The action has been blocked.`,
      ),
    );
  release();
  const result = await resultPromise;
  expect(result.console).toHaveLength(100);
  expect(result.omitted.console).toBe(70);
  expect(result.cspViolations).toHaveLength(50);
  expect(result.omitted.cspViolations).toBe(10);
});

it('expires a waiter in the queue and frees its place', async () => {
  const releaseA = holdLoad(1);
  const releaseB = holdLoad(2);
  const service = serviceModule.getVisualPreviewService();
  const a = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const b = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const queued = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 20,
  });
  expect((await queued).status).toBe('timeout');
  expect(windows).toHaveLength(2);
  const replacement = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  releaseA();
  releaseB();
  expect((await a).status).toBe('ok');
  expect((await b).status).toBe('ok');
  expect((await replacement).status).toBe('ok');
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it.each(['unresponsive', 'closed'])(
  'settles on %s and releases its slot',
  async (kind) => {
    holdLoad(1);
    const service = serviceModule.getVisualPreviewService();
    const pending = service.measure({
      prepared,
      widths: [360],
      maxHeight: 2000,
      deadlineMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    windows[0]?.emit(kind);
    expect((await pending).status).toBe('error');
    expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
    expect(
      (
        await service.measure({
          prepared,
          widths: [360],
          maxHeight: 2000,
          deadlineMs: 1000,
        })
      ).status,
    ).toBe('ok');
  },
);

it('destroys active windows and settles queued work before quit', async () => {
  holdLoad(1);
  holdLoad(2);
  const service = serviceModule.getVisualPreviewService();
  const a = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const b = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  const queued = service.measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.emit('before-quit');
  expect((await a).status).toBe('error');
  expect((await b).status).toBe('error');
  expect((await queued).status).toBe('error');
  expect(windows.every((window) => window.destroyed)).toBe(true);
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it('downscales analytically, normalizes to CSS pixels, and never goes below 240px', () => {
  const widths: number[] = [];
  const makeImage = (width: number) => ({
    getSize: () => ({ width, height: Math.round(width / 2) }),
    resize: ({ width: next }: { width: number }) => {
      widths.push(next);
      return makeImage(next);
    },
    toPNG: () => Buffer.alloc(width > 300 ? 200_000 : 200),
    toJPEG: () => Buffer.alloc(width > 300 ? 200_000 : 200),
  });
  const result = serviceModule.encodeForBudget(
    makeImage(1440) as never,
    1000,
    720,
    360,
  );
  expect(widths[0]).toBe(720);
  expect(widths.every((width) => width >= 240)).toBe(true);
  expect(result.image?.width).toBe(240);
  expect(result.image?.bytes).toBeLessThanOrEqual(1000);
});

it('does not attribute a blocked request after its run unregisters', async () => {
  const result = await serviceModule
    .getVisualPreviewService()
    .preview({ prepared, width: 720, imageBudgetBytes: 0 });
  const callback = jest.fn();
  requestListener?.({ url: 'file:///tmp/late', webContentsId: 1 }, callback);
  expect(callback).toHaveBeenCalledWith({ cancel: true });
  expect(result.blockedRequests).toEqual([]);
});

it('resizes the relay frame with CSS lengths so each width is really measured', async () => {
  await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360, 720],
    maxHeight: 400,
    deadlineMs: 3000,
  });
  const programs = windows[0]?.webContents.executeJavaScript.mock.calls
    .map(([code]: [string]) => code)
    .filter((code: string) => code.startsWith('document.querySelector'));
  // A bare number is not a CSS length; the frame would keep its first width.
  expect(programs).toEqual([
    expect.stringMatching(/width\s*=\s*'360px'.*height\s*=\s*'400px'/),
    expect.stringMatching(/width\s*=\s*'720px'.*height\s*=\s*'400px'/),
  ]);
  await serviceModule.getVisualPreviewService().preview({
    prepared,
    width: 720,
    imageBudgetBytes: 1000,
  });
  const captureResize = windows[1]?.webContents.executeJavaScript.mock.calls
    .map(([code]: [string]) => code)
    .find((code: string) => code.startsWith('document.querySelector'));
  expect(captureResize).toMatch(/height\s*=\s*'120px'/);
});

it('reports a timeout when a page step outlasts the deadline', async () => {
  // The agent settle would resolve only after the deadline has passed.
  agentSettleDelayMs = 60;
  const result = await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 30,
  });
  expect(result.status).toBe('timeout');
});

it('settles with expressions that return only true, whatever the page does to Promise', async () => {
  await serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360],
    maxHeight: 400,
    deadlineMs: 3000,
  });
  const frame = windows[0]?.webContents.mainFrame.framesInSubtree[0];
  const settle = frame?.executeJavaScript.mock.calls
    .map((call) => call[0])
    .find((code: string) => !code.includes('documentHeight()'));
  const shell = windows[0]?.webContents.executeJavaScript.mock.calls
    .map(([code]: [string]) => code)
    .find(
      (code: string) =>
        !code.includes('document.write(') && !code.includes('querySelector'),
    );
  for (const program of [settle, shell]) {
    // An async function's result is a native promise for its return value.
    expect(program).toMatch(/^\(async \(\) => \{/);
    expect(program).toMatch(/return true;\s*\}\)\(\)$/);
  }
});

it('fails at once when the visual has navigated away from its document', async () => {
  // A blocked self-navigation leaves the agent frame on an error page whose
  // URL is the blocked address; waiting for about:srcdoc would burn the
  // whole deadline.
  const release = holdLoad(1);
  const started = Date.now();
  const pending = serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360],
    maxHeight: 400,
    deadlineMs: 3000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = windows[0]?.webContents.mainFrame.framesInSubtree[0];
  if (!frame) throw new Error('Missing frame');
  frame.url = 'http://127.0.0.1:9/self';
  release();
  expect(await pending).toEqual({ status: 'error', heights: [] });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it('fails at once when the visual navigates away while it settles', async () => {
  // A script running in a frame that then navigates never answers. Without a
  // watch on the frame, the run would wait out its whole deadline and report
  // a timeout.
  agentSettleDelayMs = 60_000;
  const started = Date.now();
  const pending = serviceModule.getVisualPreviewService().measure({
    prepared,
    widths: [360],
    maxHeight: 400,
    deadlineMs: 3000,
  });
  const frame = await new Promise<MockFrame>((resolve) => {
    const poll = (): void => {
      const candidate = windows[0]?.webContents.mainFrame.framesInSubtree[0];
      if (candidate && candidate.executeJavaScript.mock.calls.length > 0)
        resolve(candidate);
      else setTimeout(poll, 5);
    };
    poll();
  });
  frame.url = 'http://127.0.0.1:9/self';
  expect(await pending).toEqual({ status: 'error', heights: [] });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(0);
});

it('hands a freed slot to the waiter, so a new caller cannot make a third window', async () => {
  const releaseA = holdLoad(1);
  holdLoad(2);
  // The waiter's window and the newcomer's, if either is admitted.
  holdLoad(3);
  holdLoad(4);
  const service = serviceModule.getVisualPreviewService();
  const request = {
    prepared,
    widths: [360],
    maxHeight: 2000,
    deadlineMs: 1000,
  };
  const a = service.measure(request);
  void service.measure(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  void service.measure(request); // waits for a slot
  releaseA();
  await a;
  // The caller of the finished run acts before the waiter has resumed.
  void service.measure(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(windows.filter((window) => !window.destroyed)).toHaveLength(2);
  expect(serviceModule.getVisualPreviewWindowCount()).toBe(2);
  // Let the held runs end so later tests start clean.
  await new Promise((resolve) => setTimeout(resolve, 1100));
});
