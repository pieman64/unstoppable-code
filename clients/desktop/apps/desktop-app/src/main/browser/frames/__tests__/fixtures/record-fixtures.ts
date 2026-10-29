/**
 * Records the raw CDP responses the page model consumes for each fixture page
 * in `recorded/`, using Playwright's headless Chromium (not a CI step). The
 * page model runs through the real host bridges (password history, style
 * reads) with the real preload in its isolated world, and every response it
 * consumes is written beside the page as `<name>.json`. Run from the
 * repository root:
 *
 *   node_modules/.bin/tsx apps/desktop-app/src/main/browser/frames/__tests__/fixtures/record-fixtures.ts [name]
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { parseLocator } from '@canopy/desktop-shared/browser/locator-grammar';
import { evaluateLocator } from '../../locators';
import type { ControlHistory, TrackerMemory } from '../../model-types';
import { buildPageModel } from '../../page-model';
import { projectInputSnapshot } from '../../projections';
import { launchHarness, openHarnessPage } from './cdp-harness';
import { generatedLocators } from './generated-locators';
import { measureFrames } from './transform-truth';
import {
  RECORDED_METHODS,
  RECORDING_VERSION,
  type Recording,
  type RecordedBridgeCall,
  type RecordedHistoryCall,
  type RecordedSummaryCall,
  type RecordedMainWorld,
  type RecordedResponse,
} from './recorded-cdp';

interface FixtureSpec {
  name: string;
  accessibility?: boolean;
  /** CSS locators whose `DOM.querySelectorAll` responses are recorded. */
  selectors?: string[];
  /** Records with DOM enabled without whitespace, for the repair check. */
  withoutWhitespace?: boolean;
  /** Also records page-reported geometry (see `transform-truth.ts`). */
  measure?: boolean;
  /** Records Chromium's answer for every locator the model generates. */
  roundTrip?: boolean;
  /** Runs the optional listener stage and records its scans. */
  listeners?: boolean;
  /** Registers the document-start trackers before the page loads. */
  trackers?: boolean;
  /** An iframe re-navigated before recording, so its new document is tracked. */
  renavigate?: string;
  /** Resolves every row's center point and maps out-of-process rows up. */
  targeting?: boolean;
}

const FIXTURES: FixtureSpec[] = [
  {
    name: 'form-controls',
    accessibility: true,
    selectors: ['#email', 'label > input', 'button'],
  },
  { name: 'lists-pseudo', selectors: ['li > a', 'li'] },
  {
    name: 'shadow',
    roundTrip: true,
    selectors: ['#note', 'button', '#slotted-input', 'input', '#deep'],
  },
  {
    name: 'frames',
    accessibility: true,
    roundTrip: true,
    selectors: ['#frame-name', 'button', 'iframe'],
  },
  { name: 'hidden' },
  { name: 'secrets', accessibility: true, selectors: ['#password', 'select'] },
  { name: 'oopif', roundTrip: true, selectors: ['button', '#child-name'] },
  { name: 'transforms', measure: true },
  { name: 'listeners', listeners: true },
  {
    name: 'trackers',
    trackers: true,
    renavigate: '#cross',
    targeting: true,
    selectors: ['#open-plain', 'input', 'textarea'],
  },
];

const DIRECTORY = path.join(__dirname, 'recorded');

function listen(server: Server, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('No server address.'));
        return;
      }
      resolve(`http://${host}:${address.port}`);
    });
  });
}

function fixtureServer(childOrigin: () => string): Server {
  return createServer((request, response) => {
    const name = path.basename(
      new URL(request.url ?? '/', 'http://x').pathname,
    );
    if (!/^[a-z-]+\.html$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const html = readFileSync(path.join(DIRECTORY, name), 'utf8')
        .split('__CHILD_ORIGIN__')
        .join(childOrigin());
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    } catch {
      response.writeHead(404).end();
    }
  });
}

