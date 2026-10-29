/**
 * Live probe (not a CI test): builds the page model through the real
 * PageModelHost against Browser Lab pages in Playwright's headless Chromium
 * and reports rows, build timings, listener hits, seeded-secret leaks and
 * a locator round trip for each page. Its comparison with the preload's
 * snapshot and inspect went with those commands (phase 04b S4); parity is
 * pinned by `page-model-preload-parity.test.ts`. Run from the repository
 * root:
 *
 *   node_modules/.bin/tsx apps/desktop-app/src/main/browser/frames/__tests__/fixtures/live-probe.ts [path-filter]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLocator } from '@canopy/desktop-shared/browser/locator-grammar';
import type {
  BrowserInputSnapshotResponse,
  BrowserRectangle,
} from '@canopy/desktop-shared/types/browser';
import type { NodeIdentity } from '../../frame-registry';
import type { BrowserPageModel } from '../../model-types';
import { evaluateLocator } from '../../locators';
import { projectInputSnapshot, projectInspect } from '../../projections';
import {
  launchHarness,
  openHarnessPage,
  pageMetadata,
  serveRecordedPages,
  type HarnessPage,
} from './cdp-harness';
import { expectedTopLevelRect, measureFrames } from './transform-truth';

const STRUCTURED_PAGES = new Set([
  '/browser-lab/frames',
  '/browser-lab/frames/nested/1',
  '/browser-lab/frames/nested/2',
  '/browser-lab/shadow',
  '/browser-lab/heavy',
  '/browser-lab/upload',
  '/browser-lab/dialog-surfaces',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface LabModule {
  cases: unknown[];
  listen: () => Promise<unknown>;
}

async function loadLab(): Promise<LabModule> {
  const file = path.resolve(
    'apps/desktop-app/tests/electron/mock-server/routes/browser-lab.mjs',
  );
  const lab: unknown = await import(pathToFileURL(file).href);
  if (
    !isRecord(lab) ||
    typeof lab.listenPairedBrowserLabServers !== 'function'
  ) {
    throw new Error('Browser Lab module is missing.');
  }
  const listen = lab.listenPairedBrowserLabServers;
  const cases = [lab.BROWSER_LAB_CASES, lab.BROWSER_LAB_INTERACTION_CASES]
    .filter(Array.isArray)
    .flat();
  return {
    cases,
    listen: async (): Promise<unknown> => {
      const result: unknown = await Reflect.apply(listen, undefined, []);
      return result;
    },
  };
}

function pagePaths(cases: unknown[]): string[] {
  const paths = ['/browser-lab', '/browser-lab/interaction'];
  for (const entry of cases) {
    if (!isRecord(entry) || !Array.isArray(entry.pages)) continue;
    for (const page of entry.pages) {
      if (isRecord(page) && typeof page.path === 'string')
        paths.push(page.path);
    }
  }
  return Array.from(new Set(paths));
}

async function modelSnapshot(
  harness: HarnessPage,
  request: Record<string, unknown>,
): Promise<BrowserInputSnapshotResponse> {
  const metadata = await pageMetadata(harness);
  return harness.host.snapshot({ browserId: 'probe', ...request }, () =>
    Promise.resolve(metadata),
  );
}

/** Builds with the optional listener stage and reports its cost and hits. */
async function reportListeners(harness: HarnessPage): Promise<void> {
  const durations: number[] = [];
  let hits = 0;
  let skipped: string[] = [];
  for (let run = 0; run < 3; run += 1) {
    const { model } = await harness.host.build({
      cache: 'bypass',
      listeners: true,
    });
    durations.push(model.timings.listenersMs);
    hits = model.listeners.reduce(
      (total, frame) => total + frame.backendNodeIds.length,
      0,
    );
    skipped = model.listeners
      .map((frame) => frame.skipped)
      .filter((reason): reason is string => reason !== undefined);
  }
  const reasons = new Map<string, number>();
  for (const reason of skipped) {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  write(
    `  listeners: listenersMs=${durations.join(',')} hits=${hits} skipped=${JSON.stringify(Object.fromEntries(reasons))}`,
  );
}

/**
 * Evaluates every row locator, and every inspect candidate of those rows,
 * through the host's real CDP path and checks it returns exactly its node.
 * On `heavy`, main-frame light rows are sampled (the first 100).
 */
async function roundTrip(
  harness: HarnessPage,
  rows: BrowserInputSnapshotResponse['inputs'],
): Promise<void> {
  // A fresh build: the probe's bypass builds invalidated older frontend IDs.
  const { model } = await harness.host.build({ cache: 'bypass' });
  const started = performance.now();
  let projected = 0;
  for (let offset = 0; ; offset += 100) {
    const page = projectInputSnapshot(
      model,
      { browserId: 'probe', offset, limit: 100 },
      { browserId: 'probe', url: '', title: '' },
    );
    projected += page.returned;
    if (!page.truncated) break;
  }
  const projectionMs = Math.round(performance.now() - started);
  const sampled: BrowserInputSnapshotResponse['inputs'] = [];
  const failures: string[] = [];
  let checked = 0;
  const check = async (
    locator: string,
    identity: NodeIdentity,
    purpose: 'row' | 'inspect',
  ): Promise<void> => {
    checked += 1;
    const parsed = parseLocator(locator);
    if (parsed.kind === 'invalid') {
      failures.push(`${purpose} ${locator}: does not parse`);
      return;
    }
    const matches = await evaluateLocator(
      model,
      {
        send: (method, params, sessionId) =>
          harness.send(method, params, sessionId),
      },
      parsed,
      undefined,
      purpose === 'inspect' ? { purpose: 'inspect' } : {},
    );
    const only = matches[0];
    if (
      matches.length !== 1 ||
      !only ||
      only.frameId !== identity.frameId ||
      only.backendNodeId !== identity.backendNodeId
    ) {
      failures.push(`${purpose} ${locator}: ${matches.length} matches`);
    }
  };
  let withoutLocator = 0;
  let lightSampled = 0;
  // Each page is checked as soon as it is projected: a page with more rows
  // than the registry's 5,000 refs evicts the earliest ones later.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const page = projectInputSnapshot(
      model,
      { browserId: 'probe', offset, limit: 100 },
      { browserId: 'probe', url: '', title: '' },
    );
    for (const row of page.inputs) {
      const light = row.frameRef === undefined && !row.inShadowRoot;
      if (light) lightSampled += 1;
      if (light && lightSampled > 100) continue;
      sampled.push(row);
      const identity = model.registry.resolveRef(row.ref);
      if (!identity) {
        failures.push(`row ${row.ref}: unresolvable ref`);
        continue;
      }
      if (row.locator === undefined) withoutLocator += 1;
      else await check(row.locator, identity, 'row');
      const inspected = await projectInspect(model, identity, {
        enrich: () => Promise.resolve(null),
      });
      for (const candidate of inspected?.locatorCandidates ?? []) {
        await check(
          candidate.playwright ?? candidate.value,
          identity,
          'inspect',
        );
      }
    }
  }
  write(
    `  projection: ${projected} rows in ${projectionMs} ms; round trip: ${checked} locators checked on ${sampled.length} rows, ${failures.length} failures, ${withoutLocator} rows without a locator`,
  );
  for (const failure of failures.slice(0, 10)) write(`    ${failure}`);
  for (const row of sampled.filter((entry) => entry.locator === undefined)) {
    write(
      `    no locator: ${row.inShadowRoot ? 'shadow ' : ''}${row.frameRef === undefined ? 'main' : 'child'} ${row.tagName} name=${JSON.stringify(row.name ?? '')}`,
    );
  }
}

