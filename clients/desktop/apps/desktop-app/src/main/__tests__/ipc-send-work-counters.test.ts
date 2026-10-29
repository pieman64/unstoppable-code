import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { serialize } from 'node:v8';
import ts from 'typescript';
import type { SendableBrowserWindow } from '../lib/window-send';

const windows: SendableBrowserWindow[] = [];

jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): SendableBrowserWindow[] => windows,
  },
}));

import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  sendToAllWindows,
  sendToWindow,
  sendToWindowDetailed,
} from '../lib/window-send';
import {
  ipcWindowLabel,
  registerIpcSurface,
  sendToWebContents,
} from '../lib/web-contents-send';

const MAIN_URL = 'file:///Applications/Canopy.app/renderer/index.html';
const APP_ADVISOR_URL = `${MAIN_URL}?surface=app-advisor`;

interface FakeWebContents {
  isCrashed(): boolean;
  isDestroyed(): boolean;
  mainFrame: { detached: boolean; isDestroyed(): boolean };
  send: jest.Mock<void, [string, ...unknown[]]>;
  getURL: jest.Mock<string, []>;
}

function makeWindow(
  url: string,
  options: { detached?: boolean; sendError?: Error } = {},
): { window: SendableBrowserWindow; webContents: FakeWebContents } {
  const webContents: FakeWebContents = {
    isCrashed: () => false,
    isDestroyed: () => false,
    mainFrame: {
      detached: options.detached ?? false,
      isDestroyed: () => false,
    },
    send: jest.fn<void, [string, ...unknown[]]>(() => {
      if (options.sendError) throw options.sendError;
    }),
    getURL: jest.fn<string, []>(() => url),
  };
  return { window: { isDestroyed: () => false, webContents }, webContents };
}

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value,
  });
}

