/**
 * Live probe for phase 04b stage S2 (not a CI test): the action pipeline's
 * coordinate rule, the cross-document hit test, input delivery and dialogs
 * in frames, and the DOM tracking lifecycle, through the real PageModelHost
 * and actionability in Playwright's headless Chromium (site-per-process).
 * Run from the repository root:
 *
 *   node_modules/.bin/tsx apps/desktop-app/src/main/browser/frames/__tests__/fixtures/live-probe-s2.ts
 */
import { createServer, type Server } from 'node:http';
import { checkActionability } from '../../../actions/actionability';
import {
  captureEffectBaseline,
  collectBrowserEffects,
} from '../../../actions/effects';
import type { ResolvedActionTarget } from '../../action-targets';
import {
  launchHarness,
  openHarnessPage,
  type HarnessPage,
} from './cdp-harness';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Every document logs trusted input it receives, in its own coordinates. */
const LOGGER = `<script>
  window.__inputs = [];
  for (const type of ['pointerdown', 'click', 'keydown']) {
    addEventListener(type, (event) => {
      window.__inputs.push({
        type,
        id: event.target && event.target.id,
        trusted: event.isTrusted,
        x: event.clientX,
        y: event.clientY,
        key: event.key,
      });
    }, true);
  }
</script>`;

function pages(child: string): Record<string, string> {
  const same = `<body style='margin:9px'><div style='height:40px'></div><button id=same-btn>Same</button>${LOGGER.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}</body>`;
  const deep = `<body style='margin:5px'><button id=deep-btn>Deep</button>${LOGGER.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}</body>`;
  return {
    '/main.html': `<!doctype html><html><body style="margin:0;height:2400px">
      <div style="height:150px"></div>
      <button id="main-btn" style="margin-left:40px">Main</button>
      <div style="height:20px"></div>
      <iframe id="same" style="border:7px solid #555;padding:5px;margin-left:30px;width:300px;height:150px;display:block" srcdoc="${same}"></iframe>
      <iframe id="cross" style="border:4px solid #555;padding:3px;margin-left:50px;width:360px;height:260px;display:block" src="${child}/child.html"></iframe>
      <div style="position:relative;height:200px">
        <iframe id="scaled" style="border:2px solid #555;width:300px;height:150px;transform:scale(1.5);transform-origin:0 0;position:absolute;left:20px;top:10px" src="${child}/child-scaled.html"></iframe>
      </div>
      ${LOGGER}</body></html>`,
    '/child.html': `<!doctype html><html><body style="margin:6px">
      <div style="height:30px"></div>
      <button id="child-btn">Child</button>
      <input id="child-input">
      <button id="alert-btn" onclick="alert('from child')">Alert</button>
      <iframe id="child-same" style="border:3px solid #999;margin-left:20px;width:200px;height:60px;display:block" srcdoc="${deep}"></iframe>
      <div style="height:600px"></div>
      ${LOGGER}</body></html>`,
    '/child-scaled.html': `<!doctype html><html><body style="margin:6px">
      <div style="height:30px"></div>
      <button id="child-btn">Child</button>
      ${LOGGER}</body></html>`,
    '/mutating.html': `<!doctype html><html><body>
      <div id="ticker">0</div>
      <script>let n = 0; setInterval(() => { document.getElementById('ticker').textContent = String(++n); }, 16);</script>
      ${Array.from({ length: 400 }, (_, index) => `<p>Row ${index} <input value="v${index}"></p>`).join('')}
      </body></html>`,
  };
}

