import { runInNewContext } from 'node:vm';
import type { BrowserInputSnapshotItem } from '@canopy/desktop-shared/types/browser';
import type {
  BrowserInputSnapshotRequest,
  BrowserLocatorCandidate,
} from '@canopy/desktop-shared/types/browser';
import { FrameRegistry, type NodeIdentity } from '../frame-registry';
import { buildPageModel } from '../page-model';
import {
  accessibleName,
  compactText,
  quote,
  generateLocatorCandidates,
  inputTypeFor,
  isHiddenElement,
  isInteractiveElement,
  labelTextForControl,
  roleFor,
  safeOuterHtml,
} from '../model-semantics';
import type {
  BrowserPageModel,
  PageModelFrame,
  PageModelNode,
} from '../model-types';
import { projectInputSnapshot, projectInspect } from '../projections';
import {
  loadRecording,
  recordedDeps,
  type ReplayOptions,
} from './fixtures/recorded-cdp';
import {
  appendChild,
  cloneRecording,
  elementRecord,
  findTreeNode,
  textRecord,
  treeRoot,
} from './fixtures/recording-edit';

const ROOT_FRAME_ID = 'root-frame';
const ROOT_FRAME_REF = 'root-ref';
const ROOT_LOADER_ID = 'root-loader';
const ROOT_SCOPE_ID = 1;

function makeNode(
  values: Partial<PageModelNode> & { nodeId: number; tagName: string },
): PageModelNode {
  return {
    identity: {
      sessionId: '',
      frameId: ROOT_FRAME_ID,
      loaderId: ROOT_LOADER_ID,
      backendNodeId: values.nodeId,
    },
    nodeType: 1,
    frameRef: ROOT_FRAME_REF,
    inShadowRoot: false,
    scopeNodeId: ROOT_SCOPE_ID,
    attributes: {},
    computedStyles: { display: 'block', visibility: 'visible' },
    hidden: false,
    bounds: { x: 0, y: 0, width: 40, height: 20 },
    frameLocalBounds: { x: 0, y: 0, width: 40, height: 20 },
    inViewport: true,
    text: '',
    labelText: '',
    ownText: '',
    secret: false,
    insideSecretSelect: false,
    hasSecretDescendant: false,
    childIndexes: [],
    ...values,
  };
}

function makeTextNode(
  nodeId: number,
  parentIndex: number,
  text: string,
): PageModelNode {
  return makeNode({
    nodeId,
    nodeType: 3,
    tagName: '#text',
    parentIndex,
    text,
    ownText: text,
  });
}

function makeModel(
  nodes: PageModelNode[],
  options: {
    frames?: PageModelFrame[];
    coverage?: BrowserPageModel['coverage'];
  } = {},
): BrowserPageModel {
  const registry = new FrameRegistry();
  registry.noteFrameNavigated('', {
    id: ROOT_FRAME_ID,
    loaderId: ROOT_LOADER_ID,
    url: 'https://model.example.test/page?private=query',
  });
  const rootFrame: PageModelFrame = {
    frameId: ROOT_FRAME_ID,
    frameRef: ROOT_FRAME_REF,
    sessionId: '',
    loaderId: ROOT_LOADER_ID,
    url: 'https://model.example.test/page?private=query',
    documentNodeId: ROOT_SCOPE_ID,
    queryRootNodeIds: [ROOT_SCOPE_ID],
    depth: 0,
    viewportTransform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    clip: { x: 0, y: 0, width: 1280, height: 800 },
  };
  return {
    nodes,
    frames: options.frames ?? [rootFrame],
    coverage: options.coverage ?? [],
    registry,
    capturedAt: '2026-10-08T12:34:56.000Z',
    page: {
      browserId: 'model-browser-id',
      runtimeGeneration: 12,
      url: 'https://model.example.test/page?private=query',
      title: 'Model page',
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
      themeMode: 'dark',
    },
    accessibility: [],
    listeners: [],
    styleSupplement: { candidates: 0, read: 0, skipped: 0 },
    trackerHistory: {
      inputs: 0,
      queried: 0,
      never: 0,
      was: 0,
      calls: 0,
      summaries: 0,
      durationMs: 0,
    },
    timings: {
      extractionMs: 0,
      assemblyMs: 0,
      accessibilityMs: 0,
      listenersMs: 0,
      styleSupplementMs: 0,
      totalMs: 0,
    },
  };
}

function documentNodes(children: PageModelNode[]): PageModelNode[] {
  const html = makeNode({
    nodeId: ROOT_SCOPE_ID,
    tagName: 'html',
    childIndexes: [1],
  });
  const body = makeNode({
    nodeId: 2,
    tagName: 'body',
    parentIndex: 0,
    childIndexes: children.map((_, index) => index + 2),
  });
  return [html, body, ...children];
}

function nodeWithSelectedState(
  node: PageModelNode,
  selected: boolean,
): PageModelNode {
  return Object.assign(node, { selected });
}

