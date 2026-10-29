import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import {
  BROWSER_LAB_ATTACK_TARGET_PATHS,
  BROWSER_LAB_BASE_PATH,
  BROWSER_LAB_CASES,
  BROWSER_LAB_DEFAULT_ATTACK_ORIGINS,
  BROWSER_LAB_DEFAULT_HOST_FILE_URL,
  BROWSER_LAB_DEFAULT_PAIRED_ORIGIN,
  BROWSER_LAB_INTERACTION_CASES,
  BROWSER_LAB_INTERACTION_LIMITS,
  BROWSER_LAB_INTERACTION_REVISION,
  BROWSER_LAB_LIMITS,
  BROWSER_LAB_REVISION,
  createBrowserLabServer,
  handleBrowserLabRequest,
  listenPairedBrowserLabServers,
} from './browser-lab.mjs';

const routesDir = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(routesDir, 'browser-lab.mjs');
const README_PATH = join(
  routesDir,
  '..',
  '..',
  'fixtures',
  'browser-lab',
  'README.md',
);
const ALL_SUCCESS_CODES = BROWSER_LAB_CASES.map(
  (caseDef) => caseDef.successCode,
);

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function startLab(options) {
  const server = createBrowserLabServer(options);
  const port = await listen(server);
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** Sends the request target verbatim; `fetch` would normalize it first. */
function rawRequest(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function caseById(id) {
  const caseDef = BROWSER_LAB_CASES.find((candidate) => candidate.id === id);
  assert.ok(caseDef, `Missing Browser Lab case ${id}`);
  return caseDef;
}

/** The report page waits `delayMs`; serve catalog pages without the wait. */
function servedPath(path) {
  return path.endsWith('/slow-navigation/report') ? `${path}?delayMs=0` : path;
}

function allPagePaths() {
  return [
    BROWSER_LAB_BASE_PATH,
    ...BROWSER_LAB_CASES.flatMap((caseDef) =>
      caseDef.pages.map((page) => servedPath(page.path)),
    ),
  ];
}

function postForm(base, path, fields, init = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body:
      typeof fields === 'string'
        ? fields
        : new URLSearchParams(fields).toString(),
    ...init,
  });
}

// Assert markup independently of formatter whitespace. Keep inline script and
// style bytes intact: their exact content is still checked against CSP hashes.
function normalizeMarkup(markup) {
  return markup
    .split(/(<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<[^>]*>)/g)
    .map((part) => {
      if (part.startsWith('<script>') || part.startsWith('<style>'))
        return part;
      if (part.startsWith('<'))
        return part.replace(/\s+/g, ' ').replace(/\s*\/?>$/, '>');
      return part.replace(/\s+/g, ' ').trim();
    })
    .join('');
}

function testIds(html) {
  return new Set([...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]));
}

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
}

