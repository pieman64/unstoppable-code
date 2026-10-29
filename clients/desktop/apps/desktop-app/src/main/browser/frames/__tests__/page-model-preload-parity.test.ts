/** @jest-environment jsdom */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INSPECT_RESOLVER_KEY } from '@canopy/desktop-shared/browser/secret-fields';
import type {
  BrowserInputSnapshotFilter,
  BrowserInputSnapshotRequest,
  BrowserInputSnapshotResponse,
  BrowserLocatorCandidate,
} from '@canopy/desktop-shared/types/browser';
import type { NodeIdentity } from '../frame-registry';
import type { BrowserPageModel } from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot, projectInspect } from '../projections';
import {
  loadRecording,
  RECORDED_DIRECTORY,
  recordedDeps,
  recordedHtml,
} from './fixtures/recorded-cdp';

type Handler = (event: unknown, command: unknown) => void;
const mockOn = jest.fn<void, [string, Handler]>();
const mockSend = jest.fn<void, [string, unknown]>();
jest.mock('electron', () => ({ ipcRenderer: { on: mockOn, send: mockSend } }));

/**
 * Parity with the browser-view preload's input snapshot and inspect, which
 * the page model replaced. The model runs on real Chromium CDP recordings;
 * what the preload answered on the same pages is pinned beside each
 * recording as `recorded/<name>.preload.json`.
 *
 * Those files were captured at commit 6f0b031782 (phase 04b S4), by a
 * one-off run of this test's preload half: the real preload in jsdom on
 * each recording's HTML, its full snapshot, every filter and pagination
 * request below, and an inspect of every row. They cannot be regenerated:
 * the preload's snapshot and inspect commands were deleted after the
 * capture. Change them only by a deliberate decision about what agents
 * see, never to make this test pass.
 *
 * Bounds are not compared: jsdom has no layout. Refs, frame refs and
 * viewport flags are the model's own. Phase 06's added state/option/constraint
 * fields are covered in projections.test.ts, not the archived preload.
 * Its non-checkable input checked:false fields are deliberately no longer rows.
 */
const FIXTURES: Array<{
  name: string;
  structured: boolean;
  lightRows: number;
}> = [
  { name: 'form-controls', structured: false, lightRows: 19 },
  { name: 'lists-pseudo', structured: false, lightRows: 5 },
  { name: 'hidden', structured: false, lightRows: 8 },
  { name: 'secrets', structured: false, lightRows: 12 },
  { name: 'shadow', structured: true, lightRows: 4 },
  { name: 'frames', structured: true, lightRows: 2 },
];

/**
 * Reviewed divergences, by element id: Chromium's DOM snapshot has no entry
 * for an unslotted light child, so the model withholds its live value
 * (`valueRedacted`) where the preload read `element.value`.
 */
const VALUE_WITHHELD_IDS: Record<string, string[]> = {
  shadow: ['unslotted-input'],
};

const INSPECT_KEYS = [
  'tagName',
  'role',
  'accessibleName',
  'text',
  'value',
  'valueRedacted',
  'attributes',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SEED_PATTERN = /SEED-[A-Z-]+-\d{4}/g;

type Enrichment = Awaited<
  ReturnType<Parameters<typeof projectInspect>[2]['enrich']>
>;

/** One filter or pagination request and what the preload answered. */
interface ExpectedRequest {
  request: Omit<BrowserInputSnapshotRequest, 'browserId'>;
  total: number;
  returned: number;
  offset: number;
  limit: number;
  truncated: boolean;
  nextOffset?: number;
  /** Indexes into the full snapshot's rows, in order. */
  rows: number[];
}

/** The preload's answers on one page (`recorded/<name>.preload.json`). */
interface ExpectedParity {
  rows: Array<Record<string, unknown>>;
  requests: ExpectedRequest[];
  inspect: Array<Record<string, unknown>>;
}

function decodeFilter(value: unknown): BrowserInputSnapshotFilter {
  if (!record(value)) throw new Error('Invalid expected filter');
  const filter: BrowserInputSnapshotFilter = {};
  for (const key of ['name', 'role', 'inputType'] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== 'string') throw new Error('Invalid expected filter');
    filter[key] = entry;
  }
  return filter;
}

function decodeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new Error('Invalid expected number');
  return value;
}