describe('main → renderer IPC work counters', () => {
  beforeEach(() => {
    windows.length = 0;
    setE2eBuild(false);
    resetWorkCounters();
  });

  afterEach(() => {
    setE2eBuild(false);
  });

  it('counts every send path per channel and window', () => {
    const main = makeWindow(MAIN_URL);
    const advisor = makeWindow(APP_ADVISOR_URL);
    const aux = makeWindow('about:blank');
    windows.push(main.window, advisor.window, aux.window);

    expect(sendToWindow(main.window, 'helper:send', 1)).toBe(true);
    expect(sendToWindowDetailed(advisor.window, 'helper:detailed', 2)).toEqual({
      delivered: true,
    });
    sendToAllWindows('helper:broadcast', { value: 3 });
    sendToWebContents(main.webContents, 'direct:send', 'payload');

    expect(main.webContents.send).toHaveBeenCalledWith(
      'direct:send',
      'payload',
    );
    expect(snapshotWorkCounters().ipc).toEqual({
      'send.helper:send.main.messages': 1,
      'send.helper:detailed.app-advisor.messages': 1,
      'send.helper:broadcast.main.messages': 1,
      'send.helper:broadcast.app-advisor.messages': 1,
      'send.helper:broadcast.aux.messages': 1,
      'send.direct:send.main.messages': 1,
    });
  });

  it('counts only messages that were actually handed to Electron', () => {
    const detached = makeWindow(MAIN_URL, { detached: true });
    const disposed = makeWindow(MAIN_URL, {
      sendError: new Error('Render frame was disposed before access'),
    });
    const failing = makeWindow(MAIN_URL, {
      sendError: new Error('An object could not be cloned'),
    });

    expect(sendToWindow(null, 'missing:window')).toBe(false);
    expect(sendToWindow(detached.window, 'detached:window')).toBe(false);
    expect(sendToWindow(disposed.window, 'disposed:frame')).toBe(false);
    expect(() => sendToWindow(failing.window, 'clone:error')).toThrow(
      'An object could not be cloned',
    );
    // The wrapper keeps a direct site's exception exactly as it was.
    expect(() =>
      sendToWebContents(failing.webContents, 'direct:error', 1),
    ).toThrow('An object could not be cloned');

    expect(snapshotWorkCounters().ipc).toEqual({});
  });

  it('labels windows by the renderer surface they load and caches each label', () => {
    const main = makeWindow(MAIN_URL);
    const browser = makeWindow('https://example.com/page');
    const loading = makeWindow('');

    expect(ipcWindowLabel(main.webContents)).toBe('main');
    expect(ipcWindowLabel(main.webContents)).toBe('main');
    expect(main.webContents.getURL).toHaveBeenCalledTimes(1);
    expect(ipcWindowLabel(makeWindow(APP_ADVISOR_URL).webContents)).toBe(
      'app-advisor',
    );
    expect(ipcWindowLabel(makeWindow('about:blank').webContents)).toBe('aux');
    expect(ipcWindowLabel(browser.webContents)).toBe('browser');
    expect(ipcWindowLabel({ send: jest.fn() })).toBe('unknown');

    // A window that has not committed a URL yet is looked up again later.
    expect(ipcWindowLabel(loading.webContents)).toBe('unknown');
    loading.webContents.getURL.mockReturnValue(MAIN_URL);
    expect(ipcWindowLabel(loading.webContents)).toBe('main');

    const destroyed = makeWindow(MAIN_URL);
    destroyed.webContents.getURL.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    expect(ipcWindowLabel(destroyed.webContents)).toBe('unknown');
  });

  it('labels the renderer scheme pages like their file:// pages', () => {
    expect(
      ipcWindowLabel(
        makeWindow('app-renderer://bundle/index.html').webContents,
      ),
    ).toBe('main');
    expect(
      ipcWindowLabel(
        makeWindow('app-renderer://bundle/app-advisor.html?surface=app-advisor')
          .webContents,
      ),
    ).toBe('app-advisor');
    expect(
      ipcWindowLabel(makeWindow('app-renderer://evil/index.html').webContents),
    ).toBe('browser');
  });

  it('labels a registered surface by its role, even before it navigates', () => {
    const main = makeWindow('about:blank');
    const browser = makeWindow('about:blank');
    registerIpcSurface(main.webContents, 'main');
    registerIpcSurface(browser.webContents, 'browser');

    expect(ipcWindowLabel(main.webContents)).toBe('main');
    expect(ipcWindowLabel(browser.webContents)).toBe('browser');
    // Navigation never changes a registered surface's label.
    browser.webContents.getURL.mockReturnValue(MAIN_URL);
    expect(ipcWindowLabel(browser.webContents)).toBe('browser');
  });

  it('never caches the about:blank label every window starts with', () => {
    const early = makeWindow('about:blank');

    expect(ipcWindowLabel(early.webContents)).toBe('aux');
    early.webContents.getURL.mockReturnValue(MAIN_URL);
    expect(ipcWindowLabel(early.webContents)).toBe('main');
  });

  it('adds estimated payload bytes in E2E builds when the harness asks', () => {
    const main = makeWindow(MAIN_URL);
    const payload = { type: 'chat', text: 'hello' };
    setE2eBuild(true);
    resetWorkCounters({ estimateIpcBytes: true });

    sendToWindow(main.window, 'chat:event', payload);
    sendToWebContents(main.webContents, 'chat:event', payload);

    expect(snapshotWorkCounters().ipc).toEqual({
      'send.chat:event.main.messages': 2,
      'send.chat:event.main.bytes': serialize([payload]).byteLength * 2,
    });
  });
});