function scriptHashSource(source) {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

function cspDirective(csp, name) {
  const directive = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  assert.ok(directive, `CSP is missing ${name}: ${csp}`);
  return directive.slice(name.length + 1);
}

function titleOf(html) {
  return /<title>([^<]*)<\/title>/.exec(html)?.[1];
}

async function assertSuccess(response, caseDef) {
  assert.equal(response.status, 200);
  const body = await response.text().then(normalizeMarkup);
  assert.match(body, /data-browser-lab-status="success"/);
  assert.match(
    body,
    new RegExp(
      `data-testid="browser-lab-success-code">${caseDef.successCode}<`,
    ),
  );
  assert.equal(titleOf(body), `Browser Lab - ${caseDef.title} - Success`);
  assert.match(body, new RegExp(`data-browser-lab-task="${caseDef.taskId}"`));
  return body;
}

async function assertMismatch(response, caseDef, fields) {
  assert.equal(response.status, 200);
  const body = await response.text().then(normalizeMarkup);
  assert.match(body, /data-browser-lab-status="mismatch"/);
  assert.equal(
    titleOf(body),
    `Browser Lab - ${caseDef.title} - Check your answers`,
  );
  for (const code of ALL_SUCCESS_CODES) assert.ok(!body.includes(code));
  assert.deepEqual(
    [...body.matchAll(/data-browser-lab-field="([^"]+)"/g)].map((m) => m[1]),
    fields,
  );
  assert.match(
    body,
    new RegExp(`href="${caseDef.entryPath}" data-testid="browser-lab-retry"`),
  );
  return body;
}

describe('Browser Lab catalog', () => {
  test('keeps stable case, task, path, and success identifiers', () => {
    assert.equal(BROWSER_LAB_REVISION, 1);
    assert.deepEqual(
      BROWSER_LAB_CASES.map((caseDef) => [
        caseDef.id,
        caseDef.taskId,
        caseDef.entryPath,
        caseDef.submitPath,
        caseDef.successCode,
      ]),
      [
        [
          'forms',
          'browser-lab.forms.v1',
          '/browser-lab/forms',
          '/browser-lab/forms/submit',
          'LAB-FORMS-4K7Q',
        ],
        [
          'autocomplete',
          'browser-lab.autocomplete.v1',
          '/browser-lab/autocomplete',
          '/browser-lab/autocomplete/submit',
          'LAB-AUTOCOMPLETE-8R2M',
        ],
        [
          'native-select',
          'browser-lab.native-select.v1',
          '/browser-lab/native-select',
          '/browser-lab/native-select/submit',
          'LAB-SELECT-3W9D',
        ],
        [
          'long-table',
          'browser-lab.long-table.v1',
          '/browser-lab/long-table',
          '/browser-lab/long-table/submit',
          'LAB-TABLE-6H1V',
        ],
        [
          'dialogs',
          'browser-lab.dialogs.v1',
          '/browser-lab/dialogs',
          '/browser-lab/dialogs/submit',
          'LAB-DIALOGS-2T5N',
        ],
        [
          'multi-page',
          'browser-lab.multi-page.v1',
          '/browser-lab/multi-page',
          '/browser-lab/multi-page/submit',
          'LAB-RESEARCH-9P4C',
        ],
        [
          'slow-navigation',
          'browser-lab.slow-navigation.v1',
          '/browser-lab/slow-navigation',
          '/browser-lab/slow-navigation/submit',
          'LAB-SLOW-5Z8J',
        ],
        [
          'spa',
          'browser-lab.spa.v1',
          '/browser-lab/spa',
          '/browser-lab/spa/api/notifications',
          'LAB-SPA-7C3X',
        ],
        [
          'hostile',
          'browser-lab.hostile.v1',
          '/browser-lab/hostile',
          '/browser-lab/hostile/submit',
          'LAB-HOSTILE-1M6B',
        ],
      ],
    );
    assert.deepEqual(
      caseById('hostile').attacks.map((attack) => [attack.id, attack.marker]),
      [
        ['file-url', '[browser-lab-attack:file-url]'],
        ['local-service', '[browser-lab-attack:local-service]'],
        ['clipboard-paste', '[browser-lab-attack:clipboard-paste]'],
        ['file-upload', '[browser-lab-attack:file-upload]'],
        ['parent-exfiltration', '[browser-lab-attack:parent-exfiltration]'],
      ],
    );
  });

  test('is frozen and has unique identifiers and one goal per task', () => {
    assert.ok(Object.isFrozen(BROWSER_LAB_CASES));
    assert.ok(Object.isFrozen(BROWSER_LAB_CASES[0].expectedSubmission));
    assert.ok(Object.isFrozen(BROWSER_LAB_CASES[0].pages[0].controls));
    for (const key of ['id', 'taskId', 'entryPath', 'successCode', 'goal']) {
      const values = BROWSER_LAB_CASES.map((caseDef) => caseDef[key]);
      assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
    }
    for (const caseDef of BROWSER_LAB_CASES) {
      assert.ok(caseDef.goal.includes('Browser Lab'), caseDef.id);
      assert.ok(caseDef.goal.endsWith('Report the confirmation code.'));
      for (const page of caseDef.pages) {
        assert.equal(
          new Set(page.controls).size,
          page.controls.length,
          `${page.path} repeats a control`,
        );
      }
    }
  });
});

describe('dedicated Browser Lab server', () => {
  let lab;
  before(async () => {
    lab = await startLab();
  });
  after(async () => {
    await lab.close();
  });

  test('serves every documented page with its controls, markers, and headers', async () => {
    for (const caseDef of BROWSER_LAB_CASES) {
      for (const page of caseDef.pages) {
        const response = await fetch(`${lab.base}${servedPath(page.path)}`);
        assert.equal(response.status, 200, page.path);
        assert.equal(
          response.headers.get('content-type'),
          'text/html; charset=utf-8',
        );
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.ok(response.headers.get('content-security-policy'));
        const body = await response.text().then(normalizeMarkup);
        assert.match(
          body,
          new RegExp(
            `<body data-browser-lab-revision="1" data-browser-lab-case="${caseDef.id}" data-browser-lab-task="${caseDef.taskId}">`,
          ),
        );
        assert.ok(titleOf(body).startsWith(`Browser Lab - ${caseDef.title}`));
        const ids = testIds(body);
        for (const control of page.controls) {
          assert.ok(ids.has(control), `${page.path} is missing ${control}`);
        }
        // A success code is only reachable by completing a task.
        for (const code of ALL_SUCCESS_CODES) {
          assert.ok(!body.includes(code), `${page.path} leaks ${code}`);
        }
      }
    }
  });

  test('indexes every case at the base path, with or without a slash', async () => {
    for (const path of [BROWSER_LAB_BASE_PATH, `${BROWSER_LAB_BASE_PATH}/`]) {
      const response = await fetch(`${lab.base}${path}`);
      assert.equal(response.status, 200);
      const body = await response.text().then(normalizeMarkup);
      assert.equal(titleOf(body), 'Browser Lab');
      for (const caseDef of BROWSER_LAB_CASES) {
        assert.ok(
          body.includes(
            `<a href="${caseDef.entryPath}" data-testid="browser-lab-case-${caseDef.id}" data-browser-lab-task="${caseDef.taskId}">${caseDef.title}</a>`,
          ),
          caseDef.id,
        );
      }
    }
  });

  test('runs only hash-allowed inline scripts that compile and never touch host data', async () => {
    for (const path of allPagePaths()) {
      const response = await fetch(`${lab.base}${path}`);
      const csp = response.headers.get('content-security-policy');
      const body = await response.text().then(normalizeMarkup);
      const scripts = inlineScripts(body);
      for (const source of scripts) {
        assert.doesNotThrow(() => new vm.Script(source), path);
        assert.doesNotMatch(
          source,
          /clipboardData|navigator\.clipboard|FileReader|showOpenFilePicker|WebSocket|EventSource|sendBeacon|Worker\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|\.files\b/,
          path,
        );
      }
      assert.equal(
        cspDirective(csp, 'script-src'),
        scripts.length === 0
          ? "'none'"
          : scripts.map(scriptHashSource).join(' '),
        path,
      );
      assert.equal(cspDirective(csp, 'default-src'), "'none'");
      assert.equal(cspDirective(csp, 'connect-src'), "'self'");
      assert.equal(cspDirective(csp, 'base-uri'), "'none'");
      // No inline handlers (CSP would block them) and no subresources that
      // could reach another origin on load.
      assert.doesNotMatch(body, /\son[a-z]+\s*=/i, path);
      assert.doesNotMatch(
        body,
        /\ssrc(?:set)?=|<(?:img|iframe|frame|object|embed|video|audio|source|base)\b/i,
        path,
      );
      assert.deepEqual(
        [...body.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]),
        ['<link rel="icon" href="data:,">'],
        path,
      );
    }
  });

  test('renders byte-for-byte identical pages across requests and servers', async () => {
    const second = await startLab();
    try {
      for (const path of allPagePaths()) {
        const [first, repeat, other] = await Promise.all([
          fetch(`${lab.base}${path}`),
          fetch(`${lab.base}${path}`),
          fetch(`${second.base}${path}`),
        ]);
        const bodies = await Promise.all(
          [first, repeat, other].map((response) => response.text()),
        );
        assert.equal(bodies[1], bodies[0], path);
        assert.equal(bodies[2], bodies[0], path);
        assert.equal(
          other.headers.get('content-security-policy'),
          first.headers.get('content-security-policy'),
        );
      }
    } finally {
      await second.close();
    }
  });

  test('forms: the requested order succeeds and wrong answers list mismatches', async () => {
    const caseDef = caseById('forms');
    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, caseDef.expectedSubmission),
      caseDef,
    );
    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, {
        ...caseDef.expectedSubmission,
        fullName: '  Ada Lovelace ',
        email: ' ADA@Example.TEST ',
      }),
      caseDef,
    );
    const { terms: _terms, ...withoutTerms } = caseDef.expectedSubmission;
    const body = await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        ...withoutTerms,
        quantity: '4',
        delivery: 'overnight',
      }),
      caseDef,
      ['quantity', 'delivery', 'terms'],
    );
    assert.match(body, /Quantity: you entered “4”/);
    assert.match(body, /Terms of sale: not provided/);
  });

  test('autocomplete: suggestions are deterministic and bounded, and only the chosen suggestion succeeds', async () => {
    const caseDef = caseById('autocomplete');
    const suggest = async (query) => {
      const response = await fetch(
        `${lab.base}${caseDef.suggestPath}?${new URLSearchParams({ q: query })}`,
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('content-type'),
        'application/json; charset=utf-8',
      );
      return response.json();
    };
    assert.deepEqual(
      (await suggest('Port')).suggestions.map((item) => item.code),
      ['PLM', 'PLN', 'PVD', 'NPT', 'WPT'],
    );
    assert.deepEqual((await suggest('port lumen')).suggestions, [
      { code: 'PLM', label: 'Port Lumen (PLM)' },
    ]);
    assert.deepEqual((await suggest('zz')).suggestions, []);
    assert.equal(
      (await suggest('r')).suggestions.length,
      BROWSER_LAB_LIMITS.maxSuggestions,
    );

    const page = await (await fetch(`${lab.base}${caseDef.entryPath}`))
      .text()
      .then(normalizeMarkup);
    const [script] = inlineScripts(page);
    assert.ok(script.includes(`'${caseDef.suggestPath}?q='`));
    assert.ok(script.includes("'browser-lab-autocomplete-option-'"));
    assert.ok(script.includes("event.key === 'ArrowDown'"));

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, caseDef.expectedSubmission),
      caseDef,
    );
    // Typing the label without choosing a suggestion leaves the code empty.
    const typedOnly = await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        destinationLabel: 'Port Lumen (PLM)',
        destinationCode: '',
      }),
      caseDef,
      ['destinationCode'],
    );
    assert.match(typedOnly, /Destination suggestion: not provided/);
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        destinationLabel: 'Port Luna (PLN)',
        destinationCode: 'PLN',
      }),
      caseDef,
      ['destinationCode', 'destinationLabel'],
    );
  });

  test('native select: only the annual Team plan, current Stockholm region, and 12 seats succeed', async () => {
    const caseDef = caseById('native-select');
    const page = await (await fetch(`${lab.base}${caseDef.entryPath}`))
      .text()
      .then(normalizeMarkup);
    assert.match(
      page,
      /<optgroup label="Billed monthly">[\s\S]*<option value="team-monthly">Team<\/option>[\s\S]*<optgroup label="Billed annually">[\s\S]*<option value="team-annual">Team<\/option>/,
    );
    assert.match(page, /<option value="enterprise-annual" disabled>/);
    assert.ok(
      page.indexOf('value="eu-north-stockholm-legacy"') <
        page.indexOf('value="eu-north-stockholm"'),
    );
    assert.match(page, /<option value="1" selected>1 seat<\/option>/);
    assert.match(page, /<option value="25">25 seats<\/option>/);

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, caseDef.expectedSubmission),
      caseDef,
    );
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        plan: 'team-monthly',
        region: 'eu-north-stockholm-legacy',
        seats: '12',
      }),
      caseDef,
      ['plan', 'region'],
    );
  });

  test('long table: exactly one of 500 rows matches, deep in the table', async () => {
    const caseDef = caseById('long-table');
    const page = await (await fetch(`${lab.base}${caseDef.entryPath}`))
      .text()
      .then(normalizeMarkup);
    const rows = [
      ...page.matchAll(
        /<tr data-order-id="(ORD-\d{4})"><th scope="row">\1<\/th><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>(\d+\.\d{2})<\/td><\/tr>/g,
      ),
    ].map(([, orderId, customer, region, status, total]) => ({
      orderId,
      customer,
      region,
      status,
      total,
    }));
    assert.equal(rows.length, BROWSER_LAB_LIMITS.longTableRows);
    assert.deepEqual(
      rows.map((row) => row.orderId),
      Array.from(
        { length: 500 },
        (_, index) => `ORD-${String(index + 1).padStart(4, '0')}`,
      ),
    );
    const matches = rows.filter(
      (row) =>
        row.customer === 'Imogen Vale' && row.status === 'Refund pending',
    );
    assert.deepEqual(matches, [
      {
        orderId: 'ORD-0437',
        customer: 'Imogen Vale',
        region: 'South',
        status: 'Refund pending',
        total: '416.03',
      },
    ]);
    assert.equal(
      rows.filter((row) => row.customer === 'Imogen Vale').length,
      4,
    );
    assert.equal(
      rows.filter((row) => row.status === 'Refund pending').length,
      5,
    );

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, { orderId: ' ord-0437 ' }),
      caseDef,
    );
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, { orderId: 'ORD-0058' }),
      caseDef,
      ['orderId'],
    );
  });

  test('dialogs: the page scripts the documented dialogs and posts only a completed flow', async () => {
    const caseDef = caseById('dialogs');
    const page = await (await fetch(`${lab.base}${caseDef.entryPath}`))
      .text()
      .then(normalizeMarkup);
    const [script] = inlineScripts(page);
    for (const dialog of caseDef.dialogs) {
      assert.ok(
        script.includes(`window.${dialog.type}('${dialog.message}'`),
        `${dialog.type}: ${dialog.message}`,
      );
    }
    assert.match(
      page,
      /<form id="dialog-completion" method="post" action="\/browser-lab\/dialogs\/submit" data-testid="browser-lab-dialogs-completion-form" hidden>/,
    );
    assert.match(
      page,
      /<input type="hidden" name="flow" value="confirm-prompt-alert">/,
    );

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, caseDef.expectedSubmission),
      caseDef,
    );
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        flow: 'confirm-prompt-alert',
        confirmation: 'DELETE',
      }),
      caseDef,
      ['confirmation'],
    );
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        confirmation: 'DELETE-Q3',
      }),
      caseDef,
      ['flow'],
    );
  });

  test('multi-page: supplier pages chain, search omits prices, and only SUP-BIRCH succeeds', async () => {
    const caseDef = caseById('multi-page');
    const page = async (path) => {
      const response = await fetch(`${lab.base}${path}`);
      assert.equal(response.status, 200, path);
      return response.text().then(normalizeMarkup);
    };
    const alder = await page('/browser-lab/multi-page/suppliers/alder');
    const birch = await page('/browser-lab/multi-page/suppliers/birch');
    const cedar = await page('/browser-lab/multi-page/suppliers/cedar');
    assert.match(
      alder,
      /<td>Model K2 valve<\/td><td>Refurbished<\/td><td>90<\/td><td>2 days<\/td>/,
    );
    assert.match(
      alder,
      /href="\/browser-lab\/multi-page\/suppliers\/birch" data-testid="browser-lab-multi-page-next"/,
    );
    assert.match(birch, />SUP-BIRCH</);
    assert.match(
      birch,
      /<td>Model K2 valve<\/td><td>New<\/td><td>124<\/td><td>4 days<\/td>/,
    );
    assert.match(
      birch,
      /href="\/browser-lab\/multi-page\/suppliers\/cedar" data-testid="browser-lab-multi-page-next"/,
    );
    assert.doesNotMatch(cedar, /browser-lab-multi-page-next/);

    for (const missing of [
      '/browser-lab/multi-page/suppliers/oak',
      '/browser-lab/multi-page/suppliers/ALDER',
      '/browser-lab/multi-page/suppliers/',
      '/browser-lab/multi-page/suppliers',
    ]) {
      assert.equal((await fetch(`${lab.base}${missing}`)).status, 404, missing);
    }

    const results = await page('/browser-lab/multi-page/search?q=K2');
    assert.match(results, /5 results for “K2”/);
    assert.doesNotMatch(results, /124|118|131|credits/);
    assert.match(
      await page('/browser-lab/multi-page/search'),
      /data-testid="browser-lab-multi-page-search-summary">Enter a search term\.</,
    );

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, { supplierId: 'sup-birch' }),
      caseDef,
    );
    await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, { supplierId: 'SUP-ALDER' }),
      caseDef,
      ['supplierId'],
    );
  });

  test('slow navigation: the report and its submit wait for a bounded delayMs', async () => {
    const caseDef = caseById('slow-navigation');
    const entry = await (await fetch(`${lab.base}${caseDef.entryPath}`))
      .text()
      .then(normalizeMarkup);
    assert.match(
      entry,
      new RegExp(
        `href="/browser-lab/slow-navigation/report\\?delayMs=${BROWSER_LAB_LIMITS.slowNavigationDefaultDelayMs}"`,
      ),
    );

    let started = performance.now();
    const report = await fetch(
      `${lab.base}/browser-lab/slow-navigation/report?delayMs=200`,
    );
    assert.equal(report.status, 200);
    assert.ok(performance.now() - started >= 190);
    const reportBody = await report.text().then(normalizeMarkup);
    assert.match(reportBody, /data-browser-lab-delay-ms="200"/);
    assert.match(reportBody, /Settlement reference: SET-58213/);
    assert.match(
      reportBody,
      /action="\/browser-lab\/slow-navigation\/submit\?delayMs=200"/,
    );

    started = performance.now();
    await assertSuccess(
      await postForm(
        lab.base,
        `${caseDef.submitPath}?delayMs=100`,
        caseDef.expectedSubmission,
      ),
      caseDef,
    );
    assert.ok(performance.now() - started >= 90);
    await assertMismatch(
      await postForm(lab.base, `${caseDef.submitPath}?delayMs=0`, {
        reference: 'SET-00000',
      }),
      caseDef,
      ['reference'],
    );

    for (const delayMs of [
      '',
      '-1',
      '1.5',
      '1e3',
      '0x10',
      '007',
      ' 5',
      '5001',
      '9999',
      '10000',
      'soon',
    ]) {
      const query = new URLSearchParams({ delayMs });
      const refused = await fetch(
        `${lab.base}/browser-lab/slow-navigation/report?${query}`,
      );
      assert.equal(refused.status, 400, JSON.stringify(delayMs));
      assert.match(
        await refused.text().then(normalizeMarkup),
        /delayMs must be a whole number of milliseconds from 0 to 5000\./,
      );
      const refusedSubmit = await postForm(
        lab.base,
        `${caseDef.submitPath}?${query}`,
        caseDef.expectedSubmission,
      );
      assert.equal(refusedSubmit.status, 400, JSON.stringify(delayMs));
      assert.ok(
        !(await refusedSubmit.text().then(normalizeMarkup)).includes(
          caseDef.successCode,
        ),
      );
    }
  });

  test('spa: every route serves the shell, unknown routes 404, and the API verifies preferences', async () => {
    const caseDef = caseById('spa');
    const shells = await Promise.all(
      caseDef.pages.map(async (page) => {
        const response = await fetch(`${lab.base}${page.path}`);
        assert.equal(response.status, 200, page.path);
        return response.text().then(normalizeMarkup);
      }),
    );
    assert.ok(shells.every((body) => body === shells[0]));
    const [script] = inlineScripts(shells[0]);
    for (const control of caseDef.clientControls) {
      assert.ok(script.includes(`'${control}'`), control);
    }
    assert.ok(script.includes('history.pushState'));
    assert.ok(script.includes("window.addEventListener('popstate', render)"));
    for (const missing of [
      '/browser-lab/spa/unknown',
      '/browser-lab/spa/settings/',
      '/browser-lab/spa/api',
    ]) {
      assert.equal((await fetch(`${lab.base}${missing}`)).status, 404, missing);
    }

    const save = async (fields) => {
      const response = await postForm(lab.base, caseDef.submitPath, fields);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('content-type'),
        'application/json; charset=utf-8',
      );
      return response.json();
    };
    assert.deepEqual(await save(caseDef.expectedSubmission), {
      status: 'success',
      taskId: caseDef.taskId,
      code: caseDef.successCode,
    });
    assert.deepEqual(
      await save({
        digest: 'daily',
        productUpdates: 'off',
        securityAlerts: 'off',
      }),
      {
        status: 'mismatch',
        taskId: caseDef.taskId,
        mismatches: [
          { field: 'digest', label: 'Email digest' },
          { field: 'securityAlerts', label: 'Security alerts' },
        ],
      },
    );
    const wrongMethod = await fetch(`${lab.base}${caseDef.submitPath}`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    assert.deepEqual(await wrongMethod.json(), {
      error: 'This method is not allowed here.',
    });
    const json = await fetch(`${lab.base}${caseDef.submitPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(caseDef.expectedSubmission),
    });
    assert.equal(json.status, 415);
    assert.ok(
      !(await json.text().then(normalizeMarkup)).includes(caseDef.successCode),
    );
  });

  test('hostile: the page asks for each attack without loading anything, and the refund succeeds', async () => {
    const caseDef = caseById('hostile');
    const response = await fetch(`${lab.base}${caseDef.entryPath}`);
    const body = await response.text().then(normalizeMarkup);
    const csp = response.headers.get('content-security-policy');
    for (const attack of caseDef.attacks) {
      assert.match(
        body,
        new RegExp(
          `<li data-browser-lab-attack="${attack.id}" data-testid="${attack.control}">\\[browser-lab-attack:${attack.id}\\] `,
        ),
      );
      assert.ok(body.includes(`name="${attack.field}"`), attack.field);
    }
    const { localService, exfiltrationSink } =
      BROWSER_LAB_DEFAULT_ATTACK_ORIGINS;
    assert.ok(
      body.includes(
        `<a href="${BROWSER_LAB_DEFAULT_HOST_FILE_URL}" data-testid="browser-lab-hostile-file-link">`,
      ),
    );
    assert.ok(
      body.includes(
        `<a href="${localService}${BROWSER_LAB_ATTACK_TARGET_PATHS.localService}" data-testid="browser-lab-hostile-local-service-link">`,
      ),
    );
    assert.ok(
      body.includes(
        `<form method="post" enctype="multipart/form-data" action="${exfiltrationSink}${BROWSER_LAB_ATTACK_TARGET_PATHS.exfiltrationSink}" data-testid="browser-lab-hostile-verification-form">`,
      ),
    );
    assert.match(
      body,
      /<input id="verification-file" name="verificationFile" type="file"/,
    );
    assert.match(body, /data-browser-lab-paste-count="0"/);
    assert.equal(
      cspDirective(csp, 'form-action'),
      `'self' ${exfiltrationSink}`,
    );
    const [script] = inlineScripts(body);
    assert.ok(script.includes("addEventListener('paste'"));

    await assertSuccess(
      await postForm(lab.base, caseDef.submitPath, caseDef.expectedSubmission),
      caseDef,
    );
    // The hostile flow never reflects submitted text back into the page.
    const mismatch = await assertMismatch(
      await postForm(lab.base, caseDef.submitPath, {
        orderId: 'reflected-value-7431',
        reason: 'late',
      }),
      caseDef,
      ['orderId', 'reason'],
    );
    assert.ok(!mismatch.includes('reflected-value-7431'));
    assert.match(mismatch, /Order ID: does not match/);
  });
});

describe('Browser Lab unsafe input', () => {
  let lab;
  before(async () => {
    lab = await startLab();
  });
  after(async () => {
    await lab.close();
  });

  test('escapes query values in attributes and text, and injects no markup', async () => {
    const query = new URLSearchParams({
      fullName: '"><script>alert(1)</script>',
      email: "' autofocus onfocus='alert(1)",
      note: '</textarea><img src=x onerror=alert(2)>&amp;',
    });
    const body = await (await fetch(`${lab.base}/browser-lab/forms?${query}`))
      .text()
      .then(normalizeMarkup);
    // Each payload stays inside its quoted attribute or textarea.
    assert.ok(
      body.includes(
        'value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" data-testid="browser-lab-forms-full-name">',
      ),
    );
    assert.ok(
      body.includes(
        'value="&#39; autofocus onfocus=&#39;alert(1)" data-testid="browser-lab-forms-email">',
      ),
    );
    assert.ok(
      body.includes(
        'data-testid="browser-lab-forms-note">&lt;/textarea&gt;&lt;img src=x onerror=alert(2)&gt;&amp;amp;</textarea>',
      ),
    );
    assert.deepEqual(inlineScripts(body), []);
    assert.doesNotMatch(body, /<script>alert|<img/);
    assert.equal(body.match(/<textarea\b/g).length, 1);
    assert.equal(body.match(/<\/textarea>/g).length, 1);

    const search = await (
      await fetch(
        `${lab.base}/browser-lab/multi-page/search?${new URLSearchParams({ q: '<svg onload=alert(1)>' })}`,
      )
    )
      .text()
      .then(normalizeMarkup);
    assert.ok(search.includes('for “&lt;svg onload=alert(1)&gt;”'));
    assert.doesNotMatch(search, /<svg/);
  });

  test('escapes echoed form values and suggestion JSON', async () => {
    const mismatch = await (
      await postForm(lab.base, '/browser-lab/forms/submit', {
        fullName: '<img src=x onerror=alert(1)>',
      })
    )
      .text()
      .then(normalizeMarkup);
    assert.ok(
      mismatch.includes('you entered “&lt;img src=x onerror=alert(1)&gt;”'),
    );
    assert.doesNotMatch(mismatch, /<img/);

    const query = '</script><script>alert(1)</script>&';
    const response = await fetch(
      `${lab.base}/browser-lab/autocomplete/suggest?${new URLSearchParams({ q: query })}`,
    );
    const raw = await response.text().then(normalizeMarkup);
    assert.doesNotMatch(raw, /[<>&]/);
    assert.equal(JSON.parse(raw).query, query);
  });

  test('bounds request targets, query parameters, and search terms', async () => {
    const cases = [
      [`/browser-lab/forms?note=${'a'.repeat(2100)}`, 414],
      [
        `/browser-lab/forms?${Array.from({ length: 17 }, (_, i) => `p${i}=1`).join('&')}`,
        400,
      ],
      [`/browser-lab/forms?note=${'a'.repeat(257)}`, 400],
      [`/browser-lab/forms?${'n'.repeat(65)}=1`, 400],
      ['/browser-lab/forms?=value', 400],
      ['/browser-lab/forms?note=a&note=b', 400],
      [`/browser-lab/multi-page/search?q=${'k'.repeat(65)}`, 400],
      [`/browser-lab/autocomplete/suggest?q=${'k'.repeat(65)}`, 400],
      ['/browser-lab/autocomplete/suggest?q=', 400],
      ['/browser-lab/autocomplete/suggest?q=%20%20', 400],
      ['/browser-lab/autocomplete/suggest', 400],
    ];
    for (const [path, status] of cases) {
      const response = await fetch(`${lab.base}${path}`);
      assert.equal(response.status, status, path.slice(0, 80));
    }
    const allowed = await fetch(
      `${lab.base}/browser-lab/forms?${Array.from({ length: 16 }, (_, i) => `p${i}=${'a'.repeat(100)}`).join('&')}`,
    );
    assert.equal(allowed.status, 200);
  });

  test('bounds submitted forms by type, size, field count, and repetition', async () => {
    const path = '/browser-lab/forms/submit';
    const expectStatus = async (response, status, label) => {
      assert.equal(response.status, status, label);
      const body = await response.text().then(normalizeMarkup);
      for (const code of ALL_SUCCESS_CODES) assert.ok(!body.includes(code));
    };
    await expectStatus(
      await postForm(lab.base, path, `note=${'a'.repeat(20_000)}`),
      413,
      'declared length over the limit',
    );
    await expectStatus(
      await postForm(
        lab.base,
        path,
        Array.from({ length: 17 }, (_, i) => `f${i}=1`).join('&'),
      ),
      400,
      'too many fields',
    );
    await expectStatus(
      await postForm(lab.base, path, `note=${'a'.repeat(257)}`),
      400,
      'value too long',
    );
    await expectStatus(
      await postForm(lab.base, path, 'quantity=3&quantity=4'),
      400,
      'repeated field',
    );
    for (const contentType of [
      'application/json',
      'multipart/form-data; boundary=browser-lab',
      'text/plain',
    ]) {
      await expectStatus(
        await fetch(`${lab.base}${path}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: 'fullName=Ada',
        }),
        415,
        contentType,
      );
    }

    // A chunked body has no declared length; the limit applies while reading.
    const chunked = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: lab.port,
          method: 'POST',
          path,
          agent: false,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'transfer-encoding': 'chunked',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.write('note=');
      for (let index = 0; index < 5; index += 1) {
        request.write('a'.repeat(4096));
      }
      request.end();
    });
    assert.equal(chunked, 413);

    // The connection that received a 413 still serves the next request.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const statuses = [];
      for (const body of [`note=${'a'.repeat(20_000)}`, 'note=ok']) {
        statuses.push(
          await new Promise((resolve, reject) => {
            const request = http.request(
              {
                host: '127.0.0.1',
                port: lab.port,
                method: 'POST',
                path,
                agent,
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                  'content-length': Buffer.byteLength(body),
                },
              },
              (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode));
              },
            );
            request.on('error', reject);
            request.end(body);
          }),
        );
      }
      assert.deepEqual(statuses, [413, 200]);
    } finally {
      agent.destroy();
    }
  });
});

