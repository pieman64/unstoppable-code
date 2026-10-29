// S0.3 probe: runs the finite vector matrix against one binding and records
// raw evidence per case. Electron main process only.

import { randomBytes } from 'node:crypto';
import { buildCases, classifyCase } from '../vectors.mjs';
import { extractEvidence } from '../evidence.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with the promise's value or rejects after `ms` with `label`. */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout: ${label} after ${ms} ms`)),
        ms,
      );
    }),
  ]);
}

export async function evaluate(contents, source, gesture, ms) {
  return withTimeout(
    contents.executeJavaScript(source, gesture),
    ms,
    'executeJavaScript',
  );
}

async function pollResult(contents, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const raw = await evaluate(
        contents,
        'window.__s03Result ? JSON.stringify(window.__s03Result) : null',
        false,
        Math.max(250, deadline - Date.now()),
      );
      if (raw) {
        last = JSON.parse(raw);
        if (last.state === 'done') return last;
      }
    } catch {
      // The page may be mid-navigation; retry until the deadline.
    }
    await sleep(100);
  }
  return last;
}

function fill(template, values) {
  return template.replaceAll(/\{([a-z]+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`unknown template token ${key}`);
    return String(values[key]);
  });
}

/**
 * @param {{
 *   binding: Awaited<ReturnType<typeof import('./binding.mjs').createBinding>>,
 *   leased: { contents: Electron.WebContents, id: number, lease: { token: string } },
 *   control: { contents: Electron.WebContents, id: number } | null,
 *   canaries: Record<'local'|'public'|'user'|'recorder', { hitsFor(n: string): unknown[] }>,
 *   ports: Record<string, number>,
 *   vectorOrigin: string,
 *   caseTimeoutMs: number,
 *   settleMs: number,
 *   deadlineAt: number,
 * }} context
 */
export async function runBindingCases(context) {
  const {
    binding,
    leased,
    control,
    canaries,
    ports,
    vectorOrigin,
    caseTimeoutMs,
    settleMs,
    deadlineAt,
  } = context;
  const results = [];
  for (const spec of buildCases(binding.kind)) {
    if (Date.now() + caseTimeoutMs + settleMs > deadlineAt) {
      results.push({
        ...describe(spec),
        status: 'unobserved',
        reason: 'probe deadline reached before this case',
        mechanisms: [],
        evidence: null,
      });
      continue;
    }
    const tab = spec.tab === 'leased' ? leased : control;
    if (!tab) {
      results.push({
        ...describe(spec),
        status: 'unobserved',
        reason: 'no control tab in this binding',
        mechanisms: [],
        evidence: null,
      });
      continue;
    }
    results.push(
      await runCase(
        spec,
        tab,
        spec.tab === 'leased' ? leased.lease.token : null,
      ),
    );
  }
  return results;

  async function runCase(spec, tab, leaseToken) {
    const nonce = `c${randomBytes(6).toString('hex')}`;
    const target = fill(spec.target, {
      ...ports,
      vector: vectorOrigin,
      n: nonce,
    });
    const marks = {
      listener: binding.listenerEvents.length,
      handlers: binding.handlerEvents.length,
      gateway: binding.gateway.log.length,
    };
    const startedAt = Date.now();
    const page = { exercised: false, outcome: null, error: null };
    try {
      if (spec.action === 'navigate') {
        page.outcome = await withTimeout(
          tab.contents.loadURL(target).then(
            () => 'loaded',
            (error) => `rejected:${error?.code ?? error?.message ?? 'error'}`,
          ),
          caseTimeoutMs,
          'loadURL',
        );
        page.exercised = true;
      } else {
        const query = new URLSearchParams({ target, n: nonce });
        if (spec.manual) query.set('manual', '1');
        if (spec.query)
          for (const [key, value] of new URLSearchParams(spec.query))
            query.set(key, value);
        const pageUrl = `${vectorOrigin}/s03/vector/${spec.page}?${query}`;
        await withTimeout(
          tab.contents.loadURL(pageUrl),
          caseTimeoutMs,
          'load vector page',
        );
        if (spec.manual) {
          // A user-gesture evaluation gives the page transient activation for
          // window.open, input.click() and anchor clicks.
          await evaluate(
            tab.contents,
            'typeof window.__s03Run === "function" ? (window.__s03Run(), "run") : "missing"',
            true,
            caseTimeoutMs,
          );
        }
        const result = await pollResult(tab.contents, caseTimeoutMs);
        page.outcome = result?.outcome ?? result?.state ?? null;
        page.exercised = result?.state === 'done';
        if (!page.exercised)
          page.error = `page state ${result?.state ?? 'missing'}`;
      }
    } catch (error) {
      page.error = String(error?.message ?? error).slice(0, 200);
    }
    await sleep(settleMs);
    // Stop page activity before the next case; service workers are cleared so
    // a lingering worker cannot produce evidence inside a later case window.
    await withTimeout(
      tab.contents.loadURL('about:blank'),
      3000,
      'reset tab',
    ).catch(() => {});
    if (spec.page?.startsWith('service-worker')) {
      await withTimeout(
        binding.ses.clearStorageData({ storages: ['serviceworkers'] }),
        3000,
        'clear sw',
      ).catch(() => {});
    }

    const canary =
      spec.destination === 'none' ? null : canaries[spec.destination];
    const destinationHits = canary ? canary.hitsFor(nonce).length : 0;
    const listener = binding.listenerEvents.slice(marks.listener);
    const handlers = binding.handlerEvents.slice(marks.handlers);
    const gateway = binding.gateway.log.slice(marks.gateway);
    const evidence = extractEvidence({
      spec,
      tabId: tab.id,
      leaseToken,
      listener,
      gateway,
      handlers,
      destinationHits,
      page,
    });
    const verdict = classifyCase(spec, evidence);
    return {
      ...describe(spec),
      nonce,
      durationMs: Date.now() - startedAt,
      ...verdict,
      evidence: {
        ...evidence,
        rawListener: listener.filter(
          (event) =>
            event.webContentsId === tab.id || event.webContentsId === null,
        ),
        rawGateway: gateway,
        rawHandlers: handlers.filter(
          (event) =>
            event.webContentsId === tab.id || event.webContentsId === null,
        ),
      },
    };
  }
}

function describe(spec) {
  return {
    caseId: spec.caseId,
    binding: spec.binding,
    vector: spec.vector,
    tab: spec.tab,
    expect: spec.expect,
    action: spec.action,
    page: spec.page ?? null,
    targetTemplate: spec.target,
    destination: spec.destination,
  };
}