async function describePage(
  harness: HarnessPage,
  pagePath: string,
): Promise<void> {
  // Late frames and roots attach after load; give them a moment.
  if (STRUCTURED_PAGES.has(pagePath)) await harness.page.waitForTimeout(1_500);
  await harness.syncFrames();
  const modelInputs: BrowserInputSnapshotResponse['inputs'] = [];
  let model = await modelSnapshot(harness, { limit: 100 });
  for (let offset = 0; ; offset += 100) {
    model = await modelSnapshot(harness, { offset, limit: 100 });
    modelInputs.push(...model.inputs);
    if (!model.truncated) break;
  }
  // Top-document rows carry no frameRef (phase 04b S2b E1).
  const light = modelInputs.filter(
    (row) => row.frameRef === undefined && row.inShadowRoot !== true,
  );
  const timings: number[] = [];
  let lastBuild: Awaited<ReturnType<HarnessPage['host']['build']>> | undefined;
  for (let run = 0; run < 5; run += 1) {
    lastBuild = await harness.host.build({ cache: 'bypass' });
    timings.push(Math.round(lastBuild.durationMs));
  }
  write(
    `  builds(ms)=${timings.join(',')} last=${JSON.stringify(lastBuild?.model.timings)} styles=${JSON.stringify(lastBuild?.model.styleSupplement)}`,
  );
  await reportListeners(harness);
  const serialized = JSON.stringify(model);
  const leaked = Array.from(
    { length: 20 },
    (_, index) => `canopy-seeded-secret-${index + 1}`,
  ).filter((secret) => new RegExp(`${secret}(?!\\d)`).test(serialized));
  write(
    `PAGE ${pagePath} rows=${modelInputs.length} light=${light.length} ` +
      `frames=${JSON.stringify((model.frames ?? []).map((frame) => [frame.status, frame.reason ?? '', new URL(frame.url || 'about:blank').pathname]))}`,
  );
  write(
    `  shadow rows=${modelInputs.filter((row) => row.inShadowRoot).length} frame rows=${modelInputs.filter((row) => row.frameRef !== undefined).length}`,
  );
  const notes = Array.from(
    new Set(serialized.match(/canopy-visible-note-\d+(?!\d)/g) ?? []),
  ).sort();
  write(
    `  seeded secrets leaked: ${leaked.length === 0 ? 'none' : leaked.join(',')}; visible notes: ${JSON.stringify(notes)}`,
  );
  await roundTrip(harness, modelInputs);
  for (const row of modelInputs.slice(0, 60)) {
    write(
      `   ${row.frameRef === undefined ? 'main' : 'child'}${row.inShadowRoot ? '/shadow' : ''} ${row.tagName} ${row.role ?? ''} name=${JSON.stringify(row.name ?? '')} value=${JSON.stringify(row.value ?? (row.valueRedacted ? '<redacted>' : ''))} locator=${row.locator ?? ''}`,
    );
  }
}

