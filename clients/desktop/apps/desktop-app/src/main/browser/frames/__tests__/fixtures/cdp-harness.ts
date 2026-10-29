/**
 * Shared headless-Chromium harness for the fixture recorder and the live
 * probe (neither is a CI test). It drives Playwright's Chromium through CDP
 * the way BrowserService drives Electron's debugger: the root session is
 * `''`, out-of-process frames get their own session, DOM is enabled with
 * whitespace before any document request, and the real browser-view preload
 * runs in an isolated world of the main frame only.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
} from 'playwright-core';
import { PageModelHost } from '../../page-model-host';

export const PRELOAD_WORLD = 'canopy-probe-preload';
const REPO_ROOT = path.resolve(__dirname, '../../../../../../../..');
const FORWARDED_EVENTS = [
  'Page.frameNavigated',
  'Page.frameDetached',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'DOM.documentUpdated',
  'DOM.setChildNodes',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'DOM.shadowRootPushed',
  'DOM.shadowRootPopped',
];

/** Playwright's typed session, used through its untyped protocol surface. */
interface RawCDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): unknown;
  detach(): Promise<void>;
}

/** Exposes Playwright's protocol-typed session through string methods. */
function rawSession(session: CDPSession): RawCDPSession {
  const send = session.send.bind(session);
  const on = session.on.bind(session);
  return {
    send: async (method, params): Promise<unknown> => {
      const result: unknown = await Reflect.apply(send, undefined, [
        method,
        params,
      ]);
      return result;
    },
    on: (event, listener): unknown =>
      Reflect.apply(on, undefined, [event, listener]),
    detach: () => session.detach(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let preloadSource: Promise<string> | undefined;

/** The real preload, bundled for an isolated world, main frame only. */
export function bundledPreload(): Promise<string> {
  preloadSource ??= build({
    entryPoints: [
      path.join(REPO_ROOT, 'apps/desktop-app/src/preload/browser-view.ts'),
    ],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    tsconfig: path.join(REPO_ROOT, 'tsconfig.json'),
    alias: { electron: path.join(__dirname, 'preload-electron-stub.ts') },
    logLevel: 'silent',
  }).then((result) => {
    const code = result.outputFiles[0]?.text;
    if (!code) throw new Error('The preload bundle is empty.');
    return `if (window.top === window) {\n${code}\n}`;
  });
  return preloadSource;
}

export interface HarnessPage {
  page: Page;
  host: PageModelHost;
  /** Root session is `''`; out-of-process frames use `oopif-<n>`. */
  send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  sessionIds(): string[];
  /** Re-attaches out-of-process frames and refreshes the frame registry. */
  syncFrames(): Promise<void>;
  close(): Promise<void>;
}

export async function launchHarness(): Promise<Browser> {
  // Electron isolates cross-site frames; the headless shell does not by
  // default, so out-of-process frames need the switch.
  return chromium.launch({ headless: true, args: ['--site-per-process'] });
}

export interface HarnessOptions {
  whitespace?: boolean;
  preload?: boolean;
  /**
   * Document-start trackers: registered on each session before its next
   * document (`early`, as at attach in production), after the page loaded
   * (`late`), or not at all.
   */
  trackers?: 'early' | 'late' | 'none';
  /** Execution contexts of these worlds are never reported to the host. */
  dropWorlds?: string[];
  /** Sees every host request Chromium answered, with its response. */
  observe?: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
    response: unknown,
  ) => void;
  /** Answers a host request instead of Chromium (failure injection). */
  intercept?: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => Promise<unknown> | undefined;
  /** Extra events to listen for on every session, reported to `onEvent`. */
  events?: string[];
  /** Every forwarded or extra event, with the session it arrived on. */
  onEvent?: (method: string, params: unknown, sessionId: string) => void;
}

export async function openHarnessPage(
  browser: Browser,
  target: { url: string } | { html: string },
  options: HarnessOptions = {},
): Promise<HarnessPage> {
  const trackers = options.trackers ?? 'none';
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const rootSession = rawSession(await page.context().newCDPSession(page));
  const sessions = new Map<string, RawCDPSession>([['', rootSession]]);
  const hostSend = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    const intercepted = options.intercept?.(method, params, sessionId ?? '');
    if (intercepted) return intercepted;
    const session = sessions.get(sessionId ?? '');
    if (!session) return Promise.reject(new Error('No session with given id'));
    return session.send(method, params).then((response) => {
      options.observe?.(method, params, sessionId ?? '', response);
      return response;
    });
  };
  const host = new PageModelHost({ now: Date.now, send: hostSend });
  const forward = (session: RawCDPSession, sessionId: string): void => {
    for (const event of options.events ?? []) {
      if (FORWARDED_EVENTS.includes(event)) continue;
      session.on(event, (params) =>
        options.onEvent?.(event, params, sessionId),
      );
    }
    for (const event of FORWARDED_EVENTS) {
      session.on(event, (params) => {
        options.onEvent?.(event, params, sessionId);
        if (
          event === 'Runtime.executionContextCreated' &&
          isRecord(params) &&
          isRecord(params.context) &&
          typeof params.context.name === 'string' &&
          options.dropWorlds?.includes(params.context.name)
        ) {
          return;
        }
        host.noteEvent(event, params, sessionId);
      });
    }
  };
  const enable = async (session: RawCDPSession): Promise<void> => {
    // The first DOM.enable on a session decides whether whitespace-only text
    // nodes are reported, so it must carry includeWhitespace.
    await session.send(
      'DOM.enable',
      options.whitespace === false ? {} : { includeWhitespace: 'all' },
    );
    await session.send('Runtime.enable');
    await session.send('Page.enable');
  };
  forward(rootSession, '');
  await enable(rootSession);
  if (trackers === 'early') await host.installTrackers('');
  if (options.preload !== false) {
    // The preload asks Electron to run its main-world tracker source at
    // document start (E4); in Chromium its stub relays the source here.
    await rootSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('canopy-probe-main-world', (event) => { if (typeof event.detail === 'string') (0, eval)(event.detail); });`,
    });
    await rootSession.send('Page.addScriptToEvaluateOnNewDocument', {
      source: await bundledPreload(),
      worldName: PRELOAD_WORLD,
    });
  }
  if ('url' in target) await page.goto(target.url, { waitUntil: 'load' });
  else await page.setContent(target.html, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  if (trackers === 'late') await host.installTrackers('');

  let oopifCount = 0;
  const attachedFrames = new Set<string>();
  const syncFrames = async (): Promise<void> => {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let child: RawCDPSession;
      try {
        child = rawSession(await page.context().newCDPSession(frame));
      } catch {
        continue; // A same-process frame shares the root session.
      }
      const tree = await child.send('Page.getFrameTree');
      const frameId =
        isRecord(tree) &&
        isRecord(tree.frameTree) &&
        isRecord(tree.frameTree.frame)
          ? tree.frameTree.frame.id
          : undefined;
      if (typeof frameId !== 'string' || attachedFrames.has(frameId)) {
        await child.detach();
        continue;
      }
      attachedFrames.add(frameId);
      oopifCount += 1;
      const sessionId = `oopif-${oopifCount}`;
      sessions.set(sessionId, child);
      forward(child, sessionId);
      host.noteEvent(
        'Target.attachedToTarget',
        {
          sessionId,
          targetInfo: { targetId: frameId, type: 'iframe', url: frame.url() },
        },
        '',
      );
      await enable(child);
      // Its current document predates the trackers (D4); later ones not.
      if (trackers !== 'none') await host.installTrackers(sessionId);
    }
    await host.discoverFrames('');
    for (const sessionId of Array.from(sessions.keys())) {
      if (sessionId !== '') await host.discoverFrames(sessionId);
    }
  };
  await syncFrames();

  return {
    page,
    host,
    send: hostSend,
    sessionIds: () => Array.from(sessions.keys()),
    syncFrames,
    close: async (): Promise<void> => {
      host.dispose();
      await page.close();
    },
  };
}

/**
 * Serves the recorded fixture pages whose names match `pattern` on a
 * cross-site pair of loopback origins (`__CHILD_ORIGIN__` is replaced).
 */
export async function serveRecordedPages(
  pattern: RegExp,
): Promise<{ origin: string; childOrigin: string; close: () => void }> {
  const directory = path.join(__dirname, 'recorded');
  let childOrigin = '';
  const serve = (): Server =>
    createServer((request, response) => {
      const name = path.basename(
        new URL(request.url ?? '/', 'http://probe').pathname,
      );
      if (!pattern.test(name)) {
        response.writeHead(404).end();
        return;
      }
      const html = readFileSync(path.join(directory, name), 'utf8')
        .split('__CHILD_ORIGIN__')
        .join(childOrigin);
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
  const listen = (server: Server, host: string): Promise<string> =>
    new Promise((resolve) => {
      server.listen(0, host, () => {
        const address = server.address();
        resolve(
          address && typeof address !== 'string'
            ? `http://${host}:${address.port}`
            : '',
        );
      });
    });
  const main = serve();
  const child = serve();
  const origin = await listen(main, '127.0.0.1');
  childOrigin = await listen(child, 'localhost');
  return {
    origin,
    childOrigin,
    close: (): void => {
      main.close();
      child.close();
    },
  };
}

/** The page metadata the host projects, read the way the preload reads it. */
export async function pageMetadata(harness: HarnessPage): Promise<{
  browserId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeMode: 'light' | 'dark';
}> {
  const value: unknown = await harness.page.evaluate(() => ({
    url: location.href,
    title: document.title,
    width: innerWidth,
    height: innerHeight,
    deviceScaleFactor: devicePixelRatio || 1,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
  }));
  const record = isRecord(value) ? value : {};
  const number = (entry: unknown, fallback: number): number =>
    typeof entry === 'number' ? entry : fallback;
  return {
    browserId: 'probe',
    url: typeof record.url === 'string' ? record.url : '',
    title: typeof record.title === 'string' ? record.title : '',
    viewport: {
      width: number(record.width, 0),
      height: number(record.height, 0),
      deviceScaleFactor: number(record.deviceScaleFactor, 1),
    },
    themeMode: record.dark === true ? 'dark' : 'light',
  };
}
