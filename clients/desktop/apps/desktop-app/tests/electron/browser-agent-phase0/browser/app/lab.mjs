// S0.3 probe: headless functional checks of the Browser Lab (A3) tasks in a
// leased tab of a disposable task profile whose only exception origin is the
// dedicated Browser Lab listener. The DOM driving here is fixture
// verification, not the browser agent's action primitives. Dialogs are
// stubbed in the page so no native dialog can appear; native dialog handling
// is therefore not exercised by this probe.

// RELOCATION: the only Browser Lab import in the probe. From
// apps/desktop-app/tests/electron/browser-agent-phase0/browser/app/ it becomes
// '../../../mock-server/routes/browser-lab.mjs'.
import {
  BROWSER_LAB_CASES,
  createBrowserLabServer,
} from '../../../mock-server/routes/browser-lab.mjs';

export { createBrowserLabServer };
import { evaluate, sleep, withTimeout } from './cases.mjs';

const byId = new Map(BROWSER_LAB_CASES.map((entry) => [entry.id, entry]));

/** Page-side helpers injected before each step. */
const HELPERS = `
window.__s03lab = window.__s03lab || {
  q: (id) => document.querySelector('[data-testid="' + id + '"]'),
  set(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  fill(fields) {
    for (const [name, value] of Object.entries(fields)) {
      const els = [...document.querySelectorAll('[name="' + CSS.escape(name) + '"]')];
      if (!els.length) return 'missing:' + name;
      const el = els[0];
      if (el.type === 'radio') {
        const match = els.find((r) => r.value === value);
        if (!match) return 'missing-radio:' + name;
        match.click();
      } else if (el.type === 'checkbox') {
        if (el.checked !== (el.value === value)) el.click();
      } else {
        this.set(el, value);
      }
    }
    return 'filled';
  },
  result() {
    const r = this.q('browser-lab-result') || this.q('browser-lab-spa-save-status');
    if (!r || !r.dataset.browserLabStatus) return null;
    const code = this.q('browser-lab-success-code');
    return { status: r.dataset.browserLabStatus, code: code ? code.textContent.trim() : null };
  },
};
'ok'`;

async function step(contents, source, gesture = true) {
  await evaluate(contents, HELPERS, false, 3000);
  return evaluate(contents, source, gesture, 5000);
}

async function waitFor(contents, source, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await evaluate(contents, HELPERS, false, 1000);
      const value = await evaluate(contents, source, false, 1000);
      if (value) return value;
    } catch {
      // mid-navigation
    }
    await sleep(100);
  }
  return null;
}

const resultSource = `(() => { const result = window.__s03lab.result(); return result && ['success', 'mismatch', 'error'].includes(result.status) ? JSON.stringify(result) : null; })()`;
const parse = (raw) => (raw && raw !== 'null' ? JSON.parse(raw) : null);