/**
 * `--transforms`: loads the recorded `transforms` page live and checks every
 * child-frame button row against the page's own geometry, and that rotated
 * and mirrored owners (with the frames inside them) are omitted.
 */
async function probeTransforms(): Promise<void> {
  const { origin, close } = await serveRecordedPages(
    /^transforms[a-z-]*\.html$/,
  );
  const browser = await launchHarness();
  try {
    const harness = await openHarnessPage(browser, {
      url: `${origin}/transforms.html`,
    });
    await harness.page.waitForTimeout(500);
    await harness.syncFrames();
    const measurements = await measureFrames(harness.page);
    const { model } = await harness.host.build({ cache: 'bypass' });
    const rows = projectInputSnapshot(
      model,
      { browserId: 'probe', limit: 100 },
      { browserId: 'probe', url: '', title: '' },
    ).inputs;
    const byId = new Map<string, BrowserRectangle>();
    for (const row of rows) {
      const identity = model.registry.resolveRef(row.ref);
      const node = model.nodes.find(
        (candidate) =>
          identity !== undefined &&
          candidate.identity.frameId === identity.frameId &&
          candidate.identity.backendNodeId === identity.backendNodeId,
      );
      if (node?.attributes.id) byId.set(node.attributes.id, row.bounds);
    }
    const chains: Array<[string, string[]]> = [
      ['main-button', []],
      ['button-scaled', ['scaled']],
      ['button-in-scaled', ['in-scaled']],
      ['button-outer', ['outer']],
      ['button-nested-outer', ['outer', 'nested-outer']],
    ];
    for (const [id, owners] of chains) {
      const expected = expectedTopLevelRect(measurements, owners, id);
      const actual = byId.get(id);
      const worst = actual
        ? Math.max(
            Math.abs(actual.x - expected.x),
            Math.abs(actual.y - expected.y),
            Math.abs(actual.width - expected.width),
            Math.abs(actual.height - expected.height),
          )
        : Number.POSITIVE_INFINITY;
      write(
        `${worst <= 1 ? 'OK  ' : 'DIFF'} ${id} model=${JSON.stringify(actual)} page=${JSON.stringify(expected)}`,
      );
    }
    const omitted = model.coverage
      .filter((entry) => entry.reason === 'owner_transformed')
      .map((entry) => new URL(entry.url).pathname);
    const leaked = [
      'button-rotated',
      'button-nested-rotated',
      'button-mirrored',
    ].filter((id) => byId.has(id));
    write(
      `owner_transformed: ${JSON.stringify(omitted)}; rows from transformed frames: ${leaked.length === 0 ? 'none' : leaked.join(',')}`,
    );
    await harness.close();
  } finally {
    await browser.close();
    close();
  }
}

