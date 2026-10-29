/**
 * Live probe for phase 04b stage S1 (not a CI test): document-start
 * tracking, action targeting, describe and fill, through the real
 * PageModelHost in Playwright's headless Chromium. Its comparisons with the
 * preload's describe and wait probe went with those commands (stage S4).
 * Run from the repository root:
 *
 *   node_modules/.bin/tsx apps/desktop-app/src/main/browser/frames/__tests__/fixtures/live-probe-s1.ts --trackers|--targeting|--heavy
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserInputSnapshotResponse } from '@canopy/desktop-shared/types/browser';
import type { BrowserPageModel } from '../../model-types';
import { TRACKER_WORLD_NAME } from '../../trackers';
import {
  launchHarness,
  openHarnessPage,
  pageMetadata,
  serveRecordedPages,
  type HarnessOptions,
  type HarnessPage,
} from './cdp-harness';

type Browser = Awaited<ReturnType<typeof launchHarness>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function allRows(
  harness: HarnessPage,
  frame?: string,
): Promise<BrowserInputSnapshotResponse['inputs']> {
  const metadata = await pageMetadata(harness);
  const rows: BrowserInputSnapshotResponse['inputs'] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await harness.host.snapshot(
      { browserId: 'probe', offset, limit: 100 },
      () => Promise.resolve(metadata),
      frame === undefined ? {} : { frame },
    );
    rows.push(...page.inputs);
    if (!page.truncated) break;
  }
  return rows;
}

/** Every snapshot and every row's inspect output, serialized. */
async function everyOutput(harness: HarnessPage): Promise<string> {
  const metadata = await pageMetadata(harness);
  const rows = await allRows(harness);
  const outputs: unknown[] = [rows];
  for (const row of rows) {
    outputs.push(
      await harness.host
        .inspect({ browserId: 'probe', ref: row.ref }, () =>
          Promise.resolve(metadata),
        )
        .catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        ),
    );
  }
  return JSON.stringify(outputs);
}

/** Row values by element id, read through inspect. */
async function rowsById(
  harness: HarnessPage,
): Promise<Map<string, BrowserInputSnapshotResponse['inputs'][number]>> {
  const metadata = await pageMetadata(harness);
  const byId = new Map<
    string,
    BrowserInputSnapshotResponse['inputs'][number]
  >();
  for (const row of await allRows(harness)) {
    const inspected = await harness.host
      .inspect({ browserId: 'probe', ref: row.ref }, () =>
        Promise.resolve(metadata),
      )
      .catch(() => undefined);
    const id = inspected?.attributes.id ?? inspected?.attributes['data-testid'];
    if (id) byId.set(id, row);
  }
  return byId;
}

function statuses(harness: HarnessPage, model: BrowserPageModel): string {
  return model.frames
    .map(
      (frame) =>
        `${frame.depth}${frame.sessionId ? '/oopif' : ''}:${harness.host.trackerStatus(frame.frameId, frame.sessionId)}`,
    )
    .join(' ');
}

const SEED = /SEED-TRK-[A-Z]+-\d{4}/g;

