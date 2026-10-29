/**
 * Live probe for phase 04b stage S2b (not a CI test), in Playwright's
 * headless Chromium through the real PageModelHost:
 *
 * - `--shadow`: trusted clicks, positioned clicks, targeted Enter and Tab
 *   on controls in open and closed shadow roots (review R2 finding 4), and
 *   a sibling covering a control inside its own root.
 * - `--dom-disabled`: which commands the target paths send still work
 *   while the DOM domain is disabled (review R2 question 6).
 *
 *   node_modules/.bin/tsx apps/desktop-app/src/main/browser/frames/__tests__/fixtures/live-probe-s2b.ts --shadow|--dom-disabled
 */
import type { ActionLaneContext } from '../../../actions/action-lane';
import { checkActionability } from '../../../actions/actionability';
import { dispatchTargetedPress } from '../../../actions/input-dispatch';
import {
  buildKeyEventSequence,
  parseKeyCombo,
} from '../../../actions/key-definitions';
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

/** Every root's controls log the trusted input they receive. */
const PAGE = `<!doctype html><html><body style="margin:20px">
<div id="open-host"></div>
<div id="closed-host" style="margin-top:20px"></div>
<script>
  window.__inputs = [];
  const log = (event) => window.__inputs.push({ type: event.type, id: event.composedPath()[0].id, trusted: event.isTrusted, key: event.key });
  for (const [hostId, mode] of [['open-host', 'open'], ['closed-host', 'closed']]) {
    const root = document.getElementById(hostId).attachShadow({ mode });
    root.innerHTML = '<style>.wrap{position:relative;width:240px;height:40px}.cover{position:absolute;inset:0;background:rgba(0,0,0,.2);display:none}</style><div class="wrap"><input id="' + mode + '-field" aria-label="' + mode + ' field" style="width:200px"><div class="cover" id="' + mode + '-cover"></div></div><button id="' + mode + '-next">' + mode + ' next</button>';
    for (const type of ['pointerdown', 'keydown', 'focus']) root.addEventListener(type, log, true);
    if (mode === 'closed') window.__closedRoot = root;
  }
  window.__cover = (mode, on) => { const root = mode === 'open' ? document.getElementById('open-host').shadowRoot : window.__closedRoot; root.getElementById(mode + '-cover').style.display = on ? 'block' : 'none'; };
</script></body></html>`;

async function inputs(harness: HarnessPage): Promise<unknown> {
  return harness.page.evaluate(
    '(() => { const log = window.__inputs; window.__inputs = []; return log; })()',
  );
}

function lane(): ActionLaneContext {
  return {
    signal: new AbortController().signal,
    sequence: 1,
    beginDispatch: (): void => undefined,
    trackCommand: <T>(command: Promise<T>): Promise<T> => command,
    registerCleanup: (): void => undefined,
  };
}

async function resolve(
  harness: HarnessPage,
  name: string,
): Promise<ResolvedActionTarget> {
  const resolution = await harness.host.resolveActionTarget({
    kind: 'locator',
    locator: `page.locator('#${name.replace(' ', '-')}')`,
  });
  if (resolution.status !== 'found')
    throw new Error(`${name}: ${resolution.status} ${resolution.message}`);
  return resolution.target;
}