function decodeRequest(value: unknown): ExpectedRequest {
  if (!record(value) || !record(value.request) || !Array.isArray(value.rows))
    throw new Error('Invalid expected request');
  const stored = value.request;
  const request: ExpectedRequest['request'] = {};
  if (stored.filter !== undefined) request.filter = decodeFilter(stored.filter);
  if (stored.offset !== undefined) request.offset = decodeNumber(stored.offset);
  if (stored.limit !== undefined) request.limit = decodeNumber(stored.limit);
  if (typeof value.truncated !== 'boolean')
    throw new Error('Invalid expected request');
  return {
    request,
    total: decodeNumber(value.total),
    returned: decodeNumber(value.returned),
    offset: decodeNumber(value.offset),
    limit: decodeNumber(value.limit),
    truncated: value.truncated,
    ...(value.nextOffset === undefined
      ? {}
      : { nextOffset: decodeNumber(value.nextOffset) }),
    rows: value.rows.map(decodeNumber),
  };
}

function decodeRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Invalid expected rows');
  return value.map((entry: unknown) => {
    if (!record(entry)) throw new Error('Invalid expected row');
    return entry;
  });
}

function loadExpected(name: string): ExpectedParity {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(RECORDED_DIRECTORY, `${name}.preload.json`), 'utf8'),
  );
  if (!record(parsed) || parsed.fixture !== name)
    throw new Error(`Invalid expectations for ${name}`);
  return {
    rows: decodeRecords(parsed.rows),
    requests:
      parsed.requests === undefined
        ? []
        : Array.isArray(parsed.requests)
          ? parsed.requests.map(decodeRequest)
          : [],
    inspect: decodeRecords(parsed.inspect),
  };
}

function identityKey(identity: NodeIdentity): string {
  return `${identity.frameId}\u0000${identity.backendNodeId}`;
}

/**
 * The live jsdom element for each main-frame light-DOM model element, matched
 * by document order: both come from the same HTML.
 */
function liveElementsByIdentity(model: BrowserPageModel): Map<string, Element> {
  const rootRef = model.frames.find((frame) => frame.depth === 0)?.frameRef;
  const modelElements = model.nodes.filter(
    (node) =>
      node.nodeType === 1 && node.frameRef === rootRef && !node.inShadowRoot,
  );
  const liveElements = [
    document.documentElement,
    ...Array.from(document.documentElement.querySelectorAll('*')),
  ];
  if (modelElements.length !== liveElements.length) {
    throw new Error('The recording and the live document differ.');
  }
  const map = new Map<string, Element>();
  modelElements.forEach((node, index) => {
    const element = liveElements[index];
    if (!element || element.tagName.toLowerCase() !== node.tagName) {
      throw new Error(`Element order differs at ${index}.`);
    }
    map.set(identityKey(node.identity), element);
  });
  return map;
}

const CANDIDATE_KINDS = new Set([
  'testId',
  'role',
  'label',
  'placeholder',
  'text',
  'alt',
  'title',
  'css',
  'domPath',
]);

function isCandidate(value: unknown): value is BrowserLocatorCandidate {
  return (
    record(value) &&
    typeof value.kind === 'string' &&
    CANDIDATE_KINDS.has(value.kind) &&
    typeof value.value === 'string' &&
    typeof value.unique === 'boolean' &&
    (value.confidence === 'high' ||
      value.confidence === 'medium' ||
      value.confidence === 'low')
  );
}

function decodeInspection(value: unknown): Enrichment {
  if (
    !record(value) ||
    typeof value.outerHtml !== 'string' ||
    !Array.isArray(value.domPath) ||
    !Array.isArray(value.locatorCandidates)
  ) {
    return null;
  }
  const domPath = value.domPath.filter(
    (part: unknown): part is string => typeof part === 'string',
  );
  const locatorCandidates = value.locatorCandidates.filter(isCandidate);
  return {
    locatorCandidates,
    ...(isCandidate(value.preferredLocator)
      ? { preferredLocator: value.preferredLocator }
      : {}),
    domPath,
    outerHtml: value.outerHtml,
  };
}

function loadIntoDocument(html: string): void {
  const inner = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>\s*$/i, '');
  document.documentElement.innerHTML = inner;
  // innerHTML does not run scripts; recreate them so they run, in order.
  for (const script of Array.from(document.querySelectorAll('script'))) {
    const replacement = document.createElement('script');
    replacement.textContent = script.textContent;
    script.replaceWith(replacement);
  }
}