describe('model semantic helpers', () => {
  it('matches compact text, native roles, input types, and self-node visibility', () => {
    const textInput = makeNode({ nodeId: 3, tagName: 'input' });
    const hiddenByComputedStyle = makeNode({
      nodeId: 4,
      tagName: 'button',
      computedStyles: { display: 'none', visibility: 'visible' },
    });
    const childOfHiddenAttribute = makeNode({
      nodeId: 5,
      tagName: 'button',
      parentIndex: 1,
      computedStyles: { display: 'block', visibility: 'visible' },
    });

    expect(compactText('  alpha\n\t beta  ')).toBe('alpha beta');
    expect(roleFor(textInput)).toBe('textbox');
    expect(inputTypeFor(textInput)).toBe('text');
    expect(isInteractiveElement(textInput)).toBe(true);
    expect(isHiddenElement(hiddenByComputedStyle)).toBe(true);
    expect(
      isHiddenElement(
        makeNode({
          nodeId: 6,
          tagName: 'input',
          attributes: { 'aria-hidden': 'TRUE' },
        }),
      ),
    ).toBe(false);
    expect(
      isHiddenElement(
        makeNode({ nodeId: 7, tagName: 'input', attributes: { hidden: '' } }),
      ),
    ).toBe(true);
    expect(isHiddenElement(childOfHiddenAttribute)).toBe(false);
    expect(
      roleFor(
        makeNode({
          nodeId: 8,
          tagName: 'input',
          attributes: { type: 'search' },
        }),
      ),
    ).toBe('searchbox');
    expect(
      roleFor(
        makeNode({
          nodeId: 9,
          tagName: 'button',
          attributes: { role: '  switch ' },
        }),
      ),
    ).toBe('switch');
    expect(
      inputTypeFor(
        makeNode({
          nodeId: 10,
          tagName: 'input',
          attributes: { type: 'CUSTOM' },
        }),
      ),
    ).toBe('custom');
  });

  it('uses the first scoped label and partial safe subtree text for labelledby', () => {
    const label = makeNode({
      nodeId: 3,
      tagName: 'label',
      attributes: { for: 'email' },
      text: 'Email address',
      labelText: 'Email address',
    });
    const secondLabel = makeNode({
      nodeId: 4,
      tagName: 'label',
      attributes: { for: 'email' },
      text: 'Later label',
      labelText: 'Later label',
    });
    const input = makeNode({
      nodeId: 5,
      tagName: 'input',
      attributes: { id: 'email', type: 'email' },
    });
    const referenced = makeNode({
      nodeId: 6,
      tagName: 'div',
      attributes: { id: 'description' },
      labelText: 'Safe label',
      nameText: 'Safe label non-secret field',
    });
    const trigger = makeNode({
      nodeId: 7,
      tagName: 'button',
      attributes: { 'aria-labelledby': 'description' },
    });
    const nodes = documentNodes([
      label,
      secondLabel,
      input,
      referenced,
      trigger,
    ]);
    const model = makeModel(nodes);

    expect(labelTextForControl(model, input)).toBe('Email address');
    expect(accessibleName(model, input)).toBe('Email address');
    expect(accessibleName(model, trigger)).toBe('Safe label non-secret field');
  });

  it('uses the preload candidate precedence and suppresses secret-select descendants', () => {
    const node = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: { 'data-testid': 'primary', placeholder: 'Email' },
    });
    const option = makeNode({
      nodeId: 4,
      tagName: 'option',
      insideSecretSelect: true,
      attributes: { value: '[redacted]' },
    });
    const model = makeModel(documentNodes([node, option]));
    const candidates = generateLocatorCandidates(model, model.nodes[2]);

    expect(candidates.slice(0, 2)).toMatchObject([
      { kind: 'testId', value: 'primary' },
      { kind: 'placeholder', value: 'Email' },
    ]);
    expect(generateLocatorCandidates(model, model.nodes[3])).toEqual([]);
  });

  // Playwright never names list or landmark roles from their content, so a
  // recorded getByRole('listitem', { name: <text> }) would match nothing.
  it('names list and landmark role candidates only from author labels', () => {
    const item = makeNode({ nodeId: 3, tagName: 'li', text: 'Item A' });
    const nav = makeNode({
      nodeId: 4,
      tagName: 'nav',
      text: 'Home About',
      attributes: { 'aria-label': 'Primary' },
    });
    const heading = makeNode({ nodeId: 5, tagName: 'h2', text: 'History' });
    const model = makeModel(documentNodes([item, nav, heading]));
    const roles = (index: number): unknown[] =>
      generateLocatorCandidates(model, model.nodes[index])
        .filter((candidate) => candidate.kind === 'role')
        .map(({ value, name }) => [value, name]);

    expect(roles(2)).toEqual([]);
    expect(roles(3)).toEqual([['navigation', 'Primary']]);
    expect(roles(4)).toEqual([['heading', 'History']]);
  });
});

describe('quote', () => {
  it.each(['first\nsecond', 'first\r\nsecond', "it's a \\ path\u2028and more"])(
    'gives a script literal that evaluates to %j',
    (text) => {
      expect(runInNewContext(quote(text))).toBe(text);
    },
  );
});