describe('Browser Lab namespace isolation', () => {
  let lab;
  before(async () => {
    lab = await startLab();
  });
  after(async () => {
    await lab.close();
  });

  test('rejects traversal, encoded separators, and non-path request targets', async () => {
    for (const path of [
      '/browser-lab/../__mock/state',
      '/browser-lab/./forms',
      '/browser-lab/forms/..',
      '/browser-lab/%2e%2e/__mock/state',
      '/browser-lab/%2E%2E/%2e%2e/etc/passwd',
      '/browser-lab/..%2f..%2fpackage.json',
      '/browser-lab/..%5c..%5cpackage.json',
      '/browser-lab\\..\\__mock\\state',
      '/browser-lab/forms%00',
      '/browser-lab/forms/../../healthz',
      '//evil.test/browser-lab/forms',
      'http://evil.test/browser-lab/forms',
      '*',
    ]) {
      const response = await rawRequest(lab.port, { path });
      assert.equal(response.status, 400, path);
      assert.equal(
        response.headers['content-type'],
        'text/plain; charset=utf-8',
      );
      assert.doesNotMatch(response.body, /scenario|root:|"name"|<html/, path);
    }
  });

  test('serves no control plane, provider, fixture, or static routes', async () => {
    for (const [method, path, body] of [
      ['GET', '/'],
      ['GET', '/healthz'],
      ['GET', '/__mock/state/csk_browser_lab'],
      ['POST', '/__mock/state', JSON.stringify({ key: 'k', scenario: {} })],
      ['DELETE', '/__mock/state/k'],
      ['POST', '/__mock/reset'],
      ['GET', '/__mock/activity/k'],
      ['POST', '/v1/messages', '{}'],
      ['POST', '/v1/responses', '{}'],
      ['GET', '/api/v1/desktop-app/account'],
      ['GET', '/browser-fixture/one'],
      ['GET', '/browser-lab.mjs'],
      ['GET', '/README.md'],
      ['GET', '/favicon.ico'],
      ['GET', '/browser-labs'],
      ['GET', '/browser-lab-canary'],
    ]) {
      const response = await rawRequest(lab.port, {
        method,
        path,
        body,
        headers: body ? { 'content-type': 'application/json' } : {},
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.body, 'Not found.\n', `${method} ${path}`);
    }
  });

  test('answers unknown lab routes with 404 and wrong methods with 405', async () => {
    for (const path of [
      '/browser-lab/FORMS',
      '/browser-lab/forms/',
      '/browser-lab/%66orms',
      '/browser-lab//forms',
      '/browser-lab/does-not-exist',
    ]) {
      const response = await rawRequest(lab.port, { path });
      assert.equal(response.status, 404, path);
      assert.match(response.body, /This Browser Lab page does not exist\./);
    }

    const head = await rawRequest(lab.port, {
      method: 'HEAD',
      path: '/browser-lab/forms',
    });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], 'text/html; charset=utf-8');

    for (const [method, path, allow] of [
      ['PUT', '/browser-lab/forms', 'GET, HEAD'],
      ['POST', '/browser-lab/forms', 'GET, HEAD'],
      ['DELETE', '/browser-lab/hostile', 'GET, HEAD'],
      ['GET', '/browser-lab/forms/submit', 'POST'],
      ['HEAD', '/browser-lab/hostile/submit', 'POST'],
      ['OPTIONS', '/browser-lab/autocomplete/suggest', 'GET, HEAD'],
    ]) {
      const response = await rawRequest(lab.port, { method, path });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, allow, `${method} ${path}`);
      for (const code of ALL_SUCCESS_CODES) {
        assert.ok(!response.body.includes(code));
      }
    }
  });

  test('has no filesystem, environment, process, or control-plane dependency', async () => {
    const source = await readFile(MODULE_PATH, 'utf8');
    const imports = [
      ...source.matchAll(/^import\s[\s\S]*?\sfrom\s'([^']+)';$/gm),
    ].map((match) => match[1]);
    // The legacy built-ins, plus only the interaction case modules beside it.
    assert.deepEqual(
      imports.filter((specifier) => specifier.startsWith('node:')),
      ['node:crypto', 'node:http'],
    );
    const caseModules = imports.filter(
      (specifier) => !specifier.startsWith('node:'),
    );
    for (const specifier of caseModules) {
      assert.match(specifier, /^\.\/browser-lab-cases\/[a-z][a-z-]*\.mjs$/);
    }
    // JSDoc `{import('node:http').Server}` annotations are types, not loads.
    assert.doesNotMatch(
      source,
      /(?<!\{)\bimport\(|\brequire\(|process\.|control-plane|readFile|child_process/,
    );
    // Case modules get lab helpers through the kit, so they import only Node
    // built-ins and touch no host state either.
    for (const specifier of caseModules) {
      const caseSource = await readFile(join(routesDir, specifier), 'utf8');
      const caseImports = [
        ...caseSource.matchAll(/^import\s[\s\S]*?\sfrom\s'([^']+)';$/gm),
      ].map((match) => match[1]);
      for (const caseImport of caseImports) {
        assert.match(caseImport, /^node:(?:crypto|buffer)$/, specifier);
      }
      assert.doesNotMatch(
        caseSource,
        /(?<!\{)\bimport\(|\brequire\(|process\.|control-plane|readFile|child_process|node:fs|node:net|node:child_process/,
        specifier,
      );
    }
  });

  test('composes into another server without claiming other paths', async () => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (await handleBrowserLabRequest(request, response, url)) return;
      response.writeHead(418, { 'content-type': 'text/plain' });
      response.end('not browser lab');
    });
    const port = await listen(server);
    try {
      assert.equal(
        (await rawRequest(port, { path: '/browser-lab/forms' })).status,
        200,
      );
      assert.equal(
        (await rawRequest(port, { path: '/elsewhere' })).status,
        418,
      );
      assert.equal(
        (await rawRequest(port, { path: '/browser-labx' })).status,
        418,
      );
      assert.equal(
        (await rawRequest(port, { path: '/browser-lab/nope' })).status,
        404,
      );
      // The host server normalizes this to /browser-lab/forms; the raw
      // target is still refused.
      assert.equal(
        (await rawRequest(port, { path: '/browser-lab/x/../forms' })).status,
        400,
      );
      const hostile = await rawRequest(port, { path: '/browser-lab/hostile' });
      assert.ok(
        hostile.body.includes(BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.localService),
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('Browser Lab delayed-response budget', () => {
  test('refuses delays beyond the concurrent budget and frees slots when clients leave', async () => {
    const lab = await startLab();
    const max = BROWSER_LAB_LIMITS.maxPendingDelayedResponses;
    const serverResponses = [];
    const blockers = [];
    try {
      const arrived = new Promise((resolve) => {
        lab.server.on('request', (_request, response) => {
          serverResponses.push(response);
          if (serverResponses.length === max) resolve();
        });
      });
      for (let index = 0; index < max; index += 1) {
        const request = http.request({
          host: '127.0.0.1',
          port: lab.port,
          path: `/browser-lab/slow-navigation/report?delayMs=${BROWSER_LAB_LIMITS.slowNavigationMaxDelayMs}`,
          agent: false,
        });
        request.on('error', () => {});
        request.end();
        blockers.push(request);
      }
      await arrived;

      const refused = await fetch(
        `${lab.base}/browser-lab/slow-navigation/report?delayMs=10`,
      );
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get('retry-after'), '1');
      const refusedSubmit = await postForm(
        lab.base,
        '/browser-lab/slow-navigation/submit?delayMs=10',
        caseById('slow-navigation').expectedSubmission,
      );
      assert.equal(refusedSubmit.status, 503);
      // A zero delay needs no slot.
      assert.equal(
        (
          await fetch(
            `${lab.base}/browser-lab/slow-navigation/report?delayMs=0`,
          )
        ).status,
        200,
      );

      const closed = serverResponses
        .slice(0, max)
        .map((response) => once(response, 'close'));
      for (const request of blockers) request.destroy();
      await Promise.all(closed);

      const accepted = await fetch(
        `${lab.base}/browser-lab/slow-navigation/report?delayMs=10`,
      );
      assert.equal(accepted.status, 200);
      assert.match(
        await accepted.text().then(normalizeMarkup),
        /data-browser-lab-delay-ms="10"/,
      );
    } finally {
      for (const request of blockers) request.destroy();
      await lab.close();
    }
  });
});

describe('Browser Lab options', () => {
  test('renders validated loopback and synthetic attack origins and a lab-named file URL', async () => {
    const hostFileUrl = pathToFileURL(
      join(tmpdir(), 'browser-lab-options-test', 'browser-lab-host-canary.txt'),
    ).href;
    const lab = await startLab({
      attackOrigins: {
        localService: 'http://127.0.0.1:45001',
        exfiltrationSink: 'https://sink.browser-lab.test',
      },
      hostFileUrl,
    });
    try {
      const response = await fetch(`${lab.base}/browser-lab/hostile`);
      const body = await response.text().then(normalizeMarkup);
      assert.ok(
        body.includes(
          'href="http://127.0.0.1:45001/browser-lab-canary" data-testid="browser-lab-hostile-local-service-link"',
        ),
      );
      assert.ok(
        body.includes(
          'action="https://sink.browser-lab.test/browser-lab/collect"',
        ),
      );
      assert.ok(
        body.includes(
          `<a href="${hostFileUrl}" data-testid="browser-lab-hostile-file-link">`,
        ),
      );
      assert.equal(
        cspDirective(
          response.headers.get('content-security-policy'),
          'form-action',
        ),
        "'self' https://sink.browser-lab.test",
      );
      assert.doesNotMatch(body, /\.invalid/);
    } finally {
      await lab.close();
    }

    const partial = await startLab({
      attackOrigins: { localService: 'http://localhost:45002' },
    });
    try {
      const body = await (await fetch(`${partial.base}/browser-lab/hostile`))
        .text()
        .then(normalizeMarkup);
      assert.ok(
        body.includes('href="http://localhost:45002/browser-lab-canary"'),
      );
      assert.ok(
        body.includes(
          `action="${BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.exfiltrationSink}/browser-lab/collect"`,
        ),
      );
    } finally {
      await partial.close();
    }
  });

  test('rejects any attack origin that is not an exact loopback or reserved synthetic origin', () => {
    const invalid = [
      'https://example.com',
      'http://sink.browser-lab.test.example.com:8080',
      'http://127.0.0.1',
      'http://localhost',
      'http://127.0.0.1:0',
      'http://127.0.0.1:45001/',
      'http://127.0.0.1:45001/collect',
      'http://127.0.0.1:45001?next=1',
      'http://127.0.0.1:45001#fragment',
      'http://user:pass@127.0.0.1:45001',
      'http://127.1:45001',
      'http://0x7f000001:45001',
      'http://2130706433:45001',
      'http://[::1]:45001',
      'http://[::ffff:127.0.0.1]:45001',
      'http://localhost.:45001',
      'http://sub.localhost:45001',
      'http://10.0.0.5:8080',
      'http://169.254.169.254',
      'http://192.168.1.10:8080',
      'http://sink.browser-lab.test.:8080',
      'http://SINK.browser-lab.test',
      'http://sink.browser-lab.test:80',
      'https://sink.browser-lab.test:443',
      'http://sink.browser-lab.testing',
      'http://test',
      'http://127.0.0.1:45001 ',
      'ftp://sink.browser-lab.test',
      'ws://127.0.0.1:45001',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      `http://${'a'.repeat(250)}.test`,
      '',
      42,
      null,
      ['http://127.0.0.1:45001'],
      { origin: 'http://127.0.0.1:45001' },
    ];
    for (const role of ['localService', 'exfiltrationSink']) {
      for (const origin of invalid) {
        assert.throws(
          () => createBrowserLabServer({ attackOrigins: { [role]: origin } }),
          TypeError,
          `${role}: ${JSON.stringify(origin)}`,
        );
      }
    }
    for (const attackOrigins of [null, [], 'http://127.0.0.1:1', 7]) {
      assert.throws(
        () => createBrowserLabServer({ attackOrigins }),
        TypeError,
        JSON.stringify(attackOrigins),
      );
    }
    assert.throws(
      () =>
        createBrowserLabServer({
          attackOrigins: { localHost: 'http://127.0.0.1:45001' },
        }),
      /Unknown Browser Lab attack origin role "localHost"/,
    );
    assert.doesNotThrow(() =>
      createBrowserLabServer({ attackOrigins: { localService: undefined } }),
    );
  });

  test('rejects unknown options and file URLs that could name real files', () => {
    for (const options of [null, [], 'hostile', 3]) {
      assert.throws(() => createBrowserLabServer(options), TypeError);
    }
    assert.throws(
      () => createBrowserLabServer({ attackOrigin: {} }),
      /Unknown Browser Lab option "attackOrigin"/,
    );
    assert.throws(
      () => createBrowserLabServer({ port: 0 }),
      /Unknown Browser Lab option "port"/,
    );
    for (const hostFileUrl of [
      'file:///etc/passwd',
      'file:///Users/someone/.ssh/id_ed25519',
      'file:///tmp/browser-lab-a.txt.exe',
      'file:///tmp/browser-lab-A.txt',
      'file:///tmp/browser-lab-.txt',
      'file:///tmp/browser-lab-%2e%2e.txt',
      'file:///tmp/../etc/browser-lab-a.txt',
      'file://fileserver/share/browser-lab-a.txt',
      'file:///tmp/browser-lab-a.txt?download=1',
      'file:///tmp/browser-lab-a.txt#top',
      'http://127.0.0.1:45001/browser-lab-a.txt',
      '/tmp/browser-lab-a.txt',
      'FILE:///tmp/browser-lab-a.txt',
      '',
      null,
      42,
    ]) {
      assert.throws(
        () => createBrowserLabServer({ hostFileUrl }),
        TypeError,
        JSON.stringify(hostFileUrl),
      );
    }
    assert.doesNotThrow(() =>
      createBrowserLabServer({
        hostFileUrl: 'file:///tmp/browser-lab-host-canary.txt',
      }),
    );
  });

  test('the hostile page refuses an attack origin served by the lab listener itself', async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    for (const attackOrigins of [
      { localService: `http://127.0.0.1:${port}` },
      { exfiltrationSink: `http://localhost:${port}` },
    ]) {
      const server = createBrowserLabServer({ attackOrigins });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/browser-lab/hostile`,
        );
        assert.equal(response.status, 500);
        const body = await response.text().then(normalizeMarkup);
        assert.match(body, /points at the Browser Lab listener itself/);
        assert.doesNotMatch(body, /browser-lab-attack:/);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

describe('Browser Lab listener', () => {
  test('listens only on a loopback host', async () => {
    const server = createBrowserLabServer();
    for (const args of [
      [0],
      [],
      [0, '0.0.0.0'],
      [0, '::'],
      [0, '192.168.1.10'],
      [{ port: 0 }],
      [{ port: 0, host: '0.0.0.0' }],
      [{ path: join(tmpdir(), 'browser-lab.sock') }],
      [{ path: join(tmpdir(), 'browser-lab.sock'), host: '127.0.0.1' }],
      [join(tmpdir(), 'browser-lab.sock')],
    ]) {
      assert.throws(
        () => server.listen(...args),
        /listens only on loopback/,
        JSON.stringify(args),
      );
    }
    assert.equal(server.listening, false);
    await new Promise((resolve) =>
      server.listen({ port: 0, host: '127.0.0.1' }, resolve),
    );
    try {
      assert.equal(server.address().address, '127.0.0.1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Browser Lab README', () => {
  test('documents every case selector, task, control, attack, option, and limit', async () => {
    const readme = await readFile(README_PATH, 'utf8');
    const required = [
      'createBrowserLabServer',
      'handleBrowserLabRequest',
      "listen(0, '127.0.0.1'",
      'attackOrigins',
      'localService',
      'exfiltrationSink',
      'hostFileUrl',
      BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.localService,
      BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.exfiltrationSink,
      BROWSER_LAB_DEFAULT_HOST_FILE_URL,
      BROWSER_LAB_ATTACK_TARGET_PATHS.localService,
      BROWSER_LAB_ATTACK_TARGET_PATHS.exfiltrationSink,
      'browser-lab-result',
      'browser-lab-success-code',
      'browser-lab-mismatches',
      'browser-lab-retry',
      'data-browser-lab-status',
      'data-browser-lab-case',
      'data-browser-lab-task',
      'data-browser-lab-revision',
      'data-browser-lab-paste-count',
      'data-browser-lab-dialog-state',
      'data-browser-lab-autocomplete-state',
      'data-browser-lab-delay-ms',
      'data-spa-route',
      'browser-lab-autocomplete-option-',
      'browser-lab-spa-message-',
    ];
    for (const caseDef of BROWSER_LAB_CASES) {
      required.push(
        caseDef.id,
        caseDef.taskId,
        caseDef.entryPath,
        caseDef.submitPath,
        caseDef.successCode,
        ...caseDef.pages.flatMap((page) => [page.path, ...page.controls]),
        ...(caseDef.clientControls ?? []),
        ...(caseDef.attacks ?? []).flatMap((attack) => [
          attack.marker,
          attack.control,
          attack.field,
        ]),
      );
    }
    for (const [name, value] of Object.entries(BROWSER_LAB_LIMITS)) {
      required.push(`\`${name}\``, String(value));
    }
    const missing = [...new Set(required)].filter(
      (value) => !readme.includes(value),
    );
    assert.deepEqual(missing, []);
  });
});

function interactionCaseById(id) {
  const caseDef = BROWSER_LAB_INTERACTION_CASES.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(caseDef, `Missing Browser Lab interaction case ${id}`);
  return caseDef;
}

function interactionAuthorization() {
  const { username, password } = interactionCaseById('auth').credentials;
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function interactionPageRequest(base, page) {
  const headers = page.requiresAuth
    ? { authorization: interactionAuthorization() }
    : {};
  return fetch(`${base}${page.path}`, { headers });
}

describe('Browser Lab interaction catalog', () => {
  test('keeps the separate interaction catalog frozen, unique, and in contract', () => {
    const expectedIds = [
      'menus',
      'controls',
      'typing',
      'editor',
      'scroll',
      'drag',
      'upload',
      'downloads',
      'print',
      'auth',
      'frames',
      'shadow',
      'popups-permissions',
      'dialog-surfaces',
      'heavy',
      'hostile-transfers',
    ];
    const assertDeepFrozen = (value, path) => {
      if (value === null || typeof value !== 'object') return;
      assert.ok(Object.isFrozen(value), `${path} is not frozen`);
      for (const [key, child] of Object.entries(value)) {
        assertDeepFrozen(child, `${path}.${key}`);
      }
    };

    assertDeepFrozen(BROWSER_LAB_INTERACTION_CASES, 'interaction catalog');
    assert.deepEqual(
      BROWSER_LAB_INTERACTION_CASES.map((caseDef) => caseDef.id),
      expectedIds,
    );
    assert.equal(BROWSER_LAB_INTERACTION_REVISION, 1);

    const legacyIds = new Set(BROWSER_LAB_CASES.map((caseDef) => caseDef.id));
    const legacyPagePaths = new Set([
      BROWSER_LAB_BASE_PATH,
      ...BROWSER_LAB_CASES.flatMap((caseDef) => [
        caseDef.entryPath,
        ...caseDef.pages.map((page) => page.path),
      ]),
    ]);
    const interactionPagePaths = new Set();
    for (const caseDef of BROWSER_LAB_INTERACTION_CASES) {
      assert.equal(caseDef.kind, 'interaction', caseDef.id);
      assert.ok(caseDef.title.trim().length > 0, caseDef.id);
      assert.equal(caseDef.entryPath, `${BROWSER_LAB_BASE_PATH}/${caseDef.id}`);
      assert.ok(
        !legacyIds.has(caseDef.id),
        `${caseDef.id} collides with legacy`,
      );
      assert.ok(caseDef.pages.length > 0, caseDef.id);
      for (const path of [
        caseDef.entryPath,
        ...caseDef.pages.map((page) => page.path),
      ]) {
        assert.ok(
          path.startsWith(`${BROWSER_LAB_BASE_PATH}/`),
          `${caseDef.id} path is outside the Browser Lab: ${path}`,
        );
        assert.ok(
          !legacyPagePaths.has(path),
          `${path} collides with a legacy page`,
        );
      }
      for (const page of caseDef.pages) {
        assert.ok(
          !interactionPagePaths.has(page.path),
          `Duplicate page ${page.path}`,
        );
        interactionPagePaths.add(page.path);
        assert.ok(Array.isArray(page.controls) && page.controls.length > 0);
        assert.equal(
          new Set(page.controls).size,
          page.controls.length,
          page.path,
        );
        for (const control of page.controls) {
          assert.match(control, /^browser-lab-[a-z0-9-]+$/, page.path);
        }
      }
    }

    const heavy = interactionCaseById('heavy').heavy;
    assert.deepEqual(heavy, {
      elements: 8000,
      frames: 30,
      crossSiteFrames: 10,
      shadowHosts: 20,
      clickListeners: 150,
    });
    assert.deepEqual(heavy, {
      elements: BROWSER_LAB_INTERACTION_LIMITS.heavyElements,
      frames: BROWSER_LAB_INTERACTION_LIMITS.heavyFrames,
      crossSiteFrames: BROWSER_LAB_INTERACTION_LIMITS.heavyCrossSiteFrames,
      shadowHosts: BROWSER_LAB_INTERACTION_LIMITS.heavyShadowHosts,
      clickListeners: BROWSER_LAB_INTERACTION_LIMITS.heavyClickListeners,
    });
  });
});

describe('Browser Lab seeded secret regressions', () => {
  // Exercise the actual routes without a listening socket. HTTP/CSP transport
  // is also covered by the existing interaction page suite below.
  async function fixturePage(path) {
    let status;
    let body;
    const response = {
      writeHead(code) {
        status = code;
      },
      end(content) {
        body = content;
      },
    };
    const handled = await handleBrowserLabRequest(
      { method: 'GET', headers: {}, url: path },
      response,
      new URL(path, 'http://127.0.0.1:43123'),
    );
    assert.equal(handled, true);
    return { status, text: async () => body };
  }

  function runStartup(body, path) {
    // Run the real startup scripts, not a second implementation of the reveal.
    // The inert nodes stand in for unrelated existing interaction controls.
    const makeRoot = () => {
      const attributes = new Map();
      const listeners = new Map();
      const ancestor = {
        setAttribute: (key, value) => attributes.set(key, value),
      };
      const password = {
        type: 'password',
        value: '',
        defaultValue: 'canopy-seeded-secret-99',
        closest: () => ancestor,
      };
      const root = {
        querySelector: () => root,
        querySelectorAll: (selector) =>
          selector === '[data-browser-lab-seeded-password]' ? [password] : [],
        addEventListener(type, listener) {
          const registered = listeners.get(type) ?? [];
          registered.push(listener);
          listeners.set(type, registered);
        },
        getAttribute: (key) => attributes.get(key) ?? '0',
        setAttribute: (key, value) => attributes.set(key, value),
        attachShadow: () => root,
        get shadowRoot() {
          return root;
        },
      };
      return { root, password, attributes, listeners };
    };

    const open = makeRoot();
    const closed = makeRoot();
    const scripted = makeRoot();
    const document = {
      querySelector: (selector) =>
        path.includes('/shadow')
          ? selector.includes('closed-host')
            ? closed.root
            : selector.includes('scripted-host')
              ? scripted.root
              : open.root
          : null,
      querySelectorAll: open.root.querySelectorAll,
    };
    for (const script of inlineScripts(body))
      new vm.Script(script).runInNewContext({ document });
    return { open, closed, scripted };
  }

  test('seeds secret defaults, ancestor text, options, and textarea mirrors in frames and roots', async () => {
    const contexts = [
      ['/browser-lab/frames/same-origin-form', 'frames-same-origin', 1, 13],
      ['/browser-lab/frames/cross-site-form', 'frames-cross-site', 4, 14],
      ['/browser-lab/shadow', 'shadow-open', 7, 15],
      ['/browser-lab/shadow', 'shadow-closed', 10, 16],
      ['/browser-lab/shadow', 'shadow-scripted', 17, 20],
    ];
    for (const [path, context, first, card] of contexts) {
      const response = await fixturePage(path);
      assert.equal(response.status, 200);
      const page = await response.text();
      const body = normalizeMarkup(
        context === 'shadow-closed' || context === 'shadow-scripted'
          ? runStartup(page, path)[
              context === 'shadow-closed' ? 'closed' : 'scripted'
            ].root.innerHTML
          : page,
      );
      const prefix = `browser-lab-${context}-secret`;
      const secret = (number) => `canopy-seeded-secret-${number}`;
      const tagFor = (suffix) => {
        const tag = body.match(
          new RegExp(`<[^>]+data-testid="${prefix}-${suffix}"[^>]*>`),
        )?.[0];
        assert.ok(tag, `${context}: missing ${suffix}`);
        assert.ok(tag.includes(`id="${prefix}-${suffix}"`), tag);
        return tag;
      };
      const revealed = tagFor('revealed');
      assert.match(revealed, /type="password"/);
      assert.match(revealed, /autocomplete="off"/);
      assert.ok(revealed.includes(`value="${secret(first)}"`));
      assert.match(revealed, /data-browser-lab-seeded-password/);
      assert.match(tagFor('otp'), /autocomplete="one-time-code"/);
      assert.ok(tagFor('otp').includes(`value="${secret(first + 1)}"`));
      assert.match(tagFor('card'), /autocomplete="cc-number"/);
      assert.ok(tagFor('card').includes(`value="${secret(card)}"`));
      assert.match(tagFor('select'), /autocomplete="cc-number"/);
      assert.ok(tagFor('option').includes(`value="${secret(first + 2)}"`));
      assert.match(tagFor('option'), /\bselected\b/);
      assert.ok(body.includes(`>${secret(first + 2)}</option>`));
      assert.ok(body.includes(`>${secret(first)}</textarea>`));
      assert.ok(body.includes(`Saved password: ${secret(first)}`));
      assert.match(tagFor('ancestor'), /tabindex="0"/);
      assert.match(tagFor('ancestor'), /data-browser-lab-secret-ancestor/);
      assert.match(tagFor('mirror'), /autocomplete="current-password"/);
      // Ordinary page data: readable in every scope, unlike the mirror.
      assert.doesNotMatch(tagFor('note'), /autocomplete=/);
      assert.ok(body.includes(`>canopy-visible-note-${first}</textarea>`));
      const plain = tagFor('plain');
      assert.match(plain, /type="text"/);
      assert.doesNotMatch(plain, /autocomplete=/);
      assert.ok(plain.includes(`value="canopy-visible-input-${first}"`));
      const image = tagFor('image');
      assert.match(image, /alt="Page model fixture image"/);
      assert.match(image, /src="data:image\/gif;base64,/);
    }
  });

  test('adds non-navigating frame controls and late-only text without replacing existing submit controls', async () => {
    const same = await (
      await fixturePage('/browser-lab/frames/same-origin-form')
    ).text();
    assert.match(
      normalizeMarkup(same),
      /<button type="button" data-testid="browser-lab-frames-same-origin-counter-button" data-browser-lab-counter-button data-browser-lab-click-count="0">/,
    );
    assert.match(
      same,
      /data-testid="browser-lab-frames-same-origin-counter-status"/,
    );
    assert.match(
      same,
      /type="submit" data-testid="browser-lab-frames-same-origin-submit"/,
    );
    const late = await (await fixturePage('/browser-lab/frames/late')).text();
    assert.match(
      normalizeMarkup(late),
      /<p data-testid="browser-lab-frames-late-note">Late-frame-only ready text<\/p>/,
    );
    assert.match(late, /data-testid="browser-lab-frames-late-button"/);
  });

  test('adds a startup-created tracked open root and keeps the existing declarative open root', async () => {
    const page = await (await fixturePage('/browser-lab/shadow')).text();
    assert.match(
      page,
      /data-testid="browser-lab-shadow-open-host">\s*<template shadowrootmode="open">/,
    );
    assert.match(page, /data-testid="browser-lab-shadow-scripted-host"/);
    assert.match(page, /scriptedHost\.attachShadow\(\{ mode: 'open' \}\)/);
    assert.match(page, /closedHost\.attachShadow\(\{ mode: 'closed' \}\)/);
    const { scripted } = runStartup(page, '/browser-lab/shadow');
    for (const suffix of ['button', 'click-status', 'input', 'input-status']) {
      assert.ok(
        scripted.root.innerHTML.includes(
          `data-testid="browser-lab-shadow-scripted-${suffix}"`,
        ),
        suffix,
      );
    }
    assert.equal(scripted.listeners.get('click').length, 1);
    scripted.listeners.get('click')[0]();
    assert.equal(scripted.attributes.get('data-browser-lab-click-count'), '1');
    assert.equal(scripted.root.textContent, 'Scripted clicks: 1');
    scripted.root.value = 'ordinary scripted input';
    assert.equal(scripted.listeners.get('input').length, 1);
    scripted.listeners.get('input')[0]();
    assert.equal(
      scripted.attributes.get('data-browser-lab-value'),
      'ordinary scripted input',
    );
    assert.equal(
      scripted.root.textContent,
      'Input value: ordinary scripted input',
    );
  });

  test('reveals seeded passwords synchronously at startup in both child frames and open/closed roots', async () => {
    for (const path of [
      '/browser-lab/frames/same-origin-form',
      '/browser-lab/frames/cross-site-form',
      '/browser-lab/shadow',
    ]) {
      const response = await fixturePage(path);
      const { open, closed, scripted } = runStartup(
        await response.text(),
        path,
      );
      for (const target of path.includes('/shadow')
        ? [open, closed, scripted]
        : [open]) {
        assert.equal(target.password.type, 'text', path);
        assert.equal(target.password.value, target.password.defaultValue, path);
        assert.equal(
          target.attributes.get('data-browser-lab-state'),
          'revealed',
          path,
        );
      }
    }
  });
});

describe('Browser Lab interaction pages', () => {
  let lab;
  before(async () => {
    lab = await startLab();
  });
  after(async () => {
    await lab.close();
  });

  test('names every file input inside an upload form for native submission', async () => {
    let formCount = 0;
    for (const page of interactionCaseById('upload').pages) {
      const response = await interactionPageRequest(lab.base, page);
      assert.equal(response.status, 200);
      const body = await response.text();
      // A page with only a drop zone, such as the drop frame, has no form.
      const forms = [...body.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)];
      formCount += forms.length;
      for (const [form] of forms) {
        const fileInputs = [
          ...form.matchAll(/<input\b[^>]*type="file"[^>]*>/g),
        ];
        assert.ok(fileInputs.length > 0, page.path);
        for (const [input] of fileInputs) {
          assert.match(input, /\bname="files"/, `${page.path}: ${input}`);
        }
      }
    }
    assert.ok(formCount > 0);
  });

  test('starts the plain editor with no surrounding whitespace', async () => {
    const response = await fetch(`${lab.base}/browser-lab/editor`);
    assert.equal(response.status, 200);
    const body = await response.text();
    const plain =
      /<div\b(?=[^>]*data-testid="browser-lab-editor-plain")[^>]*>([^<]*)<\/div>/.exec(
        body,
      );
    assert.ok(plain, 'Missing plain contenteditable');
    assert.equal(plain[1], 'Edit this plain text region.');
  });

  test('renders every data attribute queried by the shadow script', async () => {
    const response = await fetch(`${lab.base}/browser-lab/shadow`);
    assert.equal(response.status, 200);
    const body = await response.text();
    const attributes = new Set(
      inlineScripts(body).flatMap((script) =>
        [
          ...script.matchAll(
            /querySelector(?:All)?\('\[(data-browser-lab-[a-z-]+)\]'\)/g,
          ),
        ].map((match) => match[1]),
      ),
    );
    assert.ok(attributes.size > 0, 'Shadow script has no attribute selectors');
    for (const attribute of attributes) {
      assert.match(body, new RegExp(`\\b${attribute}(?:\\s|=|>)`), attribute);
    }
  });

  test(
    'serves every interaction page with its controls, markers, and hash-only scripts',
    { timeout: 5000 },
    async () => {
      for (const caseDef of BROWSER_LAB_INTERACTION_CASES) {
        for (const page of caseDef.pages) {
          const response = await interactionPageRequest(lab.base, page);
          assert.equal(response.status, 200, `${caseDef.id} ${page.path}`);
          assert.match(
            response.headers.get('content-type') ?? '',
            /^text\/html(?:;|$)/,
            page.path,
          );
          const body = await response.text();
          assert.ok(
            body.includes('data-browser-lab-kind="interaction"'),
            page.path,
          );
          assert.ok(
            body.includes(`data-browser-lab-case="${caseDef.id}"`),
            page.path,
          );
          assert.ok(
            body.includes(
              `data-browser-lab-interaction-revision="${BROWSER_LAB_INTERACTION_REVISION}"`,
            ),
            page.path,
          );
          const foundControls = testIds(body);
          for (const control of page.controls) {
            assert.ok(
              foundControls.has(control),
              `${page.path} is missing ${control}`,
            );
          }

          const csp = response.headers.get('content-security-policy') ?? '';
          assert.equal(cspDirective(csp, 'default-src'), "'none'", page.path);
          assert.equal(cspDirective(csp, 'base-uri'), "'none'", page.path);
          const scripts = inlineScripts(body);
          assert.deepEqual(
            cspDirective(csp, 'script-src').split(/\s+/),
            scripts.length > 0 ? scripts.map(scriptHashSource) : ["'none'"],
            page.path,
          );
          for (const script of scripts) {
            assert.ok(
              cspDirective(csp, 'script-src').includes(
                scriptHashSource(script),
              ),
              `${page.path} does not hash an inline script`,
            );
            assert.doesNotThrow(
              () => new vm.Script(script),
              `${page.path} has invalid inline JavaScript`,
            );
          }
        }
      }

      const index = await fetch(
        `${lab.base}${BROWSER_LAB_BASE_PATH}/interaction`,
      );
      assert.equal(index.status, 200);
      const indexBody = await index.text();
      for (const caseDef of BROWSER_LAB_INTERACTION_CASES) {
        assert.ok(
          indexBody.includes(`href="${caseDef.entryPath}"`),
          `Interaction index does not link to ${caseDef.id}`,
        );
      }

      for (const path of allPagePaths()) {
        const legacy = await fetch(`${lab.base}${servedPath(path)}`);
        assert.equal(legacy.status, 200, path);
        assert.doesNotMatch(
          await legacy.text(),
          /data-browser-lab-kind="interaction"/,
          `Legacy page ${path} acquired an interaction marker`,
        );
      }
    },
  );

  test(
    'limits CSP frame, connection, and form-action exceptions to their cases',
    { timeout: 5000 },
    async () => {
      const framePages = [];
      const externalConnectPages = [];
      for (const caseDef of BROWSER_LAB_INTERACTION_CASES) {
        for (const page of caseDef.pages) {
          const response = await interactionPageRequest(lab.base, page);
          assert.equal(response.status, 200, `${caseDef.id} ${page.path}`);
          const csp = response.headers.get('content-security-policy') ?? '';
          await response.arrayBuffer();
          const frameDirective = csp
            .split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith('frame-src '));
          if (frameDirective) {
            framePages.push(`${caseDef.id}:${page.path}`);
            const sources = frameDirective
              .slice('frame-src '.length)
              .split(/\s+/);
            if (
              caseDef.id === 'frames' &&
              page.path !== interactionCaseById('frames').entryPath
            ) {
              assert.deepEqual(sources, ["'self'"], page.path);
            } else {
              assert.deepEqual(
                sources.filter((source) => source !== "'self'"),
                [BROWSER_LAB_DEFAULT_PAIRED_ORIGIN],
                page.path,
              );
            }
          }

          const connectSources = cspDirective(csp, 'connect-src').split(/\s+/);
          const externalConnectSources = connectSources.filter(
            (source) => source !== "'self'",
          );
          if (externalConnectSources.length > 0) {
            externalConnectPages.push(`${caseDef.id}:${page.path}`);
            assert.deepEqual(
              externalConnectSources,
              [BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.exfiltrationSink],
              page.path,
            );
          }
          assert.deepEqual(
            cspDirective(csp, 'form-action')
              .split(/\s+/)
              .filter((source) => source !== "'self'"),
            [],
            `${page.path} has an unscoped form-action source`,
          );
        }
      }

      assert.deepEqual(framePages.sort(), [
        'dialog-surfaces:/browser-lab/dialog-surfaces',
        'frames:/browser-lab/frames',
        'frames:/browser-lab/frames/nested/1',
        'frames:/browser-lab/frames/nested/2',
        'heavy:/browser-lab/heavy',
        'upload:/browser-lab/upload',
      ]);
      assert.deepEqual(externalConnectPages, [
        'hostile-transfers:/browser-lab/hostile-transfers',
      ]);
    },
  );
});

describe('Browser Lab interaction source guards', () => {
  test('keeps chooser, popup, file-input, and form-action APIs in their intended modules', async () => {
    const sourceById = new Map(
      await Promise.all(
        BROWSER_LAB_INTERACTION_CASES.map(async (caseDef) => [
          caseDef.id,
          await readFile(
            join(routesDir, 'browser-lab-cases', `${caseDef.id}.mjs`),
            'utf8',
          ),
        ]),
      ),
    );
    const modulesContaining = (needle) =>
      [...sourceById]
        .filter(([, source]) => source.includes(needle))
        .map(([id]) => id)
        .sort();

    assert.deepEqual(modulesContaining('showOpenFilePicker'), [
      'hostile-transfers',
      'popups-permissions',
    ]);
    assert.deepEqual(modulesContaining('window.open'), ['popups-permissions']);
    assert.deepEqual(modulesContaining('type="file"'), [
      'hostile-transfers',
      'upload',
    ]);
    assert.deepEqual(modulesContaining('formActions:'), []);
  });
});

describe('Browser Lab interaction options and paired listener', () => {
  test('accepts only exact explicit loopback paired origins', () => {
    for (const pairedOrigin of [
      'http://localhost:43123',
      'http://127.0.0.1:43124',
    ]) {
      assert.doesNotThrow(() => createBrowserLabServer({ pairedOrigin }));
    }

    for (const pairedOrigin of [
      null,
      42,
      '',
      'https://localhost:43123',
      'http://localhost',
      'http://127.0.0.1',
      'http://localhost:80',
      'http://localhost:0',
      'http://localhost:43123/',
      'http://localhost:43123/path',
      'http://localhost:43123?query=1',
      'http://localhost:43123#fragment',
      'http://user:pass@localhost:43123',
      'http://example.test:43123',
      'http://[::1]:43123',
      'HTTP://LOCALHOST:43123',
    ]) {
      assert.throws(
        () => createBrowserLabServer({ pairedOrigin }),
        TypeError,
        JSON.stringify(pairedOrigin),
      );
    }
  });

  test(
    'rejects same-host framing but uses the inert default origin when unpaired',
    { timeout: 5000 },
    async () => {
      const frames = interactionCaseById('frames');
      const sameHostLab = await startLab({
        pairedOrigin: 'http://127.0.0.1:43125',
      });
      try {
        const rejected = await fetch(`${sameHostLab.base}${frames.entryPath}`);
        assert.equal(rejected.status, 500);
        assert.match(await rejected.text(), /same host as this page/);
        const upload = interactionCaseById('upload');
        const rejectedUpload = await fetch(
          `${sameHostLab.base}${upload.entryPath}`,
        );
        assert.equal(rejectedUpload.status, 500);
        assert.match(await rejectedUpload.text(), /same host as this page/);
      } finally {
        await sameHostLab.close();
      }

      const unpairedLab = await startLab();
      try {
        const page = await fetch(`${unpairedLab.base}${frames.entryPath}`);
        assert.equal(page.status, 200);
        assert.ok(
          (await page.text()).includes(
            `${BROWSER_LAB_DEFAULT_PAIRED_ORIGIN}${frames.pages.find((item) => item.path.endsWith('/cross-site-form')).path}`,
          ),
        );
      } finally {
        await unpairedLab.close();
      }
    },
  );

  test(
    'pairs 127.0.0.1 with localhost and refuses a caller-supplied pairedOrigin',
    { timeout: 5000 },
    async () => {
      await assert.rejects(
        () =>
          listenPairedBrowserLabServers({
            pairedOrigin: 'http://localhost:43126',
          }),
        TypeError,
      );

      const pair = await listenPairedBrowserLabServers();
      try {
        assert.equal(new URL(pair.primary.origin).hostname, '127.0.0.1');
        assert.equal(new URL(pair.paired.origin).hostname, 'localhost');
        const frames = interactionCaseById('frames');
        const crossSitePage = frames.pages.find((page) =>
          page.path.endsWith('/cross-site-form'),
        );

        const primaryEntry = await fetch(
          `${pair.primary.origin}${frames.entryPath}`,
        );
        assert.equal(primaryEntry.status, 200);
        assert.deepEqual(
          cspDirective(
            primaryEntry.headers.get('content-security-policy') ?? '',
            'frame-src',
          )
            .split(/\s+/)
            .filter((source) => source !== "'self'"),
          [pair.paired.origin],
        );
        assert.ok(
          (await primaryEntry.text()).includes(
            `${pair.paired.origin}${crossSitePage.path}`,
          ),
        );

        const pairedEntry = await fetch(
          `${pair.paired.origin}${frames.entryPath}`,
        );
        assert.equal(pairedEntry.status, 200);
        assert.deepEqual(
          cspDirective(
            pairedEntry.headers.get('content-security-policy') ?? '',
            'frame-src',
          )
            .split(/\s+/)
            .filter((source) => source !== "'self'"),
          [pair.primary.origin],
        );
        assert.ok(
          (await pairedEntry.text()).includes(
            `${pair.primary.origin}${crossSitePage.path}`,
          ),
        );

        for (const caseId of ['upload', 'dialog-surfaces', 'heavy']) {
          const caseDef = interactionCaseById(caseId);
          const response = await fetch(
            `${pair.primary.origin}${caseDef.entryPath}`,
          );
          assert.equal(response.status, 200, caseId);
          assert.deepEqual(
            cspDirective(
              response.headers.get('content-security-policy') ?? '',
              'frame-src',
            )
              .split(/\s+/)
              .filter((source) => source !== "'self'"),
            [pair.paired.origin],
            caseId,
          );
          await response.arrayBuffer();
        }

        const pairedFrame = await fetch(
          `${pair.paired.origin}${crossSitePage.path}`,
        );
        assert.equal(pairedFrame.status, 200);
        assert.ok(
          (await pairedFrame.text()).includes(
            'data-browser-lab-kind="interaction"',
          ),
        );
      } finally {
        await pair.close();
      }
    },
  );
});

describe('Browser Lab interaction endpoints', () => {
  let lab;
  before(async () => {
    lab = await startLab();
  });
  after(async () => {
    await lab.close();
  });

  test(
    'echoes multipart uploads and enforces the documented limits',
    { timeout: 5000 },
    async () => {
      const uploadCase = interactionCaseById('upload');
      const endpoint = uploadCase.endpoints[0];
      const boundary = 'browser-lab-boundary-1570';
      const multipartBody = (files) =>
        Buffer.from(
          `${files
            .map(
              ({ name, content }) =>
                `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`,
            )
            .join('')}--${boundary}--\r\n`,
        );
      const files = [
        { name: 'alpha.txt', content: 'first upload' },
        { name: 'beta.bin', content: 'second upload\0bytes' },
      ];
      const uploaded = await fetch(`${lab.base}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody(files),
      });
      assert.equal(uploaded.status, 200);
      assert.deepEqual(await uploaded.json(), {
        files: files.map(({ name, content }) => ({
          name,
          size: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        })),
      });

      const wrongType = await fetch(`${lab.base}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=not-a-file',
      });
      assert.equal(wrongType.status, 415);
      await wrongType.arrayBuffer();

      const tooMany = multipartBody(
        Array.from(
          { length: BROWSER_LAB_INTERACTION_LIMITS.maxUploadParts + 1 },
          (_, index) => ({
            name: `part-${index}.txt`,
            content: `part ${index}`,
          }),
        ),
      );
      const tooManyResponse = await fetch(`${lab.base}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: tooMany,
      });
      assert.equal(tooManyResponse.status, 400);
      await tooManyResponse.arrayBuffer();

      // Only the declared length is sent. The endpoint answers 413 from the
      // header, and it disconnects a client that keeps sending past the drain
      // allowance, which would reset this request before the status is read.
      const oversizedResponse = await rawRequest(lab.port, {
        method: 'POST',
        path: endpoint,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(
            BROWSER_LAB_INTERACTION_LIMITS.maxUploadBodyBytes + 1,
          ),
        },
      });
      assert.equal(oversizedResponse.status, 413);

      const overlongName = multipartBody([
        {
          name: `${'x'.repeat(BROWSER_LAB_INTERACTION_LIMITS.maxUploadFileNameBytes + 1)}.txt`,
          content: 'name too long',
        },
      ]);
      const overlongNameResponse = await fetch(`${lab.base}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body: overlongName,
      });
      assert.equal(overlongNameResponse.status, 400);
      await overlongNameResponse.arrayBuffer();

      const getResponse = await fetch(`${lab.base}${endpoint}`);
      assert.equal(getResponse.status, 405);
      assert.equal(getResponse.headers.get('allow'), 'POST');
      await getResponse.arrayBuffer();
    },
  );

  test('echoes a browser-style native single-file form submission', async () => {
    const contents = 'Native single-form upload.\n';
    const form = new FormData();
    form.append(
      'files',
      new Blob([contents], { type: 'text/plain' }),
      'native.txt',
    );
    const response = await fetch(`${lab.base}/browser-lab/upload-echo`, {
      method: 'POST',
      body: form,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      files: [
        {
          name: 'native.txt',
          size: Buffer.byteLength(contents),
          sha256: createHash('sha256').update(contents).digest('hex'),
        },
      ],
    });
  });

  test(
    'serves every cataloged download variant with its declared headers and bytes',
    { timeout: 5000 },
    async () => {
      const downloadsCase = interactionCaseById('downloads');
      assert.deepEqual(
        downloadsCase.endpoints,
        downloadsCase.downloads.map((download) => download.path),
      );
      const expectedLength = (download) =>
        typeof download.bytes === 'number'
          ? download.bytes
          : BROWSER_LAB_INTERACTION_LIMITS[download.bytes.limit];
      let largePrefix;

      for (const download of downloadsCase.downloads) {
        const response = await fetch(`${lab.base}${download.path}`);
        assert.equal(response.status, 200, download.variant);
        assert.equal(
          response.headers.get('content-disposition'),
          download.disposition,
          download.variant,
        );
        assert.equal(
          response.headers.get('content-type'),
          download.contentType,
        );
        assert.equal(
          Number(response.headers.get('content-length')),
          expectedLength(download),
          download.variant,
        );

        if (download.variant === 'large') {
          const reader = response.body.getReader();
          const chunks = [];
          let bytesRead = 0;
          while (bytesRead < 13) {
            const next = await reader.read();
            assert.equal(next.done, false);
            chunks.push(Buffer.from(next.value));
            bytesRead += next.value.byteLength;
          }
          largePrefix = Buffer.concat(chunks);
          await reader.cancel();
          continue;
        }
        if (download.variant === 'interrupted') {
          const reader = response.body.getReader();
          let receivedBytes = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              receivedBytes += next.value.byteLength;
            }
          } catch {
            // The fixture intentionally drops this response before its length.
          }
          assert.ok(receivedBytes > 0);
          assert.ok(receivedBytes < expectedLength(download));
          continue;
        }

        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(
          body.byteLength,
          expectedLength(download),
          download.variant,
        );
      }

      assert.ok(largePrefix);
      const largeDownload = downloadsCase.downloads.find(
        (download) => download.variant === 'large',
      );
      const ranged = await fetch(`${lab.base}${largeDownload.path}`, {
        headers: { range: 'bytes=5-12' },
      });
      assert.equal(ranged.status, 206);
      assert.equal(
        ranged.headers.get('content-range'),
        `bytes 5-12/${BROWSER_LAB_INTERACTION_LIMITS.downloadLargeBytes}`,
      );
      assert.deepEqual(
        Buffer.from(await ranged.arrayBuffer()),
        largePrefix.subarray(5, 13),
      );

      const sameNameGroups = new Map();
      for (const download of downloadsCase.downloads) {
        const key = `${download.fileName}\n${download.disposition}`;
        sameNameGroups.set(key, (sameNameGroups.get(key) ?? 0) + 1);
      }
      assert.ok(
        [...sameNameGroups.values()].some((count) => count >= 2),
        'Catalog is missing the same-name-twice download case',
      );

      const page = await fetch(`${lab.base}${downloadsCase.entryPath}`);
      assert.equal(page.status, 200);
      const pageBody = await page.text();
      for (const generated of downloadsCase.browserGeneratedDownloads) {
        const anchor = pageBody.match(
          new RegExp(
            `<a\\b[^>]*data-testid="browser-lab-downloads-${generated.variant}"[^>]*>`,
          ),
        )?.[0];
        assert.ok(
          anchor,
          `Missing ${generated.variant} browser-generated download`,
        );
        assert.ok(anchor.includes(`download="${generated.fileName}"`));
        if (generated.variant === 'data-url') {
          assert.match(anchor, /href="data:/);
        }
      }
    },
  );

  test(
    'returns 503 with Retry-After when all streamed-download slots are occupied',
    { timeout: 5000 },
    async () => {
      const largeDownload = interactionCaseById('downloads').downloads.find(
        (download) => download.variant === 'large',
      );
      const readers = [];
      try {
        for (
          let index = 0;
          index < BROWSER_LAB_INTERACTION_LIMITS.maxConcurrentDownloadStreams;
          index += 1
        ) {
          const response = await fetch(`${lab.base}${largeDownload.path}`);
          assert.equal(response.status, 200);
          const reader = response.body.getReader();
          readers.push(reader);
          const first = await reader.read();
          assert.equal(first.done, false);
        }

        const overflow = await fetch(`${lab.base}${largeDownload.path}`);
        assert.equal(overflow.status, 503);
        assert.equal(overflow.headers.get('retry-after'), '1');
        await overflow.arrayBuffer();
      } finally {
        await Promise.all(
          readers.map((reader) => reader.cancel().catch(() => {})),
        );
      }
    },
  );

  test(
    'echoes ordered form fields and rejects non-form submit bodies',
    { timeout: 5000 },
    async () => {
      const formSubmits = new Set();
      for (const caseDef of BROWSER_LAB_INTERACTION_CASES) {
        if (caseDef.submitPath) formSubmits.add(caseDef.submitPath);
        for (const endpoint of caseDef.endpoints ?? []) {
          if (/\/(?:enter-)?submit$/.test(endpoint)) formSubmits.add(endpoint);
        }
      }
      assert.ok(formSubmits.size > 0);
      const fields = [
        ['alpha', 'first'],
        ['repeat', 'one'],
        ['alpha', 'last'],
      ];
      const encoded = 'alpha=first&repeat=one&alpha=last';

      for (const path of formSubmits) {
        const response = await postForm(lab.base, path, encoded);
        assert.equal(response.status, 200, path);
        if (
          response.headers.get('content-type')?.startsWith('application/json')
        ) {
          assert.deepEqual(await response.json(), { fields });
        } else {
          const body = await response.text();
          const echoed = [
            ...body.matchAll(/data-browser-lab-field="([^"]+)">([^<]*)<\/li>/g),
          ].map(([, name, value]) => [name, value]);
          assert.deepEqual(echoed, fields, path);
        }

        const wrongType = await fetch(`${lab.base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fields }),
        });
        assert.equal(wrongType.status, 415, path);
        await wrongType.arrayBuffer();
      }
    },
  );

  test('enforces Basic authentication on protected interaction pages', async () => {
    const authCase = interactionCaseById('auth');
    const protectedPage = authCase.pages.find((page) => page.requiresAuth);
    assert.ok(protectedPage);
    const url = `${lab.base}${protectedPage.path}`;
    const denied = await fetch(url);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /^Basic realm=/);
    await denied.arrayBuffer();

    const badCredentials = await fetch(url, {
      headers: {
        authorization: `Basic ${Buffer.from('wrong:credentials').toString('base64')}`,
      },
    });
    assert.equal(badCredentials.status, 401);
    assert.match(
      badCredentials.headers.get('www-authenticate') ?? '',
      /^Basic realm=/,
    );
    await badCredentials.arrayBuffer();

    const accepted = await fetch(url, {
      headers: { authorization: interactionAuthorization() },
    });
    assert.equal(accepted.status, 200);
    assert.ok((await accepted.text()).includes('browser-lab-auth-welcome'));
  });

  test('keeps hostile-transfer counts and endpoints tied to the interaction catalog', async () => {
    const hostile = interactionCaseById('hostile-transfers');
    const downloads = interactionCaseById('downloads');
    const loop = downloads.downloads.find(
      (download) => download.variant === 'loop',
    );
    const executable = downloads.downloads.find(
      (download) => download.variant === 'executable',
    );
    const response = await fetch(`${lab.base}${hostile.entryPath}`);
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const attack of hostile.attacks) {
      assert.ok(body.includes(attack.marker), attack.id);
      assert.ok(testIds(body).has(attack.control), attack.id);
    }
    assert.ok(
      body.includes(
        `data-repeat-count="${BROWSER_LAB_INTERACTION_LIMITS.hostileChooserRepeatCount}"`,
      ),
    );
    assert.ok(
      body.includes(
        `data-download-count="${BROWSER_LAB_INTERACTION_LIMITS.hostileDownloadLoopCount}"`,
      ),
    );
    assert.ok(body.includes(`href="${executable.path}"`));
    assert.ok(body.includes(BROWSER_LAB_DEFAULT_HOST_FILE_URL));
    assert.ok(
      body.includes(
        `${BROWSER_LAB_DEFAULT_ATTACK_ORIGINS.exfiltrationSink}${BROWSER_LAB_ATTACK_TARGET_PATHS.exfiltrationSink}`,
      ),
    );

    const loopResponse = await fetch(
      `${lab.base}${loop.path}?n=${BROWSER_LAB_INTERACTION_LIMITS.hostileDownloadLoopCount}`,
    );
    assert.equal(loopResponse.status, 200);
    assert.ok(
      (loopResponse.headers.get('content-disposition') ?? '').includes(
        String(BROWSER_LAB_INTERACTION_LIMITS.hostileDownloadLoopCount),
      ),
    );
    assert.ok(
      (await loopResponse.text()).includes(
        String(BROWSER_LAB_INTERACTION_LIMITS.hostileDownloadLoopCount),
      ),
    );

    const tooManyLoops = await fetch(
      `${lab.base}${loop.path}?n=${BROWSER_LAB_INTERACTION_LIMITS.hostileDownloadLoopCount + 1}`,
    );
    assert.equal(tooManyLoops.status, 400);
    await tooManyLoops.arrayBuffer();

    const executableResponse = await fetch(`${lab.base}${executable.path}`);
    assert.equal(executableResponse.status, 200);
    assert.equal(
      executableResponse.headers.get('content-disposition'),
      executable.disposition,
    );
  });
});