async function serve(): Promise<{ origin: string; close: () => void }> {
  let childOrigin = '';
  const handler = (path: string): string | undefined =>
    pages(childOrigin)[path];
  const make = (): Server =>
    createServer((request, response) => {
      const html = handler(new URL(request.url ?? '/', 'http://x').pathname);
      if (html === undefined) response.writeHead(404).end();
      else response.writeHead(200, { 'content-type': 'text/html' }).end(html);
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
  const main = make();
  const child = make();
  const origin = await listen(main, '127.0.0.1');
  childOrigin = await listen(child, 'localhost');
  return {
    origin,
    close: (): void => {
      main.close();
      child.close();
    },
  };
}

async function inputsOf(
  harness: HarnessPage,
  target: ResolvedActionTarget,
): Promise<unknown> {
  const response = await harness.send(
    'Runtime.callFunctionOn',
    {
      objectId: target.objectId,
      functionDeclaration:
        'function() { const w = this.ownerDocument.defaultView; const log = w.__inputs || []; w.__inputs = []; return log; }',
      returnByValue: true,
    },
    target.identity.sessionId,
  );
  return isRecord(response) && isRecord(response.result)
    ? response.result.value
    : undefined;
}

async function resolve(
  harness: HarnessPage,
  locator: string,
  frame?: string,
): Promise<ResolvedActionTarget> {
  const resolution = await harness.host.resolveActionTarget({
    kind: 'locator',
    locator,
    ...(frame === undefined ? {} : { frame }),
  });
  if (resolution.status !== 'found')
    throw new Error(`${locator}: ${resolution.status} ${resolution.message}`);
  return resolution.target;
}

async function click(
  harness: HarnessPage,
  point: { x: number; y: number },
  sessionId: string,
): Promise<void> {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await harness.send(
      'Input.dispatchMouseEvent',
      {
        type,
        x: point.x,
        y: point.y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      },
      sessionId,
    );
  }
  await harness.page.waitForTimeout(60);
}

/**
 * The coordinate rule: actionability's ready point for each target, the
 * click dispatched there in the target's own session, and what the
 * target's document received.
 */
async function coordinateCase(harness: HarnessPage): Promise<void> {
  await harness.page.evaluate('window.scrollTo(0, 60)');
  await harness.page.waitForTimeout(100);
  // Which coordinates DOM.getNodeForLocation takes on a scrolled page.
  const main = await resolve(harness, "page.locator('#main-btn')");
  const rect = await harness.send(
    'Runtime.callFunctionOn',
    {
      objectId: main.objectId,
      functionDeclaration:
        'function() { const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, sx: scrollX, sy: scrollY }; }',
      returnByValue: true,
    },
    '',
  );
  const center =
    isRecord(rect) && isRecord(rect.result) && isRecord(rect.result.value)
      ? rect.result.value
      : {};
  const hitAt = async (x: number, y: number): Promise<string> => {
    const hit = await harness
      .send(
        'DOM.getNodeForLocation',
        { x: Math.round(x), y: Math.round(y) },
        '',
      )
      .catch((error: unknown) => String(error));
    return isRecord(hit) && hit.backendNodeId === main.identity.backendNodeId
      ? 'target'
      : JSON.stringify(hit);
  };
  const cx = Number(center.x);
  const cy = Number(center.y);
  write(
    `HITTEST scrolled main (scrollY=${String(center.sy)}): viewport point -> ${await hitAt(cx, cy)}; document point -> ${await hitAt(cx + Number(center.sx), cy + Number(center.sy))}`,
  );
  await harness.host.releaseActionTarget(main);
  // The same in an out-of-process frame's session, its document scrolled.
  const child = await resolve(harness, "page.locator('#child-btn')", '#cross');
  const childSession = child.identity.sessionId;
  await harness.send(
    'Runtime.evaluate',
    { expression: 'window.scrollTo(0, 25)' },
    childSession,
  );
  await harness.page.waitForTimeout(80);
  const childRect = await harness.send(
    'Runtime.callFunctionOn',
    {
      objectId: child.objectId,
      functionDeclaration:
        'function() { const r = this.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, sx: scrollX, sy: scrollY }; }',
      returnByValue: true,
    },
    childSession,
  );
  const childCenter =
    isRecord(childRect) &&
    isRecord(childRect.result) &&
    isRecord(childRect.result.value)
      ? childRect.result.value
      : {};
  const metrics = await harness
    .send('Page.getLayoutMetrics', {}, childSession)
    .catch((error: unknown) => String(error));
  const rootMetrics = await harness.send('Page.getLayoutMetrics', {}, '');
  const childHit = async (x: number, y: number): Promise<string> => {
    const hit = await harness
      .send(
        'DOM.getNodeForLocation',
        { x: Math.round(x), y: Math.round(y) },
        childSession,
      )
      .catch((error: unknown) => String(error));
    return isRecord(hit) && hit.backendNodeId === child.identity.backendNodeId
      ? 'target'
      : JSON.stringify(hit);
  };
  const ccx = Number(childCenter.x);
  const ccy = Number(childCenter.y);
  write(
    `HITTEST scrolled out-of-process (scrollY=${String(childCenter.sy)}): viewport point -> ${await childHit(ccx, ccy)}; document point -> ${await childHit(ccx + Number(childCenter.sx), ccy + Number(childCenter.sy))}`,
  );
  const viewportOf = (value: unknown): string =>
    isRecord(value)
      ? JSON.stringify({
          layout: value.cssLayoutViewport,
          visual: value.cssVisualViewport,
        })
      : String(value);
  write(`METRICS child session: ${viewportOf(metrics)}`);
  write(`METRICS root session: ${viewportOf(rootMetrics)}`);
  await harness.send(
    'Runtime.evaluate',
    { expression: 'window.scrollTo(0, 0)' },
    childSession,
  );
  await harness.host.releaseActionTarget(child);
  const cases: Array<[string, string, string | undefined]> = [
    ['main', "page.locator('#main-btn')", undefined],
    ['same-process', "page.locator('#same-btn')", '#same'],
    ['out-of-process', "page.locator('#child-btn')", '#cross'],
    [
      'same-process in out-of-process',
      "page.locator('#deep-btn')",
      '#child-same',
    ],
    ['scaled out-of-process', "page.locator('#child-btn')", '#scaled'],
  ];
  for (const [label, locator, frame] of cases) {
    let target: ResolvedActionTarget;
    try {
      target = await resolve(harness, locator, frame);
    } catch (error) {
      write(`COORD ${label}: ${String(error)}`);
      continue;
    }
    const sessionId = target.identity.sessionId;
    const actionable = await checkActionability({
      send: (method, params, session) =>
        harness.send(method, params, session ?? sessionId),
      sessionId,
      objectId: target.objectId,
      backendNodeId: target.identity.backendNodeId,
      action: 'click',
      timeoutMs: 2_000,
      frameMapping: () => harness.host.documentMapping(target),
      outerHitTest: (point) => harness.host.outerHitTest(target, point),
    });
    await inputsOf(harness, target);
    let delivered: unknown = 'not dispatched';
    if (actionable.status === 'ready' && actionable.point) {
      await click(harness, actionable.point, sessionId);
      delivered = await inputsOf(harness, target);
    }
    write(
      `COORD ${label}: session=${sessionId === '' ? 'root' : 'child'} ${JSON.stringify(actionable)} received=${JSON.stringify(delivered)}`,
    );
    await harness.host.releaseActionTarget(target);
  }
  await harness.page.evaluate('window.scrollTo(0, 0)');
}

/** An overlay in the main document over an out-of-process frame (D9). */
async function overlayCase(harness: HarnessPage): Promise<void> {
  await harness.page.evaluate(`(() => {
    const frame = document.querySelector('#cross');
    const box = frame.getBoundingClientRect();
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.className = 'overlay sheet';
    cover.style.cssText = 'position:absolute;background:rgba(0,0,0,.2);left:' + (box.left + scrollX) + 'px;top:' + (box.top + scrollY) + 'px;width:' + box.width + 'px;height:' + box.height + 'px';
    document.body.append(cover);
  })()`);
  await harness.page.waitForTimeout(50);
  for (const [label, locator, frame] of [
    ['out-of-process', "page.locator('#child-btn')", '#cross'],
    [
      'same-process in out-of-process',
      "page.locator('#deep-btn')",
      '#child-same',
    ],
  ] as const) {
    const target = await resolve(harness, locator, frame);
    const actionable = await checkActionability({
      send: (method, params, session) =>
        harness.send(method, params, session ?? target.identity.sessionId),
      sessionId: target.identity.sessionId,
      objectId: target.objectId,
      backendNodeId: target.identity.backendNodeId,
      action: 'click',
      timeoutMs: 2_000,
      frameMapping: () => harness.host.documentMapping(target),
      outerHitTest: (point) => harness.host.outerHitTest(target, point),
    });
    write(`COVER ${label}: ${JSON.stringify(actionable)}`);
    await harness.host.releaseActionTarget(target);
  }
  await harness.page.evaluate("document.querySelector('#cover').remove()");
}

/** Keys sent to an out-of-process frame's own session after DOM.focus. */
async function keyboardCase(harness: HarnessPage): Promise<void> {
  const target = await resolve(
    harness,
    "page.locator('#child-input')",
    '#cross',
  );
  const sessionId = target.identity.sessionId;
  await harness.send('DOM.focus', { objectId: target.objectId }, sessionId);
  await inputsOf(harness, target);
  for (const type of ['keyDown', 'keyUp']) {
    await harness.send(
      'Input.dispatchKeyEvent',
      {
        type,
        key: 'q',
        code: 'KeyQ',
        windowsVirtualKeyCode: 81,
        ...(type === 'keyDown' ? { text: 'q' } : {}),
      },
      sessionId,
    );
  }
  await harness.page.waitForTimeout(50);
  const value = await harness.send(
    'Runtime.callFunctionOn',
    {
      objectId: target.objectId,
      functionDeclaration: 'function() { return this.value; }',
      returnByValue: true,
    },
    sessionId,
  );
  write(
    `KEYS out-of-process session: value=${JSON.stringify(isRecord(value) && isRecord(value.result) ? value.result.value : value)} received=${JSON.stringify(await inputsOf(harness, target))}`,
  );
  await harness.host.releaseActionTarget(target);
}

/** The input recorder the action pipeline arms in a frame target's document. */
async function recorderCase(harness: HarnessPage): Promise<void> {
  for (const [label, locator, frame] of [
    ['same-process', "page.locator('#same-btn')", '#same'],
    ['out-of-process', "page.locator('#child-btn')", '#cross'],
  ] as const) {
    const target = await resolve(harness, locator, frame);
    const recorder = await harness.host.armInputRecorder(target);
    if (!recorder) {
      write(`RECORDER ${label}: unavailable`);
      continue;
    }
    const actionable = await checkActionability({
      send: (method, params, session) =>
        harness.send(method, params, session ?? target.identity.sessionId),
      sessionId: target.identity.sessionId,
      objectId: target.objectId,
      backendNodeId: target.identity.backendNodeId,
      action: 'click',
      timeoutMs: 2_000,
      frameMapping: () => harness.host.documentMapping(target),
      outerHitTest: (point) => harness.host.outerHitTest(target, point),
    });
    if (actionable.status === 'ready' && actionable.point)
      await click(harness, actionable.point, target.identity.sessionId);
    write(`RECORDER ${label}: ${JSON.stringify(await recorder.read())}`);
    await recorder.dispose();
    await harness.host.releaseActionTarget(target);
  }
}

async function probeFrames(): Promise<void> {
  const { origin, close } = await serve();
  const browser = await launchHarness();
  const dialogs: string[] = [];
  try {
    const harness = await openHarnessPage(
      browser,
      { url: `${origin}/main.html` },
      {
        trackers: 'early',
        preload: false,
        events: ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed'],
        onEvent: (method, params, sessionId) => {
          if (method.startsWith('Page.javascriptDialog'))
            dialogs.push(
              `${method} session=${sessionId === '' ? 'root' : 'child'} frameId=${isRecord(params) ? String(params.frameId) : '?'}`,
            );
        },
      },
    );
    try {
      await harness.page.waitForTimeout(400);
      await harness.syncFrames();
      await coordinateCase(harness);
      await overlayCase(harness);
      await keyboardCase(harness);
      await recorderCase(harness);
      // Playwright dismisses the dialog itself; only its reporting is probed.
      harness.page.on('dialog', (dialog) => {
        void dialog.dismiss();
      });
      const alert = await resolve(
        harness,
        "page.locator('#alert-btn')",
        '#cross',
      );
      await harness.send(
        'Runtime.callFunctionOn',
        {
          objectId: alert.objectId,
          functionDeclaration:
            'function() { setTimeout(() => this.click(), 0); }',
        },
        alert.identity.sessionId,
      );
      await harness.page.waitForTimeout(300);
      write(`DIALOG out-of-process alert: ${dialogs.join('; ') || 'none'}`);
      await harness.host.releaseActionTarget(alert);
    } finally {
      await harness.close();
    }
  } finally {
    await browser.close();
    close();
  }
}

/** DOM events reaching the main process with tracking on and released. */
async function probeTracking(): Promise<void> {
  const { origin, close } = await serve();
  const browser = await launchHarness();
  try {
    let events = 0;
    let lastEventAt: number | undefined;
    const listeners = new Set<() => void>();
    const harness = await openHarnessPage(
      browser,
      { url: `${origin}/mutating.html` },
      {
        trackers: 'early',
        preload: false,
        onEvent: (method) => {
          if (method.startsWith('DOM.')) {
            events += 1;
            lastEventAt = Date.now();
          }
          listeners.forEach((listener) => listener());
        },
      },
    );
    /** The action pipeline's settle and effects after a no-op dispatch. */
    const effects = async (label: string): Promise<void> => {
      const send = (
        method: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ): Promise<unknown> => harness.send(method, params, sessionId);
      const before = await captureEffectBaseline({
        send,
        mutationCount: () => events,
      });
      const startedAt = Date.now();
      const result = await collectBrowserEffects({
        send,
        before,
        startedAt,
        timeoutMs: 5_000,
        mutationCount: () => events,
        lastMutationAt: () => lastEventAt,
        subscribeSettle: (listener) => {
          listeners.add(listener);
          return (): void => {
            listeners.delete(listener);
          };
        },
      });
      write(
        `EFFECTS ${label}: settle=${Date.now() - startedAt} ms domChanged=${String(result.domChanged)}`,
      );
    };
    try {
      const count = async (ms: number): Promise<number> => {
        const before = events;
        await harness.page.waitForTimeout(ms);
        return events - before;
      };
      write(`TRACK initial (attach only): ${await count(1_000)} DOM events/s`);
      await effects('tracking off (phase 04 production: no pierced document)');
      let started = Date.now();
      await harness.host.establishTracking();
      write(`TRACK establish: ${Date.now() - started} ms`);
      write(`TRACK on: ${await count(1_000)} DOM events/s`);
      await effects('tracking on');
      const built = Date.now();
      await harness.host.build({ cache: 'bypass' });
      write(`TRACK build while on: ${Date.now() - built} ms`);
      started = Date.now();
      // The host releases after its idle period; wait it out.
      await harness.page.waitForTimeout(harness.host.trackingIdleMs + 300);
      write(
        `TRACK state after idle: ${harness.host.trackingState} (waited ${Date.now() - started} ms)`,
      );
      write(`TRACK released: ${await count(1_000)} DOM events/s`);
      started = Date.now();
      await harness.host.establishTracking();
      write(`TRACK re-establish: ${Date.now() - started} ms`);
      write(`TRACK on again: ${await count(1_000)} DOM events/s`);
    } finally {
      await harness.close();
    }
  } finally {
    await browser.close();
    close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--tracking') await probeTracking();
  else await probeFrames();
}

void main().catch((error: unknown) => {
  write(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