describe('projectInputSnapshot', () => {
  it('projects host metadata, frozen names, safe values, pagination, and runtime generation', () => {
    const label = makeNode({
      nodeId: 3,
      tagName: 'label',
      attributes: { for: 'email' },
      text: 'Work email',
      labelText: 'Work email',
    });
    const input = makeNode({
      nodeId: 4,
      tagName: 'input',
      attributes: {
        id: 'email',
        type: 'email',
        placeholder: 'you@example.test',
      },
      value: '  person@example.test  ',
      checked: false,
      parentIndex: 1,
    });
    const button = makeNode({
      nodeId: 5,
      tagName: 'button',
      attributes: { 'data-testid': 'save', disabled: '' },
      text: 'Save',
      parentIndex: 1,
    });
    const hidden = makeNode({
      nodeId: 6,
      tagName: 'input',
      attributes: { type: 'password' },
      computedStyles: { display: 'none', visibility: 'visible' },
      parentIndex: 1,
    });
    const nodes = documentNodes([label, input, button, hidden]);
    const model = makeModel(nodes, {
      coverage: [
        {
          frameRef: 'child-frame-ref',
          url: 'https://frame.example.test/only-path',
          status: 'omitted',
          reason: 'cross-origin',
        },
      ],
    });
    const request: BrowserInputSnapshotRequest = {
      browserId: 'request-browser-id',
      filter: { role: 'TEXTBOX' },
      offset: 0,
      limit: 1,
    };

    const result = projectInputSnapshot(model, request, {
      browserId: 'authoritative-browser-id',
      url: 'https://host.example.test/current',
      title: 'Host title',
    });

    expect(result).toMatchObject({
      browserId: 'authoritative-browser-id',
      runtimeGeneration: 12,
      url: 'https://host.example.test/current',
      title: 'Host title',
      capturedAt: model.capturedAt,
      filter: { role: 'TEXTBOX' },
      offset: 0,
      limit: 1,
      total: 1,
      returned: 1,
      truncated: false,
      frames: [
        {
          frameRef: 'child-frame-ref',
          url: 'https://frame.example.test/only-path',
          status: 'omitted',
          reason: 'cross-origin',
        },
      ],
    });
    expect(result.inputs).toHaveLength(1);
    // E1: a top-document light-DOM row says nothing about where it is.
    expect(result.inputs[0]?.frameRef).toBeUndefined();
    expect(result.inputs[0]?.inShadowRoot).toBeUndefined();
    expect(result.inputs[0]).toMatchObject({
      inViewport: true,
      tagName: 'input',
      role: 'textbox',
      inputType: 'email',
      name: 'Work email',
      placeholder: 'you@example.test',
      value: 'person@example.test',
      disabled: false,
      bounds: { x: 0, y: 0, width: 40, height: 20 },
    });
    expect(result.inputs[0]?.ref).toMatch(/^r-/);
  });

  it('keeps names and filters redaction-safe and marks every sensitive control', () => {
    const password = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: {
        type: 'password',
        value: '[redacted]',
        'data-testid': 'password-field',
      },
      value: undefined,
      secret: true,
      text: '',
      parentIndex: 1,
    });
    const parent = makeNode({
      nodeId: 4,
      tagName: 'button',
      attributes: { 'aria-label': 'Save' },
      text: '',
      hasSecretDescendant: true,
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([password, parent]));
    const result = projectInputSnapshot(
      model,
      { browserId: 'ignored', filter: { name: 'save' } },
      { browserId: 'host-id', url: 'https://host.test', title: 'Host' },
    );

    expect(result.total).toBe(1);
    expect(result.inputs[0]).toMatchObject({
      name: 'Save',
      text: undefined,
      locator: "page.locator('body > button')",
    });
    const allRows = projectInputSnapshot(
      model,
      { browserId: 'ignored' },
      { browserId: 'host-id', url: 'https://host.test', title: 'Host' },
    );
    expect(allRows.inputs).toHaveLength(2);
    expect(allRows.inputs[0]).toMatchObject({
      name: undefined,
      text: undefined,
      valueRedacted: true,
    });
    expect(JSON.stringify(allRows)).not.toContain('password-field');
    expect(JSON.stringify(allRows)).not.toContain('super-secret-seed');
  });

  it('rounds bounds like the preload and withholds values the snapshot could not see', async () => {
    const known = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: { id: 'known' },
      value: 'visible',
      bounds: { x: 10.5, y: 20.49, width: 99.5, height: 18.4 },
      parentIndex: 1,
    });
    const unknown = makeNode({
      nodeId: 4,
      tagName: 'input',
      attributes: { id: 'unslotted' },
      valueUnknown: true,
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([known, unknown]));
    const result = projectInputSnapshot(
      model,
      { browserId: 'rounding', limit: 10 },
      { browserId: 'rounding', url: '', title: '' },
    );
    expect(
      result.inputs.map((row) => [row.bounds, row.value, row.valueRedacted]),
    ).toEqual([
      [{ x: 11, y: 20, width: 100, height: 18 }, 'visible', undefined],
      [{ x: 0, y: 0, width: 40, height: 20 }, undefined, true],
    ]);
    const inspected = await projectInspect(model, unknown.identity, {
      enrich: () => Promise.resolve(null),
    });
    expect(inspected).toMatchObject({ valueRedacted: true });
    expect(inspected?.value).toBeUndefined();
    expect(
      (
        await projectInspect(model, known.identity, {
          enrich: () => Promise.resolve(null),
        })
      )?.bounds,
    ).toEqual({ x: 11, y: 20, width: 100, height: 18 });
  });

  it('uses preload pagination defaults and caps requested limits at 100', () => {
    const controls = Array.from({ length: 130 }, (_, index) =>
      makeNode({
        nodeId: index + 3,
        tagName: 'button',
        attributes: { 'data-testid': `button-${index}` },
        parentIndex: 1,
      }),
    );
    const model = makeModel(documentNodes(controls));
    const page = {
      browserId: 'browser',
      url: 'https://host.test',
      title: 'Host',
    };
    const defaults = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      page,
    );
    const capped = projectInputSnapshot(
      model,
      { browserId: 'browser', offset: 110, limit: 500 },
      page,
    );

    expect(defaults).toMatchObject({
      offset: 0,
      limit: 25,
      total: 130,
      returned: 25,
      truncated: true,
      nextOffset: 25,
    });
    expect(capped).toMatchObject({
      offset: 110,
      limit: 100,
      total: 130,
      returned: 20,
      truncated: false,
    });
    expect(capped.nextOffset).toBeUndefined();
  });

  it('does not treat a disabled attribute as disabled on unsupported elements', () => {
    const button = makeNode({
      nodeId: 3,
      tagName: 'button',
      attributes: { disabled: '' },
      parentIndex: 1,
    });
    const roleButton = makeNode({
      nodeId: 4,
      tagName: 'div',
      attributes: { role: 'button', disabled: '' },
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([button, roleButton]));
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser', filter: { role: 'button' } },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );

    expect(result.inputs.map((input) => input.disabled)).toEqual([true, false]);
  });

  it('projects native and ARIA state, requiredness, validity, and read-only fields', () => {
    const checkbox = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: { type: 'checkbox', placeholder: 'native-checkbox' },
      checked: true,
      parentIndex: 1,
    });
    const radio = makeNode({
      nodeId: 4,
      tagName: 'input',
      attributes: { type: 'radio', placeholder: 'native-radio' },
      checked: false,
      parentIndex: 1,
    });
    const plainText = makeNode({
      nodeId: 5,
      tagName: 'input',
      attributes: { type: 'text', placeholder: 'plain-text' },
      parentIndex: 1,
    });
    const ariaCheckbox = makeNode({
      nodeId: 6,
      tagName: 'div',
      attributes: {
        role: 'checkbox',
        'aria-label': 'ARIA checkbox',
        'aria-checked': 'mixed',
        'aria-expanded': 'false',
        'aria-selected': 'true',
        'aria-pressed': 'mixed',
        'aria-required': 'false',
        'aria-invalid': 'spelling',
        'aria-readonly': 'true',
      },
      parentIndex: 1,
    });
    const requiredReadonly = makeNode({
      nodeId: 7,
      tagName: 'textarea',
      attributes: { id: 'required-readonly', required: '', readonly: '' },
      parentIndex: 1,
    });
    const model = makeModel(
      documentNodes([
        checkbox,
        radio,
        plainText,
        ariaCheckbox,
        requiredReadonly,
      ]),
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const rowForPlaceholder = (
      placeholder: string,
    ): BrowserInputSnapshotItem | undefined =>
      result.inputs.find((row) => row.placeholder === placeholder);

    // A checkbox or radio is chosen with set_checked, not filled.
    expect(rowForPlaceholder('native-checkbox')).toMatchObject({
      checked: true,
    });
    expect(rowForPlaceholder('native-checkbox')).not.toHaveProperty('editable');
    expect(rowForPlaceholder('native-radio')).toMatchObject({ checked: false });
    expect(rowForPlaceholder('native-radio')).not.toHaveProperty('editable');
    expect(rowForPlaceholder('plain-text')).not.toHaveProperty('checked');
    expect(
      result.inputs.find((row) => row.name === 'ARIA checkbox'),
    ).toMatchObject({
      checked: 'mixed',
      expanded: false,
      selected: true,
      pressed: 'mixed',
      required: false,
      invalid: true,
      readOnly: true,
    });
    expect(
      result.inputs.find((row) => row.tagName === 'textarea'),
    ).toMatchObject({
      required: true,
      readOnly: true,
      editable: false,
    });
  });

  it('projects only applicable constraints and D5 compound formats', () => {
    const text = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: {
        type: 'email',
        placeholder: 'email-constraints',
        pattern: '[^@]+@[^@]+',
        minlength: '2',
        maxlength: '80',
      },
      parentIndex: 1,
    });
    const date = makeNode({
      nodeId: 4,
      tagName: 'input',
      attributes: {
        type: 'date',
        placeholder: 'date-constraints',
        min: '2026-01-01',
        max: '2026-12-31',
        step: '2',
      },
      parentIndex: 1,
    });
    const file = makeNode({
      nodeId: 5,
      tagName: 'input',
      attributes: {
        type: 'file',
        placeholder: 'file-constraints',
        accept: '.pdf,.txt',
        multiple: '',
      },
      parentIndex: 1,
    });
    const datepicker = makeNode({
      nodeId: 6,
      tagName: 'input',
      attributes: {
        type: 'text',
        placeholder: 'datepicker-format-unknown',
        class: 'calendar-datepicker',
      },
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([text, date, file, datepicker]));
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const rowForPlaceholder = (
      placeholder: string,
    ): BrowserInputSnapshotItem | undefined =>
      result.inputs.find((row) => row.placeholder === placeholder);

    expect(rowForPlaceholder('email-constraints')?.constraints).toEqual({
      pattern: '[^@]+@[^@]+',
      minLength: 2,
      maxLength: 80,
    });
    expect(rowForPlaceholder('date-constraints')?.constraints).toEqual({
      min: '2026-01-01',
      max: '2026-12-31',
      step: '2',
    });
    expect(rowForPlaceholder('file-constraints')?.constraints).toEqual({
      accept: '.pdf,.txt',
      multiple: true,
    });
    expect(rowForPlaceholder('datepicker-format-unknown')).not.toHaveProperty(
      'format',
    );
  });

  it.each([
    ['date', 'YYYY-MM-DD'],
    ['time', 'HH:MM'],
    ['datetime-local', 'YYYY-MM-DDTHH:MM'],
    ['month', 'YYYY-MM'],
    ['week', 'YYYY-Www'],
    ['color', '#RRGGBB'],
    ['range', '1 to 9 in steps of 2'],
  ])('formats %s input rows', (type, format) => {
    const input = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: {
        type,
        placeholder: `${type}-format`,
        ...(type === 'range' ? { min: '1', max: '9', step: '2' } : {}),
      },
      parentIndex: 1,
    });
    const result = projectInputSnapshot(
      makeModel(documentNodes([input])),
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );

    expect(result.inputs[0]?.format).toBe(format);
  });

  it('projects D15 fields on the existing form-controls recording', async () => {
    const model = await buildPageModel(
      recordedDeps(loadRecording('form-controls')),
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser', limit: 100 },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const row = (name: string): BrowserInputSnapshotItem | undefined =>
      result.inputs.find((item) => item.name === name);

    expect(row('Subscribe')).toMatchObject({ checked: true });
    expect(row('Subscribe')).not.toHaveProperty('editable');
    expect(row('Color')).toMatchObject({
      optionCount: 3,
      options: [
        { value: 'red', label: 'Red', selected: false, disabled: false },
        {
          value: 'Plain text option',
          label: 'Plain text option',
          selected: true,
          disabled: false,
        },
        { value: 'blue', label: 'Blue', selected: false, disabled: false },
      ],
    });
    expect(row('Edit me')).toMatchObject({ editable: true });
    expect(row('Volume')).toMatchObject({ format: '0 to 100 in steps of 1' });
  });

  it('recognizes editable hosts and inherited contenteditable state without crossing false', () => {
    const emptyEditor = makeNode({
      nodeId: 3,
      tagName: 'div',
      attributes: { contenteditable: '', 'aria-label': 'empty editor' },
      childIndexes: [3],
      parentIndex: 1,
    });
    const inheritedButton = makeNode({
      nodeId: 4,
      tagName: 'button',
      attributes: { 'aria-label': 'inherited editable child' },
      parentIndex: 2,
    });
    const plaintextEditor = makeNode({
      nodeId: 5,
      tagName: 'div',
      attributes: {
        contenteditable: 'plaintext-only',
        'aria-label': 'plaintext editor',
      },
      parentIndex: 1,
    });
    const falseEditor = makeNode({
      nodeId: 6,
      tagName: 'div',
      attributes: {
        contenteditable: 'false',
        tabindex: '0',
        'aria-label': 'false editor',
      },
      childIndexes: [6],
      parentIndex: 1,
    });
    const falseChild = makeNode({
      nodeId: 7,
      tagName: 'button',
      attributes: { 'aria-label': 'false inherited child' },
      parentIndex: 5,
    });
    const readonly = makeNode({
      nodeId: 8,
      tagName: 'input',
      attributes: { type: 'text', readonly: '', placeholder: 'readonly' },
      parentIndex: 1,
    });
    const disabled = makeNode({
      nodeId: 9,
      tagName: 'input',
      attributes: { type: 'text', disabled: '', placeholder: 'disabled' },
      parentIndex: 1,
    });
    const model = makeModel(
      documentNodes([
        emptyEditor,
        inheritedButton,
        plaintextEditor,
        falseEditor,
        falseChild,
        readonly,
        disabled,
      ]),
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );

    expect(
      result.inputs.find((row) => row.name === 'empty editor'),
    ).toMatchObject({
      editable: true,
    });
    expect(
      result.inputs.find((row) => row.name === 'inherited editable child'),
    ).toMatchObject({ editable: true });
    expect(
      result.inputs.find((row) => row.name === 'plaintext editor'),
    ).toMatchObject({
      editable: true,
    });
    expect(
      result.inputs.find((row) => row.name === 'false editor'),
    ).toMatchObject({
      editable: false,
    });
    expect(
      result.inputs.find((row) => row.name === 'false inherited child'),
    ).toMatchObject({ editable: false });
    expect(
      result.inputs.find((row) => row.placeholder === 'readonly'),
    ).toMatchObject({
      readOnly: true,
      editable: false,
    });
    expect(
      result.inputs.find((row) => row.placeholder === 'disabled'),
    ).toMatchObject({
      disabled: true,
      editable: false,
    });
  });

  it('projects native and ARIA options once, including selection and disabled optgroups', () => {
    const select = makeNode({
      nodeId: 3,
      tagName: 'select',
      attributes: { multiple: '' },
      childIndexes: [3, 4],
      parentIndex: 1,
    });
    const selectedOption = nodeWithSelectedState(
      makeNode({
        nodeId: 4,
        tagName: 'option',
        attributes: { value: 'primary', label: 'Primary option' },
        text: 'ignored option text',
        parentIndex: 2,
      }),
      true,
    );
    const optgroup = makeNode({
      nodeId: 5,
      tagName: 'optgroup',
      attributes: { disabled: '' },
      childIndexes: [5],
      parentIndex: 2,
    });
    const groupedOption = nodeWithSelectedState(
      makeNode({
        nodeId: 6,
        tagName: 'option',
        attributes: { value: 'secondary' },
        text: '  Secondary\n option  ',
        parentIndex: 4,
      }),
      false,
    );
    const model = makeModel(
      documentNodes([select, selectedOption, optgroup, groupedOption]),
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const selectRow = result.inputs.find((row) => row.tagName === 'select');

    expect(selectRow).toMatchObject({
      optionCount: 2,
      constraints: { multiple: true },
      options: [
        {
          value: 'primary',
          label: 'Primary option',
          selected: true,
          disabled: false,
        },
        {
          value: 'secondary',
          label: 'Secondary option',
          selected: false,
          disabled: true,
        },
      ],
    });
  });

  it('gives a native option without a value attribute its text as the value, as the browser does', () => {
    const select = makeNode({
      nodeId: 3,
      tagName: 'select',
      childIndexes: [3],
      parentIndex: 1,
    });
    const option = nodeWithSelectedState(
      makeNode({
        nodeId: 4,
        tagName: 'option',
        attributes: { label: 'United States' },
        text: ' US ',
        parentIndex: 2,
      }),
      true,
    );
    const result = projectInputSnapshot(
      makeModel(documentNodes([select, option])),
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );

    expect(
      result.inputs.find((row) => row.tagName === 'select')?.options,
    ).toEqual([
      { value: 'US', label: 'United States', selected: true, disabled: false },
    ]);
  });

  it('gives option values exactly as the page holds them, and marks one cut short', () => {
    const select = makeNode({
      nodeId: 3,
      tagName: 'select',
      childIndexes: [3, 4, 5, 6],
      parentIndex: 1,
    });
    const option = (
      nodeId: number,
      attributes: Record<string, string>,
      text: string,
    ): ReturnType<typeof makeNode> =>
      makeNode({ nodeId, tagName: 'option', attributes, text, parentIndex: 2 });
    const result = projectInputSnapshot(
      makeModel(
        documentNodes([
          select,
          option(4, { value: ' a ' }, 'Spaced'),
          option(5, { value: 'a' }, 'Plain'),
          option(6, { value: 'x'.repeat(300) }, 'Long'),
          option(7, {}, 'y'.repeat(120)),
        ]),
      ),
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );

    expect(
      result.inputs.find((row) => row.tagName === 'select')?.options,
    ).toEqual([
      { value: ' a ', label: 'Spaced', selected: false, disabled: false },
      { value: 'a', label: 'Plain', selected: false, disabled: false },
      {
        value: 'x'.repeat(240),
        valueTruncated: true,
        label: 'Long',
        selected: false,
        disabled: false,
      },
      {
        value: 'y'.repeat(120),
        valueTruncated: true,
        label: 'y'.repeat(120),
        selected: false,
        disabled: false,
      },
    ]);
  });

  it('caps listbox option labels at 20 while counting all options', () => {
    const options = Array.from({ length: 21 }, (_, index) =>
      makeNode({
        nodeId: 4 + index,
        tagName: 'div',
        attributes: {
          role: 'option',
          'data-value': `value-${index}`,
          'aria-selected': index === 0 ? 'true' : 'false',
          ...(index === 1 ? { 'aria-disabled': 'true' } : {}),
        },
        text: `  Option\n ${index}  `,
        parentIndex: 2,
      }),
    );
    const listbox = makeNode({
      nodeId: 3,
      tagName: 'div',
      attributes: { role: 'listbox' },
      childIndexes: options.map((_, index) => index + 3),
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([listbox, ...options]));
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser' },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const listboxRow = result.inputs.find((row) => row.role === 'listbox');

    expect(listboxRow?.optionCount).toBe(21);
    expect(listboxRow?.options).toHaveLength(20);
    expect(listboxRow?.options?.[0]).toEqual({
      value: 'value-0',
      label: 'Option 0',
      selected: true,
      disabled: false,
    });
    expect(listboxRow?.options?.[1]).toMatchObject({
      value: 'value-1',
      selected: false,
      disabled: true,
    });
  });

  it('gives a native option without a value attribute the value the browser gives it, non-ASCII spaces included', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(9701, 'select', { id: 'nbsp-select' }, [
        elementRecord(9702, 'option', {}, [textRecord(9703, '  A\u00a0B  ')]),
        elementRecord(9704, 'option', { value: 'A B' }, [
          textRecord(9705, 'Plain'),
        ]),
      ]),
    );
    const visibleStyles: NonNullable<ReplayOptions['readStyles']> = (
      _frameId,
      _sessionId,
      ids,
    ) =>
      Promise.resolve(
        ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
      );
    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser', limit: 100 },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const row = result.inputs.find(
      (item) =>
        item.tagName === 'select' &&
        item.options?.some((option) => option.label === 'Plain'),
    );

    expect(row?.options?.map((option) => option.value)).toEqual([
      'A\u00a0B',
      'A B',
    ]);
  });

  it('redacts built secret ARIA list options while preserving their structural count', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9601,
        'div',
        {
          id: 'aria-secret-list',
          role: 'listbox',
          autocomplete: 'cc-exp-month',
        },
        [
          elementRecord(
            9602,
            'div',
            {
              id: 'aria-secret-option-one',
              role: 'option',
              'aria-selected': 'true',
              'data-value': 'SECRET-ARIA-VALUE-9602',
            },
            [textRecord(9603, 'SECRET-ARIA-LABEL-9603')],
          ),
          elementRecord(
            9604,
            'div',
            {
              id: 'aria-secret-option-two',
              role: 'option',
              'aria-selected': 'false',
              'data-value': 'SECRET-ARIA-VALUE-9604',
            },
            [textRecord(9605, 'SECRET-ARIA-LABEL-9605')],
          ),
        ],
      ),
    );
    const visibleStyles: NonNullable<ReplayOptions['readStyles']> = (
      _frameId,
      _sessionId,
      ids,
    ) =>
      Promise.resolve(
        ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
      );
    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
    );
    const option = model.nodes.find(
      (node) => node.identity.backendNodeId === 9602,
    );
    const result = projectInputSnapshot(
      model,
      { browserId: 'browser', limit: 100 },
      { browserId: 'browser', url: 'https://host.test', title: 'Host' },
    );
    const listboxRow = result.inputs.find(
      (row) =>
        row.name === undefined &&
        row.role === 'listbox' &&
        row.tagName === 'div',
    );

    expect(option).toMatchObject({
      secret: true,
      insideSecretSelect: true,
      isAriaOption: true,
      attributes: { role: '[redacted]', 'aria-selected': '[redacted]' },
    });
    expect(option).not.toHaveProperty('selected');
    expect(listboxRow).toMatchObject({
      optionCount: 2,
      optionsRedacted: true,
    });
    expect(listboxRow).not.toHaveProperty('options');
    expect(listboxRow).not.toHaveProperty('selected');
    expect(JSON.stringify(result)).not.toContain('SECRET-ARIA-');
  });
});