describe('main → renderer send path audit', () => {
  const mainRoot = join(__dirname, '..');
  const wrapper = join('lib', 'web-contents-send.ts');

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory())
        return name === '__tests__' ? [] : sourceFiles(path);
      return name.endsWith('.ts') ? [path] : [];
    });
  }

  // Every `send` member in main that is not an Electron main → renderer
  // send, keyed by file and receiver. A new one either goes through
  // `sendToWebContents` or is added here with the reason it is not Electron.
  const NON_ELECTRON_SENDS: ReadonlyArray<[string, string]> = [
    // The Codex app-server JSON-RPC connection.
    [join('codex', 'app-server-client.ts'), 'this.connection'],
    // The broadcaster's own batching method.
    [join('pipelines', 'pipeline-execution-event-broadcaster.ts'), 'this'],
    // The injected HTTP transport.
    [join('services', 'personal-catalog-sync-service.ts'), 'this.deps'],
    // A campaign decision's boolean `send` field.
    [join('notifications', 'campaigns', 'scheduler.ts'), 'decision'],
    // The browser action modules' injected CDP command sender.
    [join('browser', 'actions', 'actionability.ts'), 'options'],
    [join('browser', 'actions', 'effects.ts'), 'options'],
    [join('browser', 'actions', 'input-dispatch.ts'), 'options'],
    [join('browser', 'actions', 'hover.ts'), 'options'],
    [join('browser', 'actions', 'type.ts'), 'options'],
    [join('browser', 'actions', 'fill.ts'), 'options'],
    [join('browser', 'actions', 'set-checked.ts'), 'options'],
    [join('browser', 'actions', 'select-option.ts'), 'options'],
    [join('browser', 'actions', 'click-control.ts'), 'options'],
    [join('browser', 'actions', 'scroll.ts'), 'options'],
    [join('browser', 'actions', 'drag.ts'), 'options'],
    [join('browser', 'actions', 'print-bridge.ts'), 'deps'],
    // The browser page model's injected CDP command sender.
    [join('browser', 'frames', 'locators.ts'), 'deps'],
    [join('browser', 'frames', 'page-model-cdp.ts'), 'deps'],
    [join('browser', 'frames', 'page-model-host.ts'), 'this.deps'],
    [join('browser', 'frames', 'page-model-host.ts'), 'deps'],
    [join('browser', 'frames', 'page-model-styles.ts'), 'deps'],
    [join('browser', 'frames', 'action-targets.ts'), 'deps'],
    [join('browser', 'frames', 'target-state.ts'), 'deps'],
    [join('browser', 'frames', 'wait-probe.ts'), 'deps'],
    [join('browser', 'frames', 'tracker-host.ts'), 'this.deps'],
    [join('browser', 'frames', 'dom-tracking.ts'), 'this.deps'],
    [join('browser', 'frames', 'frame-hit-test.ts'), 'deps'],
    [join('browser', 'frames', 'input-recorder.ts'), 'deps'],
    [join('browser', 'frames', 'scroll-state.ts'), 'deps'],
    // The Ledger host posts a request to its Node storage worker.
    [join('ledger', 'storage-host.ts'), 'this'],
    // The W5 commit log host posts a request to its worker.
    [join('w5-commit-log', 'commit-log-host.ts'), 'this'],
    // L0 CanopyFramedConnection.send, not a WebContents send.
    [
      join('canopy-runtime', 'renderer-relay', 'interim-in-memory-binding.ts'),
      'this.server',
    ],
    // L0 CanopyFramedConnection.send, not a WebContents send.
    [
      join('canopy-runtime', 'renderer-relay', 'interim-in-memory-binding.ts'),
      'client',
    ],
    // The device relay WebSocket (device-to-device remote control).
    [join('remote-control', 'transport', 'relay-client.ts'), 'socket'],
  ];

  /** `send` member accesses and bindings, whatever the receiver is named. */
  function sendMembers(path: string): { receiver: string; line: number }[] {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const found: { receiver: string; line: number }[] = [];
    const record = (node: ts.Node, receiver: string): void => {
      found.push({
        receiver,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'send' &&
        // `typeof x.send` only checks that a send exists.
        !ts.isTypeOfExpression(node.parent)
      )
        record(node, node.expression.getText(source));
      else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'send'
      )
        record(node, node.expression.getText(source));
      else if (
        ts.isBindingElement(node) &&
        (node.propertyName ?? node.name).getText(source) === 'send'
      )
        record(node, '{ send } destructuring');
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('routes every WebContents send, under any receiver name, through the counting wrapper', () => {
    const direct = sourceFiles(mainRoot)
      .map((path) => relative(mainRoot, path))
      .filter((file) => file !== wrapper)
      .flatMap((file) =>
        sendMembers(join(mainRoot, file))
          .filter(
            ({ receiver }) =>
              !NON_ELECTRON_SENDS.some(
                ([allowedFile, allowedReceiver]) =>
                  allowedFile === file && allowedReceiver === receiver,
              ),
          )
          .map(({ receiver, line }) => `${file}:${line} (${receiver})`),
      );

    expect(direct).toEqual([]);
  }, 60_000);

  it('detects a send through an aliased or destructured receiver', () => {
    const fixture = join(tmpdir(), `send-audit-${process.pid}.ts`);
    writeFileSync(
      fixture,
      [
        'contents.send("a:b");',
        'target?.send("a:b");',
        'const { send } = win.webContents;',
        'const bound = win["send"];',
        'if (typeof win.webContents.send === "function") {}',
      ].join('\n'),
    );
    try {
      // The `typeof` guard on line 5 only checks that a send exists.
      expect(sendMembers(fixture)).toEqual([
        { receiver: 'contents', line: 1 },
        { receiver: 'target', line: 2 },
        { receiver: '{ send } destructuring', line: 3 },
        { receiver: 'win', line: 4 },
      ]);
    } finally {
      rmSync(fixture, { force: true });
    }
  });
});