async function trackerCase(
  browser: Browser,
  origin: string,
  label: string,
  options: HarnessOptions,
  renavigate: boolean,
): Promise<void> {
  const harness = await openHarnessPage(
    browser,
    { url: `${origin}/trackers.html` },
    options,
  );
  try {
    await harness.page.waitForTimeout(400);
    await harness.syncFrames();
    if (renavigate) {
      await harness.page.evaluate(
        "(() => { const frame = document.querySelector('#cross'); frame.src = frame.src + '?again'; })()",
      );
      await harness.page.waitForTimeout(800);
      await harness.syncFrames();
    }
    const serialized = await everyOutput(harness);
    const leaked = Array.from(new Set(serialized.match(SEED) ?? []));
    const byId = await rowsById(harness);
    const shown = (id: string): string =>
      byId.get(id)?.valueRedacted ? 'withheld' : `"${byId.get(id)?.value}"`;
    const { model } = await harness.host.build();
    write(
      `CASE ${label}: seeds leaked=${leaked.length === 0 ? 'none' : leaked.join(',')} trackers=[${statuses(harness, model)}] history=${JSON.stringify(model.trackerHistory)}`,
    );
    write(
      `  plain: open=${shown('open-plain')} closed=${shown('closed-plain')} frame=${shown('frame-plain')} frame-shadow=${shown('frame-shadow-plain')} cross=${shown('cross-plain')}`,
    );
    write(
      `  revealed: open=${shown('open-revealed')} mirror=${shown('open-mirror')} closed=${shown('closed-revealed')} frame=${shown('frame-revealed')} frame-shadow=${shown('frame-shadow-revealed')} cross=${shown('cross-revealed')}`,
    );
    write(
      `  moved (D5): light-to-shadow=${shown('move-lts')} shadow-to-light=${shown('move-stl')} root-to-root=${shown('move-rtr')} frame-light-to-shadow=${shown('frame-lts')} frame-shadow-to-light=${shown('frame-stl')}`,
    );
    write(
      `  labels: remember=${JSON.stringify(byId.get('open-remember')?.name ?? null)} password=${JSON.stringify(byId.get('open-password')?.name ?? null)}; textareas: note=${shown('open-note')} secret-note=${shown('open-secret-note')}`,
    );
    // One attachShadow wrapper per document (E4): the host's resolver is in
    // child documents only; the top document has the preload's.
    const resolvers: unknown = await harness.page.evaluate(
      `(() => { const key = ${JSON.stringify(harness.host.trackerKey)}; const frame = document.querySelector('#same'); const preloadKeys = Object.getOwnPropertyNames(window).filter((name) => /^__canopyPageModelTracker_/.test(name) && name !== key); return { topHost: typeof window[key], topPreload: preloadKeys.length, sameHost: typeof frame.contentWindow[key], samePreload: Object.getOwnPropertyNames(frame.contentWindow).filter((name) => /^__canopyPageModelTracker_/.test(name) && name !== key).length }; })()`,
    );
    write(`  resolvers (E4): ${JSON.stringify(resolvers)}`);
  } finally {
    await harness.close();
  }
}

/** Browser Lab frames and shadow pages: seeds absent, visible notes present. */
async function labCase(browser: Browser, labOrigin: string): Promise<void> {
  for (const pagePath of ['/browser-lab/frames', '/browser-lab/shadow']) {
    const harness = await openHarnessPage(
      browser,
      { url: `${labOrigin}${pagePath}` },
      { trackers: 'early' },
    );
    try {
      await harness.page.waitForTimeout(1_500);
      await harness.syncFrames();
      const serialized = await everyOutput(harness);
      const leaked = Array.from(
        new Set(serialized.match(/canopy-seeded-secret-\d+(?!\d)/g) ?? []),
      );
      const notes = Array.from(
        new Set(serialized.match(/canopy-visible-note-\d+(?!\d)/g) ?? []),
      ).sort();
      const { model } = await harness.host.build();
      write(
        `LAB ${pagePath}: seeds leaked=${leaked.length === 0 ? 'none' : leaked.join(',')} visible notes=${JSON.stringify(notes)} trackers=[${statuses(harness, model)}]`,
      );
    } finally {
      await harness.close();
    }
  }
}

/**
 * A declarative shadow root is created by the parser, not `attachShadow`:
 * its inputs are unknown even with trackers in time. A root a page wrapper
 * creates through the hooked `attachShadow` is tracked.
 */
/**
 * Page script replaces array iteration after the trackers installed, then
 * attaches a root and reveals a password in it: the root must stay observed
 * (the filter is the tracker's own iterable), so the password stays withheld
 * and the plain input beside it readable.
 */