function stableParams(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

async function recordFixture(
  spec: FixtureSpec,
  origin: string,
  browserVersion: string,
  browser: Awaited<ReturnType<typeof launchHarness>>,
): Promise<number> {
  const responses: RecordedResponse[] = [];
  const seen = new Set<string>();
  const record = (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
    response: unknown,
  ): void => {
    const key = `${method}\u0000${sessionId}\u0000${stableParams(params)}`;
    if (RECORDED_METHODS.includes(method) && !seen.has(key)) {
      seen.add(key);
      responses.push({ method, sessionId, params, response });
    }
  };
  const harness = await openHarnessPage(
    browser,
    { url: `${origin}/${spec.name}.html` },
    {
      whitespace: spec.withoutWhitespace !== true,
      trackers: spec.trackers === true ? 'early' : 'none',
      observe: record,
    },
  );
  try {
    await harness.page.waitForTimeout(400);
    await harness.syncFrames();
    if (spec.renavigate) {
      // Its first document predates its session's trackers (D4); the next
      // one is tracked from its start.
      await harness.page.evaluate(
        `(() => { const frame = document.querySelector(${JSON.stringify(spec.renavigate)}); frame.src = frame.src + '?tracked'; })()`,
      );
      await harness.page.waitForTimeout(800);
      await harness.syncFrames();
    }
    const send = (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> => harness.send(method, params, sessionId);
    const styles: RecordedBridgeCall<
      Array<{ display: string; visibility: string } | undefined> | undefined
    >[] = [];
    const passwordHistory: RecordedBridgeCall<boolean[]>[] = [];
    const mainWorlds: RecordedMainWorld[] = [];
    const controlHistory: RecordedHistoryCall[] = [];
    const controlSummaries: RecordedSummaryCall[] = [];
    const group = `canopy-recorder-${randomUUID()}`;
    const sessions = new Set<string>();
    const model = await buildPageModel(
      {
        registry: harness.host.registry,
        now: Date.now,
        send,
        isPasswordEverSeen: async (
          frameId,
          sessionId,
          backendNodeIds,
          purpose,
        ) => {
          const result = await harness.host.isPasswordEverSeen(
            frameId,
            sessionId,
            backendNodeIds,
            purpose,
          );
          passwordHistory.push({ frameId, sessionId, backendNodeIds, result });
          return result;
        },
        readStyles: async (frameId, sessionId, backendNodeIds) => {
          const result = await harness.host.readStyles(
            frameId,
            sessionId,
            backendNodeIds,
            group,
            sessions,
          );
          styles.push({ frameId, sessionId, backendNodeIds, result });
          return result;
        },
        ...(spec.trackers === true
          ? {
              controlHistory: async (
                frameId: string,
                sessionId: string,
                scope: 'light' | 'shadow',
                backendNodeIds: number[],
              ): Promise<ControlHistory[] | undefined> => {
                const result = await harness.host.trackerHistory(
                  frameId,
                  sessionId,
                  scope,
                  backendNodeIds,
                );
                if (result !== undefined)
                  controlHistory.push({
                    frameId,
                    sessionId,
                    scope,
                    backendNodeIds,
                    result,
                  });
                return result;
              },
              controlHistorySummary: async (
                frameId: string,
                sessionId: string,
                scope: 'light' | 'shadow',
              ): Promise<TrackerMemory> => {
                const result = await harness.host.trackerSummary(
                  frameId,
                  sessionId,
                  scope,
                );
                controlSummaries.push({ frameId, sessionId, scope, result });
                return result;
              },
            }
          : {}),
        mainWorldContextId: (frameId, sessionId) => {
          const contextId = harness.host.mainWorldContextId(frameId, sessionId);
          mainWorlds.push({
            frameId,
            sessionId,
            ...(contextId === undefined ? {} : { contextId }),
          });
          return contextId;
        },
      },
      {
        accessibility: spec.accessibility === true,
        listeners: spec.listeners === true,
      },
    );
    for (const selector of spec.selectors ?? []) {
      await evaluateLocator(
        model,
        { send },
        { kind: 'css', selector, explicit: true },
      );
    }
    // Real answers for every locator the model generates, so the round-trip
    // test replays Chromium rather than the model's own CSS matching.
    const generated = spec.roundTrip ? await generatedLocators(model) : [];
    for (const entry of generated) {
      const parsed = parseLocator(entry.locator);
      if (parsed.kind === 'invalid') continue;
      await evaluateLocator(model, { send }, parsed, undefined, {
        ...(entry.source === 'inspect' ? { purpose: 'inspect' } : {}),
      }).catch(() => undefined);
    }
    if (spec.targeting) {
      const rows = projectInputSnapshot(
        model,
        { browserId: 'recorder', limit: 100 },
        { browserId: 'recorder', url: '', title: '' },
      ).inputs;
      for (const row of rows) {
        const x = row.bounds.x + row.bounds.width / 2;
        const y = row.bounds.y + row.bounds.height / 2;
        const resolved = await harness.host.resolveActionTarget({
          kind: 'point',
          x,
          y,
        });
        if (resolved.status === 'found')
          await harness.host.releaseActionTarget(resolved.target);
        const identity = model.registry.resolveRef(row.ref);
        const frame = model.frames.find(
          (candidate) => candidate.frameRef === row.frameRef,
        );
        if (!identity || !frame || identity.sessionId === '') continue;
        const transform = frame.viewportTransform;
        await harness.host.mapToAncestors(
          { identity },
          {
            x: (x - transform.x) / transform.scaleX,
            y: (y - transform.y) / transform.scaleY,
          },
        );
      }
    }
    const recording: Recording = {
      version: RECORDING_VERSION,
      name: spec.name,
      chromium: browserVersion,
      whitespace: spec.withoutWhitespace !== true,
      frames: harness.host.registry.frames().map((frame) => ({
        frameId: frame.frameId,
        sessionId: frame.sessionId,
        loaderId: frame.loaderId,
        url: frame.url,
        ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      })),
      responses,
      styles,
      passwordHistory,
      ...(spec.measure
        ? { measurements: await measureFrames(harness.page) }
        : {}),
      ...(mainWorlds.length > 0 ? { mainWorlds } : {}),
      ...(spec.trackers === true ? { controlHistory, controlSummaries } : {}),
    };
    const suffix = spec.withoutWhitespace ? '.no-whitespace' : '';
    const file = path.join(DIRECTORY, `${spec.name}${suffix}.json`);
    const text = `${JSON.stringify(recording)}\n`;
    writeFileSync(file, text);
    return text.length;
  } finally {
    await harness.close();
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  let childOrigin = '';
  const mainServer = fixtureServer(() => childOrigin);
  const childServer = fixtureServer(() => childOrigin);
  const origin = await listen(mainServer, '127.0.0.1');
  childOrigin = await listen(childServer, 'localhost');
  const browser = await launchHarness();
  try {
    const specs = [
      ...FIXTURES,
      { name: 'form-controls', withoutWhitespace: true },
    ];
    for (const spec of specs) {
      if (only && spec.name !== only) continue;
      const size = await recordFixture(
        spec,
        origin,
        browser.version(),
        browser,
      );
      process.stdout.write(
        `${spec.name}${spec.withoutWhitespace ? ' (no whitespace)' : ''}: ${size} bytes\n`,
      );
    }
  } finally {
    await browser.close();
    mainServer.close();
    childServer.close();
  }
}

void main().catch((error: unknown) => {
  process.stdout.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