/** Element ids of a model's listener hits, sorted. */
function listenerHitIds(model: BrowserPageModel): string[] {
  const ids: string[] = [];
  for (const frame of model.listeners) {
    for (const backendNodeId of frame.backendNodeIds) {
      const node = model.nodes.find(
        (candidate) =>
          candidate.identity.sessionId === frame.sessionId &&
          candidate.identity.backendNodeId === backendNodeId,
      );
      ids.push(node?.attributes.id ?? `?${backendNodeId}`);
    }
  }
  return ids.sort();
}

/**
 * `--listeners`: the recorded `listeners` page live, then pages that attack
 * the main-world scan. Each must leave the build intact, report the frame
 * as skipped, and keep the page usable for the next build.
 */
async function probeListeners(): Promise<void> {
  const { origin, close } = await serveRecordedPages(
    /^listeners[a-z-]*\.html$/,
  );
  const browser = await launchHarness();
  try {
    const harness = await openHarnessPage(browser, {
      url: `${origin}/listeners.html`,
    });
    await harness.page.waitForTimeout(500);
    await harness.syncFrames();
    const { model } = await harness.host.build({
      cache: 'bypass',
      listeners: true,
    });
    const expected = [
      'click-target',
      'cross-target',
      'frame-target',
      'inline-target',
      'pointer-target',
      'shadow-target',
    ];
    const hits = listenerHitIds(model);
    write(
      `${JSON.stringify(hits) === JSON.stringify(expected) ? 'OK  ' : 'DIFF'} listeners page hits=${JSON.stringify(hits)} skipped=${JSON.stringify(model.listeners.map((frame) => frame.skipped ?? ''))} listenersMs=${model.timings.listenersMs}`,
    );
    await harness.close();

    const hostile: Array<[string, string]> = [
      [
        'shadowed getEventListeners that throws',
        "window.getEventListeners = () => { throw new Error('hostile'); };",
      ],
      [
        'shadowed getEventListeners returning getters',
        'window.getEventListeners = () => ({ get click() { return { length: 1e9 }; } });',
      ],
      [
        'querySelectorAll that never returns',
        'Document.prototype.querySelectorAll = function () { for (;;) {} };',
      ],
    ];
    for (const [label, script] of hostile) {
      const page = await openHarnessPage(
        browser,
        {
          html: `<!doctype html><body><button id="b">B</button><script>document.getElementById('b').addEventListener('click', () => {}); ${script}</script></body>`,
        },
        { preload: false },
      );
      const started = performance.now();
      let outcome: string;
      try {
        const built = await page.host.build({
          cache: 'bypass',
          listeners: true,
        });
        outcome = `rows=${built.model.nodes.length > 0} skipped=${JSON.stringify(built.model.listeners.map((frame) => frame.skipped ?? 'none'))} hits=${JSON.stringify(listenerHitIds(built.model))}`;
      } catch (error) {
        outcome = `BUILD THREW ${error instanceof Error ? error.message : String(error)}`;
      }
      const elapsedMs = Math.round(performance.now() - started);
      // The page must still answer: a later build without listeners works.
      const after = await page.host
        .build({ cache: 'bypass' })
        .then((built) => `next build ok, ${built.model.nodes.length} nodes`)
        .catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        );
      write(`HOSTILE ${label}: ${outcome} in ${elapsedMs} ms; ${after}`);
      await page.close();
    }
  } finally {
    await browser.close();
    close();
  }
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  if (filter === '--transforms') {
    await probeTransforms();
    return;
  }
  if (filter === '--listeners') {
    await probeListeners();
    return;
  }
  const lab = await loadLab();
  const servers = await lab.listen();
  if (
    !isRecord(servers) ||
    !isRecord(servers.primary) ||
    typeof servers.primary.origin !== 'string'
  ) {
    throw new Error('Browser Lab servers did not start.');
  }
  const origin = servers.primary.origin;
  const close = servers.close;
  const browser = await launchHarness();
  try {
    for (const pagePath of pagePaths(lab.cases)) {
      if (filter && !pagePath.includes(filter)) continue;
      // Trackers registered before the page, as at attach in production.
      const harness = await openHarnessPage(
        browser,
        { url: `${origin}${pagePath}` },
        { trackers: 'early' },
      );
      try {
        await describePage(harness, pagePath);
      } catch (error) {
        write(
          `FAIL ${pagePath} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      } finally {
        await harness.close();
      }
    }
  } finally {
    await browser.close();
    if (typeof close === 'function') await Reflect.apply(close, servers, []);
  }
}

void main().catch((error: unknown) => {
  write(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