async function iteratorCase(browser: Browser): Promise<void> {
  const html = `<!doctype html><body><div id="host"></div><script>
      const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]());
      arrayIterator.next = () => ({ done: true, value: undefined });
      Array.prototype[Symbol.iterator] = function* () {};
      const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
      root.innerHTML = '<input id="iter-revealed" type="password"><input id="iter-plain" value="iterator plain value">';
      const revealed = root.querySelector('#iter-revealed');
      revealed.value = 'SEED-TRK-' + 'ITER-' + 1115; revealed.type = 'text';
    </script></body>`;
  const harness = await openHarnessPage(
    browser,
    { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` },
    { trackers: 'early' },
  );
  try {
    await harness.page.waitForTimeout(300);
    const serialized = await everyOutput(harness);
    const leaked = Array.from(new Set(serialized.match(SEED) ?? []));
    const byId = await rowsById(harness);
    const shown = (id: string): string =>
      byId.get(id)?.valueRedacted ? 'withheld' : `"${byId.get(id)?.value}"`;
    write(
      `CASE array iteration replaced before attachShadow: seeds leaked=${leaked.length === 0 ? 'none' : leaked.join(',')} iter-revealed=${shown('iter-revealed')} iter-plain=${shown('iter-plain')}`,
    );
  } finally {
    await harness.close();
  }
}

async function declarativeCase(browser: Browser): Promise<void> {
  const html = `<!doctype html><body>
    <div id="declarative"><template shadowrootmode="open"><input id="dsd-revealed" type="password"><input id="dsd-plain" value="dsd plain value"></template></div>
    <div id="wrapped"></div>
    <script>
      const native = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) { return native.call(this, init); };
      const dsd = document.querySelector('#declarative').shadowRoot.querySelector('#dsd-revealed');
      dsd.value = 'SEED-TRK-' + 'DSD-' + 1108; dsd.type = 'text';
      const root = document.querySelector('#wrapped').attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="wrapped-revealed" type="password"><input id="wrapped-plain" value="wrapped plain value">';
      const wrapped = root.querySelector('#wrapped-revealed');
      wrapped.value = 'SEED-TRK-' + 'WRAP-' + 1109; wrapped.type = 'text';
    </script></body>`;
  const harness = await openHarnessPage(
    browser,
    { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` },
    { trackers: 'early' },
  );
  try {
    await harness.page.waitForTimeout(300);
    const serialized = await everyOutput(harness);
    const leaked = Array.from(new Set(serialized.match(SEED) ?? []));
    const byId = await rowsById(harness);
    const shown = (id: string): string =>
      byId.get(id)?.valueRedacted ? 'withheld' : `"${byId.get(id)?.value}"`;
    write(
      `CASE declarative and page-wrapped roots: seeds leaked=${leaked.length === 0 ? 'none' : leaked.join(',')} dsd-plain=${shown('dsd-plain')} wrapped-plain=${shown('wrapped-plain')} wrapped-revealed=${shown('wrapped-revealed')}`,
    );
  } finally {
    await harness.close();
  }
}

async function probeTrackers(labOrigin: string): Promise<void> {
  const { origin, close } = await serveRecordedPages(/^trackers[a-z-]*\.html$/);
  const browser = await launchHarness();
  try {
    await trackerCase(
      browser,
      origin,
      'installed in time, first cross-site document',
      { trackers: 'early' },
      false,
    );
    await trackerCase(
      browser,
      origin,
      'installed in time, cross-site frame re-navigated',
      { trackers: 'early' },
      true,
    );
    await trackerCase(
      browser,
      origin,
      'no CDP trackers at all (the preload alone, as on a new view)',
      { trackers: 'none' },
      false,
    );
    await trackerCase(
      browser,
      origin,
      'no preload (CDP trackers only)',
      { trackers: 'early', preload: false },
      true,
    );
    await trackerCase(
      browser,
      origin,
      'late install',
      { trackers: 'late' },
      true,
    );
    await trackerCase(
      browser,
      origin,
      'missing tracker context',
      { trackers: 'early', dropWorlds: [TRACKER_WORLD_NAME] },
      true,
    );
    await trackerCase(
      browser,
      origin,
      'throwing resolver',
      {
        trackers: 'early',
        intercept: (method, params) =>
          method === 'Runtime.callFunctionOn' &&
          typeof params.functionDeclaration === 'string' &&
          params.functionDeclaration.includes('__canopyPageModelTracker_')
            ? Promise.resolve({
                result: { type: 'object', subtype: 'error' },
                exceptionDetails: { text: 'Uncaught Error: hostile' },
              })
            : undefined,
      },
      true,
    );
    await declarativeCase(browser);
    await iteratorCase(browser);
    await labCase(browser, labOrigin);
  } finally {
    await browser.close();
    close();
  }
}

/** Whether `inner` is `outer` or inside it, through shadow hosts. */
function isWithin(
  model: BrowserPageModel,
  inner: { sessionId: string; backendNodeId: number },
  outer: { sessionId: string; backendNodeId: number },
): boolean {
  let index = model.nodes.findIndex(
    (node) =>
      node.identity.sessionId === inner.sessionId &&
      node.identity.backendNodeId === inner.backendNodeId,
  );
  for (let steps = 0; index >= 0 && steps < 500; steps += 1) {
    const node = model.nodes[index];
    if (!node) return false;
    if (
      node.identity.sessionId === outer.sessionId &&
      node.identity.backendNodeId === outer.backendNodeId
    )
      return true;
    if (node.parentIndex !== undefined) {
      index = node.parentIndex;
      continue;
    }
    // A shadow root's parent index is its host's.
    return false;
  }
  return false;
}