/** Per-case driving scripts. Each returns the parsed result or null. */
const DRIVERS = {
  async forms(contents, lab) {
    await step(
      contents,
      `window.__s03lab.fill(${JSON.stringify(lab.expectedSubmission)})`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-forms-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async 'native-select'(contents, lab) {
    await step(
      contents,
      `window.__s03lab.fill(${JSON.stringify(lab.expectedSubmission)})`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-native-select-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async 'long-table'(contents) {
    const orderId = await step(
      contents,
      `(() => { const row = [...document.querySelectorAll('tr[data-order-id]')].find((tr) =>
        tr.textContent.includes('Imogen Vale') && tr.textContent.includes('Refund pending'));
        return row ? row.dataset.orderId : null; })()`,
    );
    if (!orderId)
      return { status: 'driver-error', code: null, detail: 'row not found' };
    await step(
      contents,
      `window.__s03lab.fill({ orderId: ${JSON.stringify(orderId)} })`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-long-table-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async autocomplete(contents) {
    await step(
      contents,
      `(() => { const i = window.__s03lab.q('browser-lab-autocomplete-input'); i.focus(); window.__s03lab.set(i, 'Port'); return 'typed'; })()`,
    );
    const shown = await waitFor(
      contents,
      `!!window.__s03lab.q('browser-lab-autocomplete-option-plm')`,
      5000,
    );
    if (!shown)
      return {
        status: 'driver-error',
        code: null,
        detail: 'suggestion not shown',
      };
    await step(
      contents,
      `window.__s03lab.q('browser-lab-autocomplete-option-plm').click(); 'chosen'`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-autocomplete-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async dialogs(contents) {
    await step(
      contents,
      `window.confirm = () => true; window.prompt = () => 'DELETE-Q3'; window.alert = () => {};
       window.__s03lab.q('browser-lab-dialogs-delete').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async 'multi-page'(contents, lab, origin) {
    await withTimeout(
      contents.loadURL(`${origin}/browser-lab/multi-page/suppliers/birch`),
      8000,
      'supplier page',
    );
    const code = await step(
      contents,
      `(window.__s03lab.q('browser-lab-multi-page-supplier-code') || {}).textContent || ''`,
    );
    await withTimeout(
      contents.loadURL(`${origin}${lab.entryPath}`),
      8000,
      'entry page',
    );
    await step(
      contents,
      `window.__s03lab.fill({ supplierId: ${JSON.stringify(String(code).trim() || 'missing')} })`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-multi-page-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async 'slow-navigation'(contents) {
    await step(
      contents,
      `window.__s03lab.q('browser-lab-slow-navigation-report-link').click(); 'clicked'`,
    );
    const reference = await waitFor(
      contents,
      `(window.__s03lab.q('browser-lab-slow-navigation-reference') || {}).textContent || ''`,
      9000,
    );
    if (!reference)
      return {
        status: 'driver-error',
        code: null,
        detail: 'report not loaded',
      };
    await step(
      contents,
      `window.__s03lab.set(window.__s03lab.q('browser-lab-slow-navigation-input'), ${JSON.stringify(String(reference).match(/SET-\d+/)?.[0] ?? '')}); 'filled'`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-slow-navigation-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 9000));
  },
  async spa(contents) {
    await step(
      contents,
      `window.__s03lab.q('browser-lab-spa-nav-settings').click(); 'clicked'`,
    );
    const link = await waitFor(
      contents,
      `!!window.__s03lab.q('browser-lab-spa-settings-notifications-link')`,
      5000,
    );
    if (!link)
      return {
        status: 'driver-error',
        code: null,
        detail: 'settings not rendered',
      };
    await step(
      contents,
      `window.__s03lab.q('browser-lab-spa-settings-notifications-link').click(); 'clicked'`,
    );
    const form = await waitFor(
      contents,
      `!!window.__s03lab.q('browser-lab-spa-notifications-form')`,
      5000,
    );
    if (!form)
      return {
        status: 'driver-error',
        code: null,
        detail: 'notifications form not rendered',
      };
    await step(
      contents,
      `(() => { const l = window.__s03lab;
        l.set(l.q('browser-lab-spa-digest'), 'weekly');
        const p = l.q('browser-lab-spa-product-updates'); if (p.checked) p.click();
        const s = l.q('browser-lab-spa-security-alerts'); if (!s.checked) s.click();
        l.q('browser-lab-spa-save').click(); return 'saved'; })()`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
  async hostile(contents, lab) {
    await step(
      contents,
      `window.__s03lab.fill(${JSON.stringify(lab.expectedSubmission)})`,
    );
    await step(
      contents,
      `window.__s03lab.q('browser-lab-hostile-submit').click(); 'clicked'`,
    );
    return parse(await waitFor(contents, resultSource, 8000));
  },
};

/**
 * Hostile-page attack attempts in the leased tab: following the local-service
 * link, submitting the exfiltration form, and following the file: link. The
 * attack listeners are separate from the lab origin; ground truth is their
 * hit count during the attempt.
 */
async function hostileAttacks(contents, origin, attackCanaries, binding) {
  const attempts = [];
  const run = async (id, source) => {
    await withTimeout(
      contents.loadURL(`${origin}/browser-lab/hostile`),
      8000,
      'hostile page',
    );
    const before = {
      local: attackCanaries.local.hits().length,
      exfil: attackCanaries.exfil.hits().length,
    };
    const marks = {
      listener: binding.listenerEvents.length,
      handlers: binding.handlerEvents.length,
      gateway: binding.gateway.log.length,
    };
    let error = null;
    try {
      await step(contents, source);
    } catch (caught) {
      error = String(caught?.message ?? caught).slice(0, 120);
    }
    await sleep(1500);
    const url = contents.getURL();
    const own = (event) =>
      event.webContentsId === contents.id || event.webContentsId === null;
    attempts.push({
      id,
      error,
      listenerDenials: binding.listenerEvents
        .slice(marks.listener)
        .filter((event) => event.cancel && own(event)).length,
      handlerDenials: binding.handlerEvents
        .slice(marks.handlers)
        .filter((event) => event.decision === 'deny' && own(event)).length,
      gatewayDenials: binding.gateway.log
        .slice(marks.gateway)
        .filter((event) => event.decision === 'deny').length,
      finalUrlIsLab: url.startsWith(origin),
      localServiceHits: attackCanaries.local.hits().length - before.local,
      exfiltrationHits: attackCanaries.exfil.hits().length - before.exfil,
    });
  };
  await run(
    'local-service-link',
    `window.__s03lab.q('browser-lab-hostile-local-service-link').click(); 'clicked'`,
  );
  await run(
    'exfiltration-form',
    `(() => { const l = window.__s03lab;
      const t = l.q('browser-lab-hostile-verification-token'); if (t) l.set(t, 's03-synthetic-token');
      l.q('browser-lab-hostile-verify').click(); return 'clicked'; })()`,
  );
  await run(
    'file-link',
    `window.__s03lab.q('browser-lab-hostile-file-link').click(); 'clicked'`,
  );
  return attempts.map((attempt) => {
    const leaked = attempt.localServiceHits > 0 || attempt.exfiltrationHits > 0;
    const denied =
      attempt.listenerDenials +
        attempt.handlerDenials +
        attempt.gatewayDenials >
      0;
    // No hit without any observed denial proves nothing: the click may simply
    // not have navigated.
    return {
      ...attempt,
      status: leaked ? 'fail' : denied ? 'pass' : 'unobserved',
    };
  });
}

/**
 * @param {{ contents: Electron.WebContents, origin: string, attackCanaries: Record<'local'|'exfil', { hits(): unknown[] }>, binding: { listenerEvents: any[], handlerEvents: any[], gateway: { log: any[] } }, deadlineAt: number }} context
 */
export async function runLabChecks({
  contents,
  origin,
  attackCanaries,
  binding,
  deadlineAt,
}) {
  const cases = [];
  for (const [id, driver] of Object.entries(DRIVERS)) {
    const lab = byId.get(id);
    if (!lab) {
      cases.push({
        id,
        status: 'unobserved',
        detail: 'case missing from BROWSER_LAB_CASES',
      });
      continue;
    }
    if (Date.now() + 20000 > deadlineAt) {
      cases.push({
        id,
        status: 'unobserved',
        detail: 'probe deadline reached',
      });
      continue;
    }
    let result = null;
    let detail = null;
    try {
      await withTimeout(
        contents.loadURL(`${origin}${lab.entryPath}`),
        8000,
        'entry page',
      );
      result = await withTimeout(
        driver(contents, lab, origin),
        20000,
        `lab ${id}`,
      );
    } catch (error) {
      detail = String(error?.message ?? error).slice(0, 160);
    }
    const passed =
      result?.status === 'success' && result.code === lab.successCode;
    cases.push({
      id,
      taskId: lab.taskId,
      status: passed ? 'pass' : result ? 'fail' : 'unobserved',
      resultStatus: result?.status ?? null,
      successCodeMatched: passed,
      detail: detail ?? result?.detail ?? null,
    });
  }
  let attacks = [];
  if (Date.now() + 15000 < deadlineAt) {
    try {
      attacks = await hostileAttacks(contents, origin, attackCanaries, binding);
    } catch (error) {
      attacks = [
        {
          id: 'hostile-attacks',
          status: 'unobserved',
          error: String(error?.message ?? error).slice(0, 160),
        },
      ];
    }
  }
  return { cases, attacks };
}