async function click(
  harness: HarnessPage,
  point: { x: number; y: number },
): Promise<void> {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await harness.send('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  await harness.page.waitForTimeout(50);
}

async function probeShadow(): Promise<void> {
  const browser = await launchHarness();
  try {
    const harness = await openHarnessPage(
      browser,
      { html: PAGE },
      { trackers: 'early' },
    );
    try {
      for (const mode of ['open', 'closed'] as const) {
        const target = await resolve(harness, `${mode} field`);
        const check = (position?: {
          x: number;
          y: number;
        }): ReturnType<typeof checkActionability> =>
          checkActionability({
            send: (method, params, session) =>
              harness.send(method, params, session ?? ''),
            sessionId: '',
            objectId: target.objectId,
            backendNodeId: target.identity.backendNodeId,
            action: 'click',
            timeoutMs: 1_000,
            ...(position ? { position } : {}),
            frameMapping: () => harness.host.documentMapping(target),
            outerHitTest: (point) => harness.host.outerHitTest(target, point),
          });
        await inputs(harness);
        const ready = await check();
        if (ready.status === 'ready' && ready.point)
          await click(harness, ready.point);
        write(
          `SHADOW ${mode} click: ${JSON.stringify(ready)} received=${JSON.stringify(await inputs(harness))}`,
        );
        const positioned = await check({ x: 6, y: 6 });
        if (positioned.status === 'ready' && positioned.point)
          await click(harness, positioned.point);
        write(
          `SHADOW ${mode} positioned click: ${JSON.stringify(positioned)} received=${JSON.stringify(await inputs(harness))}`,
        );
        await harness.page.evaluate(`window.__cover('${mode}', true)`);
        write(
          `SHADOW ${mode} covered by a sibling in its root: ${JSON.stringify(await check())} positioned=${JSON.stringify(await check({ x: 6, y: 6 }))}`,
        );
        await harness.page.evaluate(`window.__cover('${mode}', false)`);
        for (const key of ['Enter', 'Tab']) {
          const combo = parseKeyCombo(key, 'linux');
          if (!combo.ok) throw new Error(key);
          await inputs(harness);
          const pressed = await dispatchTargetedPress({
            send: (method, params, session) =>
              harness.send(method, params, session ?? ''),
            objectId: target.objectId,
            events: buildKeyEventSequence(combo, 'linux'),
            lane: lane(),
            syntheticFallback: () => Promise.resolve(),
          });
          await harness.page.waitForTimeout(50);
          write(
            `SHADOW ${mode} targeted ${key}: ${JSON.stringify(pressed)} received=${JSON.stringify(await inputs(harness))}`,
          );
        }
        await harness.host.releaseActionTarget(target);
      }
    } finally {
      await harness.close();
    }
  } finally {
    await browser.close();
  }
}

/** Commands the target paths send, with the DOM domain disabled. */
async function probeDomDisabled(): Promise<void> {
  const browser = await launchHarness();
  try {
    const harness = await openHarnessPage(
      browser,
      { html: PAGE },
      { trackers: 'early' },
    );
    try {
      const target = await resolve(harness, 'open field');
      const backendNodeId = target.identity.backendNodeId;
      await harness.send('DOM.disable', {});
      const attempt = async (
        method: string,
        params: Record<string, unknown>,
      ): Promise<string> => {
        try {
          const response = await harness.send(method, params);
          return isRecord(response) && 'exceptionDetails' in response
            ? 'exception'
            : 'ok';
        } catch (error) {
          return `error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
        }
      };
      const results: Record<string, string> = {
        'DOM.resolveNode': await attempt('DOM.resolveNode', { backendNodeId }),
        'DOM.describeNode': await attempt('DOM.describeNode', {
          backendNodeId,
          depth: 1,
          pierce: true,
        }),
        'DOM.getBoxModel': await attempt('DOM.getBoxModel', { backendNodeId }),
        'DOM.getContentQuads': await attempt('DOM.getContentQuads', {
          backendNodeId,
        }),
        'DOM.scrollIntoViewIfNeeded': await attempt(
          'DOM.scrollIntoViewIfNeeded',
          { backendNodeId },
        ),
        'DOM.getNodeForLocation': await attempt('DOM.getNodeForLocation', {
          x: 30,
          y: 30,
        }),
        'DOM.focus (object)': await attempt('DOM.focus', {
          objectId: target.objectId,
        }),
        'Runtime.callFunctionOn (retained object)': await attempt(
          'Runtime.callFunctionOn',
          {
            objectId: target.objectId,
            functionDeclaration: 'function() { return this.isConnected; }',
            returnByValue: true,
          },
        ),
        'Page.getLayoutMetrics': await attempt('Page.getLayoutMetrics', {}),
      };
      await harness.send('DOM.enable', { includeWhitespace: 'all' });
      for (const [method, result] of Object.entries(results))
        write(`DOM-DISABLED ${method}: ${result}`);
      await harness.host.releaseActionTarget(target);
    } finally {
      await harness.close();
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--shadow') await probeShadow();
  else if (mode === '--dom-disabled') await probeDomDisabled();
  else write('Usage: live-probe-s2b.ts --shadow|--dom-disabled');
}

void main().catch((error: unknown) => {
  write(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