/**
 * Every row: resolve by ref and by its center point, describe, and for
 * out-of-process rows, the ancestor hit test at the mapped point.
 */
async function targetRows(harness: HarnessPage, label: string): Promise<void> {
  const rows = await allRows(harness);
  const { model } = await harness.host.build();
  let refs = 0;
  let exact = 0;
  let inside = 0;
  let described = 0;
  let hops = 0;
  let hopHits = 0;
  const problems: string[] = [];
  for (const row of rows) {
    const resolved = await harness.host.resolveActionTarget({
      kind: 'ref',
      ref: row.ref,
    });
    if (resolved.status !== 'found') {
      problems.push(`ref ${row.tagName} ${row.name ?? ''}: ${resolved.status}`);
      continue;
    }
    refs += 1;
    const target = resolved.target;
    if (await harness.host.describeActionTarget(target)) described += 1;
    else
      problems.push(`describe ${row.tagName} ${row.name ?? ''}: unavailable`);
    const x = row.bounds.x + row.bounds.width / 2;
    const y = row.bounds.y + row.bounds.height / 2;
    const byPoint = await harness.host.resolveActionTarget({
      kind: 'point',
      x,
      y,
    });
    if (byPoint.status === 'found') {
      const hit = byPoint.target.identity;
      if (
        hit.backendNodeId === target.identity.backendNodeId &&
        hit.sessionId === target.identity.sessionId
      )
        exact += 1;
      else if (isWithin(model, hit, target.identity)) inside += 1;
      await harness.host.releaseActionTarget(byPoint.target);
    }
    if (target.outOfProcess) {
      const frame = model.frames.find(
        (candidate) => candidate.frameRef === row.frameRef,
      );
      if (frame) {
        const { x: tx, y: ty, scaleX, scaleY } = frame.viewportTransform;
        const mapping = await harness.host.mapToAncestors(target, {
          x: (x - tx) / scaleX,
          y: (y - ty) / scaleY,
        });
        if (mapping.status === 'mapped') {
          for (const hop of mapping.hops) {
            const hit = await harness
              .send(
                'DOM.getNodeForLocation',
                { x: Math.round(hop.point.x), y: Math.round(hop.point.y) },
                hop.sessionId,
              )
              .catch(() => undefined);
            const owned =
              isRecord(hit) && hit.backendNodeId === hop.ownerBackendNodeId;
            // Only an on-screen row's point can hit anything.
            if (row.inViewport !== true) continue;
            hops += 1;
            if (owned) hopHits += 1;
            else
              problems.push(
                `hop ${row.tagName} ${row.name ?? ''} at ${Math.round(hop.point.x)},${Math.round(hop.point.y)}: hit ${JSON.stringify(hit)}`,
              );
          }
        } else problems.push(`map ${row.tagName}: ${mapping.status}`);
      }
    }
    await harness.host.releaseActionTarget(target);
  }
  write(
    `TARGET ${label}: rows=${rows.length} refs=${refs} points exact=${exact} inside=${inside} described=${described} hops=${hopHits}/${hops}`,
  );
  for (const problem of problems.slice(0, 12)) write(`    ${problem}`);
}

/** Fill one input per scope through the host and read the value back. */
async function fillScopes(harness: HarnessPage, ids: string[]): Promise<void> {
  const results: string[] = [];
  for (const id of ids) {
    const resolved = await harness.host.resolveActionTarget({
      kind: 'locator',
      locator: `page.locator('#${id}')`,
    });
    if (resolved.status !== 'found') {
      results.push(`${id}=${resolved.status}`);
      continue;
    }
    const outcome = await harness.host.fillActionTarget(
      resolved.target,
      `filled ${id}`,
    );
    harness.host.actionBoundary();
    const after = (await rowsById(harness)).get(id);
    results.push(
      `${id}=${outcome}/${after?.valueRedacted ? 'withheld' : JSON.stringify(after?.value)}`,
    );
    await harness.host.releaseActionTarget(resolved.target);
  }
  write(`FILL ${results.join(' ')}`);
}

async function focusedCase(
  harness: HarnessPage,
  focus: () => Promise<unknown>,
  label: string,
): Promise<void> {
  await focus();
  await harness.page.waitForTimeout(50);
  const resolved = await harness.host.resolveActionTarget({ kind: 'focused' });
  if (resolved.status !== 'found') {
    write(`FOCUS ${label}: ${resolved.status}`);
    return;
  }
  const described = await harness.host.describeActionTarget(resolved.target);
  const { model } = await harness.host.build();
  const node = model.nodes.find(
    (candidate) =>
      candidate.identity.sessionId === resolved.target.identity.sessionId &&
      candidate.identity.backendNodeId ===
        resolved.target.identity.backendNodeId,
  );
  write(
    `FOCUS ${label}: #${node?.attributes.id ?? '?'} ${described?.tagName} name=${JSON.stringify(described?.name ?? null)} focused=${String(described?.focused)} oopif=${String(resolved.target.outOfProcess)}`,
  );
  await harness.host.releaseActionTarget(resolved.target);
}