function comparableRow(
  row: unknown,
  withheld: string[],
): Record<string, unknown> {
  if (!record(row)) throw new Error('Invalid row');
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      [
        'ref',
        'frameRef',
        'inShadowRoot',
        'inViewport',
        'bounds',
        'expanded',
        'selected',
        'pressed',
        'required',
        'invalid',
        'readOnly',
        'editable',
        'options',
        'optionCount',
        'optionsRedacted',
        'constraints',
        'format',
      ].includes(key) ||
      (key === 'checked' &&
        !(
          row.tagName === 'input' &&
          (row.inputType === 'checkbox' || row.inputType === 'radio')
        )) ||
      value === undefined
    ) {
      continue;
    }
    fields[key] = value;
  }
  const locator = typeof row.locator === 'string' ? row.locator : '';
  if (withheld.some((id) => locator.includes(id)) && 'value' in fields) {
    delete fields.value;
    fields.valueRedacted = true;
  }
  return fields;
}

function mainLightRows(
  response: BrowserInputSnapshotResponse,
): BrowserInputSnapshotResponse['inputs'] {
  // E1: top-document rows carry no frameRef; shadow rows say so.
  return response.inputs.filter(
    (row) => row.frameRef === undefined && row.inShadowRoot !== true,
  );
}

describe('page model parity with the preload it replaced, on recorded Chromium pages', () => {
  beforeAll(async () => {
    // The real preload stays for the inspect bridge the model enriches with.
    await import('../../../../preload/browser-view');
  });

  it.each(FIXTURES)(
    '$name: rows, names, values, redaction, filters, pagination and inspect',
    async ({ name, structured, lightRows }) => {
      const expected = loadExpected(name);
      const model = await buildPageModel(recordedDeps(loadRecording(name)));
      const withheld = VALUE_WITHHELD_IDS[name] ?? [];
      const page = { browserId: 'parity', url: 'http://localhost/', title: '' };
      expect(expected.rows).toHaveLength(lightRows);
      expect(expected.inspect).toHaveLength(lightRows);

      const modelFull = projectInputSnapshot(
        model,
        { browserId: 'parity', limit: 100 },
        page,
      );
      const modelRows = structured
        ? mainLightRows(modelFull)
        : modelFull.inputs;
      expect(modelRows.map((row) => comparableRow(row, withheld))).toEqual(
        expected.rows.map((row) => comparableRow(row, withheld)),
      );

      // Light pages only: on structured pages the preload saw only the
      // top document's light DOM.
      expect(expected.requests.length > 0).toBe(!structured);
      for (const stored of expected.requests) {
        const request = { browserId: 'parity', ...stored.request };
        const actual = projectInputSnapshot(model, request, page);
        const label = JSON.stringify(stored.request);
        expect([
          label,
          actual.total,
          actual.returned,
          actual.offset,
          actual.limit,
          actual.truncated,
          actual.nextOffset,
        ]).toEqual([
          label,
          stored.total,
          stored.returned,
          stored.offset,
          stored.limit,
          stored.truncated,
          stored.nextOffset,
        ]);
        expect([
          label,
          actual.inputs.map((row) => comparableRow(row, withheld)),
        ]).toEqual([
          label,
          stored.rows.map((index) =>
            comparableRow(expected.rows[index], withheld),
          ),
        ]);
      }

      for (let index = 0; index < modelRows.length; index += 1) {
        const modelRow = modelRows[index];
        const expectedInspect = expected.inspect[index];
        if (!modelRow || !expectedInspect) throw new Error('Missing row');
        const identity = model.registry.resolveRef(modelRow.ref);
        if (!identity) throw new Error('Unresolvable model ref');
        const inspected = await projectInspect(model, identity, {
          enrich: () => Promise.resolve(null),
        });
        const attributes = expectedInspect.attributes;
        const rowWithheld = withheld.includes(
          String(record(attributes) ? attributes.id : ''),
        );
        for (const key of INSPECT_KEYS) {
          if (rowWithheld && (key === 'value' || key === 'valueRedacted'))
            continue;
          const actualValue = record(inspected) ? inspected[key] : undefined;
          expect([index, key, actualValue]).toEqual([
            index,
            key,
            expectedInspect[key],
          ]);
        }
      }
    },
  );

  it('keeps the capture secret controls redacted when enrichment runs after the page dropped their marker (PR #4917 finding 1)', async () => {
    loadIntoDocument(recordedHtml('secrets'));
    const recording = loadRecording('secrets');
    const seeds = Array.from(
      new Set(JSON.stringify(recording.responses).match(SEED_PATTERN) ?? []),
    );
    expect(seeds.length).toBeGreaterThan(5);
    const model = await buildPageModel(recordedDeps(recording));
    const live = liveElementsByIdentity(model);
    // After the capture, the page removes the markers that made these secret.
    for (const id of ['otp', 'card', 'otp-note', 'expiry']) {
      document.getElementById(id)?.removeAttribute('autocomplete');
    }
    const resolver: unknown = Reflect.get(globalThis, INSPECT_RESOLVER_KEY);
    if (typeof resolver !== 'function') throw new Error('Missing bridge');
    let enriched = 0;
    const enrich = (
      identity: NodeIdentity,
      secretControls: NodeIdentity[] = [],
    ): Promise<Enrichment> => {
      const target = live.get(identityKey(identity));
      const secrets = secretControls.map((control) =>
        live.get(identityKey(control)),
      );
      if (!target || secrets.some((secret) => secret === undefined)) {
        return Promise.resolve(null);
      }
      const result = decodeInspection(
        Reflect.apply(resolver, undefined, [target, ...secrets]),
      );
      if (result) enriched += 1;
      return Promise.resolve(result);
    };
    const responses: unknown[] = [];
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      responses.push(
        await projectInspect(model, node.identity, {
          allowSensitiveEnrichment: true,
          enrich,
        }),
      );
    }
    expect(enriched).toBeGreaterThan(10);
    const form = model.nodes.find((node) => node.attributes.id === 'sign-in');
    if (!form) throw new Error('Missing form');
    const inspectedForm = await projectInspect(model, form.identity, {
      allowSensitiveEnrichment: true,
      enrich,
    });
    // The preload's markup, which keeps redacted value attributes.
    expect(inspectedForm?.outerHtml).toContain('value="[redacted]"');
    const serialized = JSON.stringify(responses);
    for (const seed of seeds)
      expect([seed, serialized.includes(seed)]).toEqual([seed, false]);
  });

  it('keeps an option of a captured secret select redacted when it is the first element inspected', async () => {
    loadIntoDocument(recordedHtml('secrets'));
    const recording = loadRecording('secrets');
    const model = await buildPageModel(recordedDeps(recording));
    const live = liveElementsByIdentity(model);
    // The select is an ancestor of the inspected option, not part of its
    // subtree, and nothing has told the preload about it yet.
    document.getElementById('expiry')?.removeAttribute('autocomplete');
    const resolver: unknown = Reflect.get(globalThis, INSPECT_RESOLVER_KEY);
    if (typeof resolver !== 'function') throw new Error('Missing bridge');
    const enrich = (
      identity: NodeIdentity,
      secretControls: NodeIdentity[] = [],
    ): Promise<Enrichment> => {
      const target = live.get(identityKey(identity));
      const secrets = secretControls.map((control) =>
        live.get(identityKey(control)),
      );
      if (!target || secrets.some((secret) => secret === undefined)) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        decodeInspection(
          Reflect.apply(resolver, undefined, [target, ...secrets]),
        ),
      );
    };
    const insideSelect = model.nodes.filter(
      (node) => node.nodeType === 1 && node.insideSecretSelect,
    );
    expect(insideSelect.map((node) => node.tagName)).toEqual([
      'option',
      'optgroup',
      'option',
    ]);
    const responses: unknown[] = [];
    for (const node of insideSelect) {
      responses.push(
        await projectInspect(model, node.identity, {
          allowSensitiveEnrichment: true,
          enrich,
        }),
      );
    }
    const serialized = JSON.stringify(responses);
    expect(serialized.match(SEED_PATTERN) ?? []).toEqual([]);
  });

  it('withholds an unslotted control value that Chromium does not snapshot', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('shadow')));
    const unslotted = model.nodes.find(
      (node) => node.attributes.id === 'unslotted-input',
    );
    expect(unslotted).toMatchObject({
      valueUnknown: true,
      inShadowRoot: false,
    });
    expect(unslotted?.value).toBeUndefined();
    const row = projectInputSnapshot(
      model,
      { browserId: 'parity', limit: 100 },
      { browserId: 'parity', url: '', title: '' },
    ).inputs.find((item) => item.locator?.includes('unslotted-input'));
    expect(row).toMatchObject({ valueRedacted: true });
    expect(JSON.stringify(row)).not.toContain('unslotted value');
  });
});