describe('projectInspect', () => {
  it('resolves all identity components and enriches only main-frame light DOM', async () => {
    const button = makeNode({
      nodeId: 3,
      tagName: 'button',
      attributes: { 'aria-label': 'Apply' },
      text: 'Apply changes',
      parentIndex: 1,
    });
    const nodeWithSameBackendId = makeNode({
      nodeId: 3,
      tagName: 'input',
      identity: {
        sessionId: 'different-session',
        frameId: ROOT_FRAME_ID,
        loaderId: ROOT_LOADER_ID,
        backendNodeId: 3,
      },
      attributes: { type: 'password' },
      parentIndex: 1,
    });
    const nodes = documentNodes([button, nodeWithSameBackendId]);
    const model = makeModel(nodes);
    const identity = nodes[2]?.identity;
    if (!identity) throw new Error('Fixture node identity missing.');
    let enrichCalls = 0;
    const enrichedCandidates: BrowserLocatorCandidate[] = [
      {
        kind: 'role',
        value: 'button',
        name: 'Apply',
        unique: false,
        confidence: 'high',
        playwright: "page.getByRole('button', { name: 'Apply' })",
      },
    ];
    const enrich: Parameters<typeof projectInspect>[2]['enrich'] = (
      requestedIdentity,
    ) => {
      enrichCalls += 1;
      expect(requestedIdentity).toEqual(identity);
      return Promise.resolve({
        locatorCandidates: enrichedCandidates,
        preferredLocator: enrichedCandidates[0],
        domPath: ['html', 'body', 'button'],
        outerHtml: '<button aria-label="Apply">Apply changes</button>',
      });
    };

    const snapshot = await projectInspect(model, identity, { enrich });

    expect(enrichCalls).toBe(1);
    expect(snapshot).toMatchObject({
      browserId: model.page.browserId,
      runtimeGeneration: 12,
      url: model.page.url,
      title: model.page.title,
      capturedAt: model.capturedAt,
      viewport: model.page.viewport,
      themeMode: 'dark',
      tagName: 'button',
      accessibleName: 'Apply',
      text: 'Apply changes',
      preferredLocator: enrichedCandidates[0],
      locatorCandidates: enrichedCandidates,
      outerHtml: '<button aria-label="Apply">Apply changes</button>',
    });

    const wrongIdentity = {
      ...identity,
      sessionId: 'unknown-session',
    };
    const absent = await projectInspect(model, wrongIdentity, {
      enrich: () =>
        Promise.reject(new Error('Must not enrich a missing identity.')),
    });
    expect(absent).toBeUndefined();
  });

  it('uses safe model fallback for sensitive nodes, excludes values and secret-select options', async () => {
    const secretInput = makeNode({
      nodeId: 3,
      tagName: 'input',
      attributes: {
        type: 'password',
        value: '[redacted]',
        'data-testid': 'auth-control',
      },
      value: undefined,
      text: '',
      secret: true,
      parentIndex: 1,
    });
    const select = makeNode({
      nodeId: 4,
      tagName: 'select',
      attributes: { autocomplete: 'cc-exp' },
      secret: true,
      hasSecretDescendant: true,
      parentIndex: 1,
      childIndexes: [4],
    });
    const option = makeNode({
      nodeId: 5,
      tagName: 'option',
      nodeType: 1,
      attributes: { label: '[redacted]', value: '[redacted]' },
      insideSecretSelect: true,
      parentIndex: 3,
      text: '',
    });
    const nodes = documentNodes([secretInput, select, option]);
    const model = makeModel(nodes);
    const secretIdentity = nodes[2]?.identity;
    const optionIdentity = nodes[4]?.identity;
    if (!secretIdentity || !optionIdentity) {
      throw new Error('Fixture identities missing.');
    }
    let enrichCalls = 0;
    const noEnrich: Parameters<typeof projectInspect>[2] = {
      enrich: () => {
        enrichCalls += 1;
        return Promise.resolve(null);
      },
    };

    const secretSnapshot = await projectInspect(
      model,
      secretIdentity,
      noEnrich,
    );
    const optionSnapshot = await projectInspect(
      model,
      optionIdentity,
      noEnrich,
    );

    expect(enrichCalls).toBe(0);
    expect(secretSnapshot).toMatchObject({
      valueRedacted: true,
      locatorCandidates: [
        {
          kind: 'css',
          value: 'body > input',
          playwright: "page.locator('body > input')",
        },
      ],
    });
    expect(secretSnapshot?.outerHtml).toBe(
      '<input type="password" data-testid="auth-control">',
    );
    expect(secretSnapshot?.attributes.value).toBe('[redacted]');
    expect(optionSnapshot?.locatorCandidates).toEqual([]);
    expect(optionSnapshot?.outerHtml).toBe('');
    expect(optionSnapshot?.attributes).toMatchObject({
      label: '[redacted]',
      value: '[redacted]',
    });
    const serialized = JSON.stringify([secretSnapshot, optionSnapshot]);
    expect(serialized).not.toContain('super-secret-seed');
    expect(serialized).not.toContain('value="');
  });

  it('assembles text-node markup in source order and omits textarea content', () => {
    const root = makeNode({
      nodeId: 3,
      tagName: 'div',
      ownText: 'incorrect fallback',
      childIndexes: [3, 4, 6],
      parentIndex: 1,
    });
    const before = makeTextNode(4, 2, 'before');
    const button = makeNode({
      nodeId: 5,
      tagName: 'button',
      childIndexes: [5],
      parentIndex: 2,
    });
    const buttonText = makeTextNode(6, 4, 'middle');
    const after = makeTextNode(7, 2, 'after');
    const textarea = makeNode({
      nodeId: 8,
      tagName: 'textarea',
      text: 'private textarea content',
      ownText: 'private textarea content',
      childIndexes: [7],
      parentIndex: 1,
    });
    const textareaText = makeTextNode(9, 6, 'private textarea content');
    const nodes = documentNodes([
      root,
      before,
      button,
      buttonText,
      after,
      textarea,
      textareaText,
    ]);
    const model = makeModel(nodes);

    expect(safeOuterHtml(model, root)).toBe(
      '<div>before<button>middle</button>after</div>',
    );
    expect(safeOuterHtml(model, textarea)).toBe('<textarea></textarea>');
    expect(JSON.stringify(safeOuterHtml(model, textarea))).not.toContain(
      'private textarea content',
    );
  });
  it.each([
    [200, 1],
    [201, 0],
  ])(
    'hands at most 200 secret controls to the preload: %i controls, %i enrichments (PR #4917 finding 1)',
    async (count, calls) => {
      const formIndex = 2;
      const controls = Array.from({ length: count }, (_, index) =>
        makeNode({
          nodeId: 10 + index,
          tagName: 'input',
          secret: true,
          attributes: { type: 'password' },
          parentIndex: formIndex,
        }),
      );
      const form = makeNode({
        nodeId: 3,
        tagName: 'form',
        hasSecretDescendant: true,
        parentIndex: 1,
        childIndexes: controls.map((_, index) => formIndex + 1 + index),
      });
      const model = makeModel([...documentNodes([form]), ...controls]);
      const enrich = jest.fn<
        Promise<{
          locatorCandidates: [];
          domPath: string[];
          outerHtml: string;
        }>,
        [NodeIdentity, NodeIdentity[]]
      >(() =>
        Promise.resolve({
          locatorCandidates: [],
          domPath: ['html', 'body', 'form'],
          outerHtml: '<form></form>',
        }),
      );
      await projectInspect(model, form.identity, {
        enrich,
        allowSensitiveEnrichment: true,
      });
      expect(enrich).toHaveBeenCalledTimes(calls);
      if (calls > 0) {
        expect(
          enrich.mock.calls[0]?.[1].map((control) => control.backendNodeId),
        ).toEqual(expect.arrayContaining(controls.map((node) => node.nodeId)));
        expect(enrich.mock.calls[0]?.[1]).toHaveLength(count);
      }
    },
  );

  it('uses the redaction-safe preload bridge for secret-select inspection only on host opt-in', async () => {
    const option = makeNode({
      nodeId: 3,
      tagName: 'option',
      secret: true,
      insideSecretSelect: true,
      attributes: { id: '[redacted]', value: '[redacted]' },
      text: '',
      ownText: '',
      parentIndex: 1,
    });
    const model = makeModel(documentNodes([option]));
    const identity = model.nodes[2]?.identity;
    if (!identity) throw new Error('Missing option fixture.');
    const enrich = jest.fn(() =>
      Promise.resolve({
        locatorCandidates: [],
        domPath: ['html', 'body', 'option'],
        outerHtml:
          '<option id="[redacted]" value="[redacted]">[redacted]</option>',
      }),
    );
    const snapshot = await projectInspect(model, identity, {
      enrich,
      allowSensitiveEnrichment: true,
    });
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      valueRedacted: true,
      locatorCandidates: [],
      attributes: { id: '[redacted]', value: '[redacted]' },
      outerHtml:
        '<option id="[redacted]" value="[redacted]">[redacted]</option>',
    });
    expect(snapshot?.text).toBeUndefined();
    expect(snapshot?.value).toBeUndefined();
    expect(snapshot?.accessibleName).toBeUndefined();
    expect(snapshot?.preferredLocator).toBeUndefined();
  });

  async function expectSecretAriaBridgeSkipped(
    model: BrowserPageModel,
    node: PageModelNode,
  ): Promise<void> {
    const marker = 'SECRET-ARIA-LIVE-PRELOAD-SEED';
    const candidate: BrowserLocatorCandidate = {
      kind: 'css',
      value: marker,
      unique: true,
      confidence: 'high',
      playwright: `page.locator('${marker}')`,
    };
    const enrich = jest.fn(() =>
      Promise.resolve({
        locatorCandidates: [candidate],
        preferredLocator: candidate,
        domPath: [marker],
        outerHtml: `<div>${marker}</div>`,
      }),
    );
    const snapshot = await projectInspect(model, node.identity, {
      enrich,
      allowSensitiveEnrichment: true,
    });

    expect(enrich).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).not.toContain(marker);
  }

  it('does not enrich a secret ARIA list itself with the live preload bridge', async () => {
    const listbox = makeNode({
      nodeId: 3,
      tagName: 'div',
      attributes: { role: 'listbox' },
      secret: true,
      hasSecretDescendant: true,
      childIndexes: [3],
      parentIndex: 1,
    });
    const option = makeNode({
      nodeId: 4,
      tagName: 'div',
      attributes: { role: 'option', 'aria-selected': 'true' },
      secret: true,
      insideSecretSelect: true,
      text: '',
      parentIndex: 2,
    });
    const model = makeModel(documentNodes([listbox, option]));

    await expectSecretAriaBridgeSkipped(model, model.nodes[2] ?? listbox);
  });

  it('does not enrich a descendant marked insideSecretSelect', async () => {
    const listbox = makeNode({
      nodeId: 3,
      tagName: 'div',
      attributes: { role: 'listbox' },
      secret: true,
      hasSecretDescendant: true,
      childIndexes: [3],
      parentIndex: 1,
    });
    const option = makeNode({
      nodeId: 4,
      tagName: 'div',
      attributes: { role: '[redacted]', 'aria-selected': '[redacted]' },
      secret: true,
      insideSecretSelect: true,
      text: '',
      parentIndex: 2,
    });
    const model = makeModel(documentNodes([listbox, option]));

    await expectSecretAriaBridgeSkipped(model, model.nodes[3] ?? option);
  });

  it('does not enrich an ancestor whose subtree contains a secret ARIA list', async () => {
    const ancestor = makeNode({
      nodeId: 3,
      tagName: 'div',
      hasSecretDescendant: true,
      childIndexes: [3],
      parentIndex: 1,
    });
    const listbox = makeNode({
      nodeId: 4,
      tagName: 'div',
      attributes: { role: 'listbox' },
      secret: true,
      hasSecretDescendant: true,
      childIndexes: [4],
      parentIndex: 2,
    });
    const option = makeNode({
      nodeId: 5,
      tagName: 'div',
      attributes: { role: '[redacted]', 'aria-selected': '[redacted]' },
      secret: true,
      insideSecretSelect: true,
      text: '',
      parentIndex: 3,
    });
    const model = makeModel(documentNodes([ancestor, listbox, option]));

    await expectSecretAriaBridgeSkipped(model, model.nodes[2] ?? ancestor);
  });
});