async function probeTargeting(
  labOrigin: string,
  labPaths: string[],
): Promise<void> {
  const { origin, close } = await serveRecordedPages(
    /^(trackers|frames|shadow|oopif)[a-z-]*\.html$/,
  );
  const browser = await launchHarness();
  try {
    for (const name of ['trackers', 'frames', 'shadow', 'oopif']) {
      const harness = await openHarnessPage(
        browser,
        { url: `${origin}/${name}.html` },
        { trackers: 'early' },
      );
      try {
        await harness.page.waitForTimeout(400);
        await harness.syncFrames();
        await targetRows(harness, name);
        if (name === 'trackers') {
          await harness.page.evaluate(
            "(() => { const frame = document.querySelector('#cross'); frame.src = frame.src + '?again'; })()",
          );
          await harness.page.waitForTimeout(800);
          await harness.syncFrames();
          await fillScopes(harness, [
            'open-plain',
            'closed-plain',
            'frame-plain',
            'cross-plain',
            'open-note',
          ]);
          await focusedCase(
            harness,
            () =>
              harness.page.evaluate(
                "document.querySelector('#open-host').shadowRoot.querySelector('#open-plain').focus()",
              ),
            'open shadow input',
          );
          await focusedCase(
            harness,
            () =>
              harness.page.evaluate(
                "document.querySelector('#same').contentDocument.querySelector('#frame-plain').focus()",
              ),
            'same-process frame input',
          );
          // A closed root: page script cannot reach the input, so focus it
          // through CDP by its backend id (review R1 finding 2).
          const focusById = async (id: string): Promise<void> => {
            const { model } = await harness.host.build();
            const target = model.nodes.find(
              (candidate) => candidate.attributes.id === id,
            );
            if (!target) throw new Error(`Missing #${id}`);
            await harness.send(
              'DOM.focus',
              { backendNodeId: target.identity.backendNodeId },
              target.identity.sessionId,
            );
          };
          await focusedCase(
            harness,
            () => focusById('closed-plain'),
            'closed shadow input',
          );
          await focusedCase(
            harness,
            () => focusById('frame-shadow-plain'),
            'closed shadow input in a same-process frame',
          );
          const cross = harness.page
            .frames()
            .find((frame) => frame.url().includes('trackers-child'));
          if (cross)
            await focusedCase(
              harness,
              () => cross.focus('#cross-plain'),
              'cross-site frame input',
            );
        }
      } finally {
        await harness.close();
      }
    }
    let pages = 0;
    for (const pagePath of labPaths) {
      if (
        [
          '/browser-lab/frames',
          '/browser-lab/shadow',
          '/browser-lab/heavy',
        ].some((prefix) => pagePath.startsWith(prefix))
      )
        continue;
      const harness = await openHarnessPage(
        browser,
        { url: `${labOrigin}${pagePath}` },
        { trackers: 'early' },
      );
      try {
        pages += 1;
        await targetRows(harness, pagePath);
      } catch (error) {
        write(
          `FAIL ${pagePath} ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await harness.close();
      }
    }
    write(`SUMMARY lab pages targeted=${pages}`);
  } finally {
    await browser.close();
    close();
  }
}

/** Tracker query cost per build on heavy, with and without trackers. */
async function probeHeavy(labOrigin: string): Promise<void> {
  const browser = await launchHarness();
  try {
    for (const trackers of ['early', 'none'] as const) {
      const counts = new Map<string, number>();
      const harness = await openHarnessPage(
        browser,
        { url: `${labOrigin}/browser-lab/heavy` },
        {
          trackers,
          observe: (method) =>
            counts.set(method, (counts.get(method) ?? 0) + 1),
        },
      );
      try {
        await harness.page.waitForTimeout(1_500);
        await harness.syncFrames();
        const totals: number[] = [];
        const history: string[] = [];
        let perBuild: Record<string, number> = {};
        for (let run = 0; run < 5; run += 1) {
          counts.clear();
          const built = await harness.host.build({ cache: 'bypass' });
          totals.push(Math.round(built.durationMs));
          history.push(JSON.stringify(built.model.trackerHistory));
          perBuild = Object.fromEntries(counts);
        }
        write(`HEAVY trackers=${trackers} builds(ms)=${totals.join(',')}`);
        write(`  trackerHistory per build: ${history.join(' ')}`);
        write(`  CDP requests in the last build: ${JSON.stringify(perBuild)}`);
      } finally {
        await harness.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/**
 * Tracker query cost at the cap: 200 inputs with values in 50 open shadow
 * roots, and 50 more in a same-process frame's light DOM.
 */
async function probeStress(browser: Browser): Promise<void> {
  const frameInputs = Array.from(
    { length: 50 },
    (_, index) => `<input id=f${index} value=v${index}>`,
  ).join('');
  const html = `<!doctype html><body><div id="hosts"></div><iframe id="frame" style="width:600px;height:300px" srcdoc="<body>${frameInputs}</body>"></iframe><script>
    const hosts = document.querySelector('#hosts');
    for (let root = 0; root < 50; root += 1) {
      const host = document.createElement('div');
      hosts.append(host);
      const shadow = host.attachShadow({ mode: root % 2 ? 'closed' : 'open' });
      shadow.innerHTML = [0, 1, 2, 3].map((index) => '<input value="value ' + root + '-' + index + '">').join('');
    }
  </script></body>`;
  for (const trackers of ['early', 'none'] as const) {
    const counts = new Map<string, number>();
    // A navigation: setContent would reuse the document that predates them.
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const harness = await openHarnessPage(
      browser,
      { url },
      {
        trackers,
        observe: (method) => counts.set(method, (counts.get(method) ?? 0) + 1),
      },
    );
    try {
      await harness.page.waitForTimeout(500);
      await harness.syncFrames();
      const totals: number[] = [];
      const history: number[] = [];
      let summary = '';
      let perBuild: Record<string, number> = {};
      for (let run = 0; run < 5; run += 1) {
        counts.clear();
        const built = await harness.host.build({ cache: 'bypass' });
        totals.push(Math.round(built.durationMs));
        history.push(built.model.trackerHistory.durationMs);
        summary = JSON.stringify({
          ...built.model.trackerHistory,
          durationMs: undefined,
        });
        perBuild = Object.fromEntries(counts);
      }
      write(
        `STRESS trackers=${trackers} builds(ms)=${totals.join(',')} historyMs=${history.join(',')} ${summary}`,
      );
      write(`  CDP requests in the last build: ${JSON.stringify(perBuild)}`);
    } finally {
      await harness.close();
    }
  }
}

async function main(): Promise<void> {
  const file = path.resolve(
    'apps/desktop-app/tests/electron/mock-server/routes/browser-lab.mjs',
  );
  const lab: unknown = await import(pathToFileURL(file).href);
  if (!isRecord(lab) || typeof lab.listenPairedBrowserLabServers !== 'function')
    throw new Error('Browser Lab module is missing.');
  const servers: unknown = await Reflect.apply(
    lab.listenPairedBrowserLabServers,
    undefined,
    [],
  );
  if (
    !isRecord(servers) ||
    !isRecord(servers.primary) ||
    typeof servers.primary.origin !== 'string'
  )
    throw new Error('Browser Lab servers did not start.');
  const labOrigin = servers.primary.origin;
  const paths = ['/browser-lab', '/browser-lab/interaction'];
  for (const entry of [lab.BROWSER_LAB_CASES, lab.BROWSER_LAB_INTERACTION_CASES]
    .filter(Array.isArray)
    .flat()) {
    if (!isRecord(entry) || !Array.isArray(entry.pages)) continue;
    for (const page of entry.pages)
      if (isRecord(page) && typeof page.path === 'string')
        paths.push(page.path);
  }
  try {
    const mode = process.argv[2];
    if (mode === '--trackers') await probeTrackers(labOrigin);
    else if (mode === '--targeting')
      await probeTargeting(labOrigin, Array.from(new Set(paths)));
    else if (mode === '--heavy') {
      await probeHeavy(labOrigin);
      const browser = await launchHarness();
      try {
        await probeStress(browser);
      } finally {
        await browser.close();
      }
    } else write('Usage: live-probe-s1.ts --trackers|--targeting|--heavy');
  } finally {
    if (typeof servers.close === 'function')
      await Reflect.apply(servers.close, servers, []);
  }
}

void main().catch((error: unknown) => {
  write(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
