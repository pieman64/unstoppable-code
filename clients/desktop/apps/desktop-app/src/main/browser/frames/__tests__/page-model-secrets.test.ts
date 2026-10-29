import { decodeDOMSnapshot } from '../cdp-decode';
import type { BrowserPageModel, PageModelNode } from '../model-types';
import {
  buildConsistentModel,
  buildPageModel,
  buildPageModelWithFallback,
} from '../page-model';
import { projectInputSnapshot, projectInspect } from '../projections';
import { isActionTargetSecret } from '../target-state';
import {
  loadRecording,
  recordedDeps,
  recordedHtml,
  type Recording,
  type ReplayOptions,
} from './fixtures/recorded-cdp';
import {
  appendChild,
  childList,
  cloneRecording,
  elementRecord,
  findTreeNode,
  hasAttribute,
  isJsonRecord,
  numberField,
  parentOf,
  replaceChild,
  snapshotEditor,
  textRecord,
  treeRoot,
} from './fixtures/recording-edit';

/** Every seeded value in the recorded pages has this shape. */
const SEED_PATTERN = /SEED-[A-Z-]+-\d{4}/g;
const PAGE = { browserId: 'secrets', url: '', title: '' };

/**
 * Seeds in a shadow root's plain textarea and select. Phase 04 withheld
 * them; with document-start tracking, textarea and select in shadow roots
 * and child frames follow the main-frame rules (no password history), so
 * these ordinary values are exposed like the main frame's.
 */
const ORDINARY_SEEDS = new Set([
  'SEED-SHADOW-TEXTAREA-6262',
  'SEED-SHADOW-OPTION-7373',
]);

/** Seeds in `value` that must never be exposed. */
function secretSeedsIn(value: string): string[] {
  return (value.match(SEED_PATTERN) ?? []).filter(
    (seed) => !ORDINARY_SEEDS.has(seed),
  );
}

function seedsIn(recording: Recording): string[] {
  const found = JSON.stringify(recording.responses).match(SEED_PATTERN);
  return Array.from(new Set(found ?? []));
}

function stored(model: BrowserPageModel): string {
  return JSON.stringify({
    nodes: model.nodes,
    frames: model.frames,
    coverage: model.coverage,
    accessibility: model.accessibility,
    page: model.page,
  });
}

describe('page-model secrets on recorded Chromium pages', () => {
  it.each(['secrets', 'shadow', 'frames', 'oopif', 'trackers'])(
    '%s: no seeded secret is stored, projected, filterable or inspectable',
    async (name) => {
      const recording = loadRecording(name);
      const seeds = seedsIn(recording);
      // The raw CDP data carries the live secrets the model must withhold.
      expect(seeds.length).toBeGreaterThan(0);
      expect(recordedHtml(name)).toBeTruthy();
      const model = await buildPageModel(recordedDeps(recording), {
        accessibility: name === 'secrets',
      });
      expect(secretSeedsIn(stored(model))).toEqual([]);
      const snapshot = projectInputSnapshot(
        model,
        { browserId: 'secrets', limit: 100 },
        PAGE,
      );
      expect(snapshot.inputs.length).toBeGreaterThan(0);
      // Plain shadow textarea and select values are ordinary page data.
      for (const seed of seeds.filter((value) => ORDINARY_SEEDS.has(value))) {
        expect(JSON.stringify(snapshot)).toContain(seed);
      }
      expect(secretSeedsIn(JSON.stringify(snapshot))).toEqual([]);
      for (const seed of seeds.filter((value) => !ORDINARY_SEEDS.has(value))) {
        const filtered = projectInputSnapshot(
          model,
          { browserId: 'secrets', limit: 100, filter: { name: seed } },
          PAGE,
        );
        expect([seed, filtered.total]).toEqual([seed, 0]);
      }
      for (const node of model.nodes) {
        if (node.nodeType !== 1) continue;
        const inspected = await projectInspect(model, node.identity, {
          enrich: () => Promise.resolve(null),
        });
        expect(secretSeedsIn(JSON.stringify(inspected))).toEqual([]);
      }
    },
  );

  it('redacts secret values and secret-select attributes the way the preload does (M4)', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('secrets')));
    const byId = (id: string): BrowserPageModel['nodes'][number] => {
      const node = model.nodes.find(
        (candidate) => candidate.attributes.id === id,
      );
      if (!node) throw new Error(`Missing #${id}`);
      return node;
    };
    expect(byId('password').attributes).toEqual({
      id: 'password',
      type: 'password',
      value: '[redacted]',
    });
    expect(byId('username').attributes).toEqual({
      id: 'username',
      autocomplete: 'username',
      value: 'ada',
    });
    const group = byId('[redacted]');
    expect(group.tagName).toBe('optgroup');
    expect(group.attributes).toEqual({ id: '[redacted]', label: '[redacted]' });
    const selectedOption = model.nodes.find(
      (node) =>
        node.tagName === 'option' &&
        node.parentIndex === model.nodes.indexOf(group),
    );
    expect(selectedOption?.attributes).toEqual({});
    const inspected = await projectInspect(model, byId('password').identity, {
      enrich: () => Promise.resolve(null),
    });
    expect(inspected).toMatchObject({
      valueRedacted: true,
      attributes: { value: '[redacted]' },
    });
    expect(inspected?.value).toBeUndefined();
  });

  it('keeps label text without nested controls when a label wraps a secret (m7)', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('secrets')));
    const rows = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs;
    const plain = rows.filter((row) => row.name === 'Plain');
    expect(plain.map((row) => row.tagName)).toEqual(['select', 'input']);
    expect(
      rows.find((row) => row.tagName === 'button' && row.text === 'Pay now')
        ?.name,
    ).toBe('Pay');
  });

  it('drops accessibility names that can carry secrets and caches only redacted names (M1)', async () => {
    const recording = loadRecording('secrets');
    const raw = JSON.stringify(
      recording.responses.filter(
        (entry) => entry.method === 'Accessibility.getFullAXTree',
      ),
    );
    // Chromium's tree names the labelled-by button with the card number and
    // has text leaves holding secret values.
    expect(raw).toContain('SEED-CARD-4111');
    expect(raw).toMatch(/"StaticText"/);
    const deps = recordedDeps(recording);
    const first = await buildPageModel(deps, { accessibility: true });
    expect(first.accessibility.length).toBeGreaterThan(20);
    expect(secretSeedsIn(JSON.stringify(first.accessibility))).toEqual([]);
    expect(
      first.accessibility.some(
        (node) => node.role === 'StaticText' && node.name,
      ),
    ).toBe(false);
    // The frame has secrets, so only attribute names survive: the "Expiry"
    // and "Pay" content/labelled-by names are withheld.
    const named = first.accessibility.filter((node) => node.name);
    expect(named.every((node) => node.role !== 'button')).toBe(true);
    // A second build reads the per-document cache, which never held more.
    const send = jest.fn(
      (method: string, params: Record<string, unknown>, sessionId?: string) =>
        deps.send(method, params, sessionId),
    );
    const second = await buildPageModel(
      { ...deps, send },
      { accessibility: true },
    );
    expect(
      send.mock.calls.some(
        ([method]) => method === 'Accessibility.getFullAXTree',
      ),
    ).toBe(false);
    expect(secretSeedsIn(JSON.stringify(second.accessibility))).toEqual([]);
  });

  it('withholds a secret shadow textarea default text from its text nodes (m9)', async () => {
    // Textareas there follow the main-frame rules, so this one is made
    // secret the way a main-frame textarea is: a secret autocomplete token.
    const recording = cloneRecording(loadRecording('shadow'));
    const textareaRecord = findTreeNode(treeRoot(recording), (node) =>
      hasAttribute(node, 'id', 'shadow-textarea'),
    );
    textareaRecord.attributes = [
      'id',
      'shadow-textarea',
      'autocomplete',
      'one-time-code',
    ];
    const model = await buildPageModel(recordedDeps(recording));
    const textarea = model.nodes.find(
      (node) => node.attributes.id === 'shadow-textarea',
    );
    if (!textarea) throw new Error('Missing textarea');
    const textNodes = textarea.childIndexes.map((index) => model.nodes[index]);
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]).toMatchObject({ nodeType: 3, text: '', secret: true });
  });

  it('withholds text beside a secret control in a shadow root, but keeps for= labels (D3)', async () => {
    const model = await buildPageModel(recordedDeps(loadRecording('shadow')));
    const rows = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs;
    expect(rows.find((row) => row.name === 'Note')).toMatchObject({
      inShadowRoot: true,
      valueRedacted: true,
    });
    const revealed = model.nodes.find(
      (node) => node.attributes.id === 'shadow-revealed',
    );
    expect(revealed?.secret).toBe(true);
    const label = model.nodes[revealed?.parentIndex ?? -1];
    expect(label).toMatchObject({
      tagName: 'label',
      labelText: '',
      nameText: '',
      text: '',
      ownText: '',
    });
  });
});

describe('D11a secret ARIA option lists', () => {
  const visibleStyles: NonNullable<ReplayOptions['readStyles']> = (
    _frameId,
    _sessionId,
    ids,
  ) =>
    Promise.resolve(
      ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
    );

  function nodeById(model: BrowserPageModel, id: string): PageModelNode {
    const node = model.nodes.find(
      (candidate) => candidate.attributes.id === id,
    );
    if (!node) throw new Error(`Missing #${id}`);
    return node;
  }

  it('redacts lists named by secret controls and lists with their own secret token', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const body = findTreeNode(
      root,
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9501,
        'input',
        {
          id: 'autocomplete-combo',
          type: 'text',
          role: 'combobox',
          autocomplete: 'cc-exp-month',
          'aria-controls': 'autocomplete-list missing-list',
        },
        [],
      ),
    );
    const autocompleteOption = elementRecord(
      9503,
      'div',
      {
        id: 'autocomplete-option',
        role: 'option',
        'aria-label': 'SEED-ARIA-LABEL-8111',
        'aria-selected': 'true',
        'data-value': 'SEED-ARIA-VALUE-8222',
      },
      [textRecord(9504, 'SEED-ARIA-TEXT-8333')],
    );
    appendChild(
      body,
      elementRecord(9502, 'div', { id: 'autocomplete-list', role: 'listbox' }, [
        autocompleteOption,
      ]),
    );

    appendChild(
      body,
      elementRecord(
        9511,
        'input',
        {
          id: 'password-combo',
          type: 'password',
          role: 'combobox',
          'aria-owns': 'password-list',
        },
        [],
      ),
    );
    appendChild(
      body,
      elementRecord(9512, 'div', { id: 'password-list', role: 'listbox' }, [
        elementRecord(
          9513,
          'div',
          {
            id: 'password-option',
            role: 'option',
            'aria-label': 'SEED-PASSWORD-LABEL-8444',
            'aria-selected': 'true',
            value: 'SEED-PASSWORD-VALUE-8555',
          },
          [textRecord(9514, 'SEED-PASSWORD-TEXT-8666')],
        ),
      ]),
    );

    appendChild(
      body,
      elementRecord(
        9521,
        'div',
        {
          id: 'token-list',
          role: 'listbox',
          autocomplete: 'cc-exp-year',
        },
        [
          elementRecord(
            9522,
            'div',
            {
              id: 'token-option',
              role: 'option',
              'data-value': 'SEED-OWN-LABEL-8777',
            },
            [textRecord(9523, 'SEED-OWN-TEXT-8888')],
          ),
        ],
      ),
    );

    const historyCombo = findTreeNode(root, (node) =>
      hasAttribute(node, 'id', 'shadow-revealed'),
    );
    const historyComboId = numberField(historyCombo, 'backendNodeId');
    historyCombo.attributes = [
      'id',
      'history-combo',
      'type',
      'text',
      'role',
      'combobox',
      'aria-owns',
      'history-list',
    ];
    let shadowScope = parentOf(root, historyCombo);
    while (shadowScope.nodeType !== 11) {
      shadowScope = parentOf(root, shadowScope);
    }
    appendChild(
      shadowScope,
      elementRecord(9531, 'div', { id: 'history-list', role: 'listbox' }, [
        elementRecord(
          9532,
          'div',
          {
            id: 'history-option',
            role: 'option',
            'aria-label': 'SEED-HISTORY-LABEL-8999',
          },
          [textRecord(9533, 'SEED-HISTORY-TEXT-9001')],
        ),
      ]),
    );

    // A light-DOM control cannot resolve an ID in a shadow-root tree scope.
    appendChild(
      body,
      elementRecord(
        9541,
        'input',
        {
          id: 'scope-combo',
          type: 'password',
          role: 'combobox',
          'aria-controls': 'scope-list',
        },
        [],
      ),
    );
    appendChild(
      shadowScope,
      elementRecord(9542, 'div', { id: 'scope-list', role: 'listbox' }, [
        elementRecord(9543, 'div', { role: 'option' }, []),
      ]),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    expect(nodeById(model, 'autocomplete-list')).toMatchObject({
      secret: true,
      hasSecretDescendant: true,
      text: '',
    });
    expect(nodeById(model, 'password-list')).toMatchObject({
      secret: true,
      hasSecretDescendant: true,
      text: '',
    });
    expect(nodeById(model, 'token-list')).toMatchObject({
      secret: true,
      hasSecretDescendant: true,
      text: '',
    });
    const historyList = model.nodes.find(
      (node) => node.identity.backendNodeId === 9531,
    );
    expect(historyList).toMatchObject({
      secret: true,
      hasSecretDescendant: true,
      text: '',
    });
    const autocompleteOptionNode = model.nodes.find(
      (node) => node.identity.backendNodeId === 9503,
    );
    expect(autocompleteOptionNode).toMatchObject({
      secret: true,
      insideSecretSelect: true,
      isAriaOption: true,
      text: '',
      ownText: '',
      attributes: {
        id: '[redacted]',
        role: '[redacted]',
        'aria-label': '[redacted]',
        'aria-selected': '[redacted]',
        'data-value': '[redacted]',
      },
    });
    expect(autocompleteOptionNode).not.toHaveProperty('selected');
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9542),
    ).toMatchObject({ secret: false, insideSecretSelect: false });
    expect(
      model.nodes.find(
        (node) => node.identity.backendNodeId === historyComboId,
      ),
    ).toMatchObject({ secret: true });
    expect(secretSeedsIn(stored(model))).toEqual([]);

    const snapshot = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    );
    expect(secretSeedsIn(JSON.stringify(snapshot))).toEqual([]);
    const secretListRow = snapshot.inputs.find(
      (row) => model.registry.resolveRef(row.ref)?.backendNodeId === 9502,
    );
    expect(secretListRow).toMatchObject({
      optionsRedacted: true,
      optionCount: 1,
    });
    expect(
      projectInputSnapshot(
        model,
        {
          browserId: 'secrets',
          limit: 100,
          filter: { name: 'SEED-ARIA-LABEL-8111' },
        },
        PAGE,
      ).total,
    ).toBe(0);
    const inspectResults: unknown[] = [];
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      inspectResults.push(
        await projectInspect(model, node.identity, {
          enrich: () => Promise.resolve(null),
        }),
      );
    }
    expect(secretSeedsIn(JSON.stringify(inspectResults))).toEqual([]);
    const bodyNode = model.nodes.find(
      (node) => node.tagName === 'body' && !node.inShadowRoot,
    );
    expect(bodyNode).toMatchObject({ hasSecretDescendant: true, text: '' });
    expect(secretSeedsIn(JSON.stringify(model.accessibility))).toEqual([]);
  });

  it('treats a listbox inside an element a secret control names as secret', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const body = findTreeNode(
      root,
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9601,
        'input',
        {
          id: 'wrapper-card',
          type: 'text',
          autocomplete: 'cc-number',
          'aria-controls': 'card-wrapper',
        },
        [],
      ),
    );
    appendChild(
      body,
      elementRecord(9602, 'div', { id: 'card-wrapper' }, [
        elementRecord(9603, 'div', { id: 'wrapped-list', role: 'listbox' }, [
          elementRecord(
            9604,
            'div',
            { role: 'option', 'aria-disabled': 'true' },
            [textRecord(9605, 'SEED-WRAPPED-CARD-9101')],
          ),
        ]),
      ]),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    expect(nodeById(model, 'wrapped-list')).toMatchObject({
      secret: true,
      text: '',
    });
    expect(secretSeedsIn(stored(model))).toEqual([]);
  });

  it('treats a combobox as secret when the container it names is inside a secret listbox', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9611,
        'div',
        {
          id: 'cards-combo',
          role: 'combobox',
          tabindex: '0',
          'aria-controls': 'cards-wrap',
        },
        [textRecord(9612, 'Choose a card')],
      ),
    );
    appendChild(
      body,
      elementRecord(
        9613,
        'div',
        { role: 'listbox', autocomplete: 'cc-number' },
        [
          elementRecord(9614, 'div', { id: 'cards-wrap' }, [
            elementRecord(9615, 'div', { role: 'option' }, [
              textRecord(9616, 'SEED-NESTED-CARD-9102'),
            ]),
          ]),
        ],
      ),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    const combo = nodeById(model, 'cards-combo');
    if (!combo) throw new Error('Missing combobox model node.');
    expect(
      isActionTargetSecret(model, {
        identity: combo.identity,
        frameRef: combo.frameRef,
        objectId: 'combo-object',
        objectGroup: 'group',
        outOfProcess: false,
      }),
    ).toBe(true);
  });

  it('treats an editing host with a secret autocomplete token, and what is inside it, as secret', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9621,
        'div',
        {
          id: 'card-editor',
          contenteditable: 'true',
          autocomplete: 'cc-number',
        },
        [
          textRecord(9622, 'SEED-EDITOR-CARD-9103'),
          elementRecord(9623, 'span', { id: 'card-editor-child' }, []),
        ],
      ),
    );
    appendChild(
      body,
      elementRecord(
        9624,
        'div',
        { id: 'plain-editor', contenteditable: 'true' },
        [elementRecord(9625, 'span', { id: 'plain-editor-child' }, [])],
      ),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    const targetFor = (
      id: string | number,
    ): Parameters<typeof isActionTargetSecret>[1] => {
      const node =
        typeof id === 'number'
          ? model.nodes.find(
              (candidate) => candidate.identity.backendNodeId === id,
            )
          : nodeById(model, id);
      if (!node) throw new Error(`Missing ${String(id)} model node.`);
      return {
        identity: node.identity,
        frameRef: node.frameRef,
        objectId: `${String(id)}-object`,
        objectGroup: 'group',
        outOfProcess: false,
      };
    };

    expect(nodeById(model, 'card-editor')).toMatchObject({ secret: true });
    expect(isActionTargetSecret(model, targetFor('card-editor'))).toBe(true);
    // The child's own attributes are redacted with the rest of the content.
    expect(isActionTargetSecret(model, targetFor(9623))).toBe(true);
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9623),
    ).toMatchObject({
      secret: true,
      insideSecretSelect: true,
      attributes: { id: '[redacted]' },
    });
    expect(isActionTargetSecret(model, targetFor('plain-editor-child'))).toBe(
      false,
    );
    expect(secretSeedsIn(stored(model))).toEqual([]);
  });

  it.each([
    ['card-editor', 9632],
    ['card-editor-child', 9634],
    ['card-editor-wrap', 9631],
  ])(
    'does not read the live page to inspect %s, a secret editing host or a node around it',
    async (_name, backendNodeId) => {
      const recording = cloneRecording(loadRecording('shadow'));
      const body = findTreeNode(
        treeRoot(recording),
        (node) => node.nodeType === 1 && node.localName === 'body',
      );
      appendChild(
        body,
        elementRecord(9631, 'section', { id: 'card-editor-wrap' }, [
          elementRecord(
            9632,
            'div',
            {
              id: 'card-editor',
              contenteditable: 'true',
              autocomplete: 'cc-number',
            },
            [
              textRecord(9633, 'SEED-EDITOR-CARD-9103'),
              elementRecord(9634, 'span', { id: 'card-editor-child' }, [
                textRecord(9635, 'SEED-EDITOR-CHILD-9104'),
              ]),
            ],
          ),
        ]),
      );
      const model = await buildPageModel(
        recordedDeps(recording, { readStyles: visibleStyles }),
        { accessibility: true },
      );
      // The preload redacts form controls only, so its markup of an editing
      // host holds the host's text.
      const enrich = jest.fn(() =>
        Promise.resolve({
          locatorCandidates: [],
          domPath: ['html', 'body'],
          outerHtml: '<div>SEED-EDITOR-CARD-9103 SEED-EDITOR-CHILD-9104</div>',
        }),
      );

      const node = model.nodes.find(
        (candidate) => candidate.identity.backendNodeId === backendNodeId,
      );
      if (!node) throw new Error('Missing model node.');
      const inspected = await projectInspect(model, node.identity, {
        allowSensitiveEnrichment: true,
        enrich,
      });

      expect(inspected).toBeDefined();
      expect(enrich).not.toHaveBeenCalled();
      expect(secretSeedsIn(JSON.stringify(inspected))).toEqual([]);
    },
  );

  it('redacts controls and lists inside a secret editing host, and leaves those in a plain editor alone', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    const controls = (
      base: number,
      values: { option: string; listed: string; typed: string; data: string },
    ): ReturnType<typeof elementRecord>[] => [
      elementRecord(base + 1, 'select', {}, [
        elementRecord(
          base + 2,
          'option',
          { value: values.option, selected: '' },
          [textRecord(base + 3, values.option)],
        ),
      ]),
      elementRecord(base + 4, 'div', { role: 'listbox', tabindex: '0' }, [
        elementRecord(
          base + 5,
          'div',
          { role: 'option', 'data-value': values.listed },
          [textRecord(base + 6, 'Card')],
        ),
      ]),
      elementRecord(
        base + 7,
        'input',
        { type: 'text', value: values.typed },
        [],
      ),
      elementRecord(
        base + 8,
        'button',
        { type: 'button', value: values.data, 'data-card': values.data },
        [textRecord(base + 9, values.data)],
      ),
    ];
    appendChild(
      body,
      elementRecord(
        9640,
        'div',
        { contenteditable: 'true', autocomplete: 'cc-number' },
        controls(9640, {
          option: 'SEED-NESTED-OPTION-9201',
          listed: 'SEED-NESTED-LISTED-9202',
          typed: 'SEED-NESTED-TYPED-9203',
          data: 'SEED-NESTED-DATA-9204',
        }),
      ),
    );
    appendChild(
      body,
      elementRecord(
        9660,
        'div',
        { contenteditable: 'true' },
        controls(9660, {
          option: 'PLAIN-NESTED-OPTION',
          listed: 'PLAIN-NESTED-LISTED',
          typed: 'PLAIN-NESTED-TYPED',
          data: 'PLAIN-NESTED-DATA',
        }),
      ),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    const byBackendId = (backendNodeId: number): PageModelNode => {
      const node = model.nodes.find(
        (candidate) => candidate.identity.backendNodeId === backendNodeId,
      );
      if (!node) throw new Error(`Missing node ${String(backendNodeId)}`);
      return node;
    };

    expect(secretSeedsIn(stored(model))).toEqual([]);
    for (const backendNodeId of [9641, 9642, 9644, 9645, 9647, 9648]) {
      const node = byBackendId(backendNodeId);
      expect(node).toMatchObject({ secret: true, insideSecretSelect: true });
      expect(
        isActionTargetSecret(model, {
          identity: node.identity,
          frameRef: node.frameRef,
          objectId: 'nested-object',
          objectGroup: 'group',
          outOfProcess: false,
        }),
      ).toBe(true);
      const enrich = jest.fn(() => Promise.resolve(null));
      const inspected = await projectInspect(model, node.identity, {
        allowSensitiveEnrichment: true,
        enrich,
      });
      expect(enrich).not.toHaveBeenCalled();
      expect(secretSeedsIn(JSON.stringify(inspected))).toEqual([]);
    }

    const snapshot = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    );
    const sent = JSON.stringify(snapshot);
    expect(secretSeedsIn(sent)).toEqual([]);
    const rowFor = (backendNodeId: number): unknown =>
      snapshot.inputs.find(
        (row) =>
          model.registry.resolveRef(row.ref)?.backendNodeId === backendNodeId,
      );
    expect(rowFor(9641)).toMatchObject({
      valueRedacted: true,
      optionsRedacted: true,
      optionCount: 1,
    });
    expect(rowFor(9647)).toMatchObject({ valueRedacted: true });
    // A nested row says what tag it is and where; nothing is read from its
    // attributes, which are all redacted.
    for (const backendNodeId of [9641, 9644, 9647, 9648]) {
      const row = rowFor(backendNodeId);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        role: undefined,
        name: undefined,
        text: undefined,
      });
      expect(row).not.toHaveProperty('options');
      expect(row).not.toHaveProperty('editable');
    }

    // The same controls in an editor that is not secret keep their values.
    expect(byBackendId(9661)).toMatchObject({
      secret: false,
      insideSecretSelect: false,
    });
    expect(rowFor(9661)).toMatchObject({
      options: [{ value: 'PLAIN-NESTED-OPTION' }],
    });
    expect(rowFor(9664)).toMatchObject({
      options: [{ value: 'PLAIN-NESTED-LISTED' }],
    });
    expect(sent).toContain('PLAIN-NESTED-DATA');
  });

  it('redacts what is nested inside a secret ARIA combobox that is not a form control', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9680,
        'div',
        { role: 'combobox', autocomplete: 'cc-number', tabindex: '0' },
        [
          elementRecord(9681, 'select', {}, [
            elementRecord(
              9682,
              'option',
              { value: 'SEED-COMBO-OPTION-9301', selected: '' },
              [textRecord(9683, 'SEED-COMBO-LABEL-9302')],
            ),
          ]),
          elementRecord(
            9684,
            'button',
            { type: 'button', 'data-card': 'SEED-COMBO-DATA-9303' },
            [textRecord(9685, 'Clear')],
          ),
        ],
      ),
    );

    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );

    expect(secretSeedsIn(stored(model))).toEqual([]);
    for (const backendNodeId of [9681, 9682, 9684]) {
      expect(
        model.nodes.find(
          (node) => node.identity.backendNodeId === backendNodeId,
        ),
      ).toMatchObject({ secret: true, insideSecretSelect: true });
    }
    expect(
      secretSeedsIn(
        JSON.stringify(
          projectInputSnapshot(
            model,
            { browserId: 'secrets', limit: 100 },
            PAGE,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('inspect withholds the role and name a snapshot row withholds inside a secret element', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9690,
        'div',
        { role: 'combobox', autocomplete: 'cc-number', tabindex: '0' },
        [
          elementRecord(9691, 'select', { 'aria-label': 'Card type' }, [
            elementRecord(9692, 'option', { value: 'visa', selected: '' }, [
              textRecord(9693, 'Visa'),
            ]),
          ]),
          elementRecord(9694, 'button', { type: 'button' }, [
            textRecord(9695, 'Clear'),
          ]),
        ],
      ),
    );
    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
      { accessibility: true },
    );
    const rows = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs;
    let compared = 0;
    for (const backendNodeId of [9691, 9692, 9694]) {
      const node = model.nodes.find(
        (candidate) => candidate.identity.backendNodeId === backendNodeId,
      );
      if (!node) throw new Error(`Missing node ${backendNodeId}`);
      const row = rows.find(
        (candidate) => candidate.ref === model.registry.mintRef(node.identity),
      );
      if (!row) continue;
      compared += 1;
      const inspected = await projectInspect(model, node.identity, {
        enrich: () => Promise.resolve(null),
      });
      // Inspect withholds at least what the row does.
      expect({
        node: backendNodeId,
        role: inspected?.role,
        name: inspected?.accessibleName,
      }).toEqual({ node: backendNodeId, role: row.role, name: row.name });
    }
    expect(compared).toBeGreaterThanOrEqual(2);
  });

  it('links lists from a non-native ARIA combobox with explicit secret autocomplete', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const body = findTreeNode(
      treeRoot(recording),
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(
        9581,
        'div',
        {
          id: 'aria-combobox',
          role: 'combobox',
          autocomplete: 'cc-number',
          'aria-controls': 'aria-combobox-list',
        },
        [],
      ),
    );
    appendChild(
      body,
      elementRecord(
        9582,
        'div',
        { id: 'aria-combobox-list', role: 'listbox' },
        [
          elementRecord(
            9583,
            'div',
            { role: 'option', 'data-value': 'SEED-ARIA-COMBO-VALUE-9333' },
            [textRecord(9584, 'SEED-ARIA-COMBO-TEXT-9444')],
          ),
        ],
      ),
    );

    const model = await buildPageModel(recordedDeps(recording));
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9581),
    ).toMatchObject({ secret: true });
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9582),
    ).toMatchObject({ secret: true, hasSecretDescendant: true });
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9583),
    ).toMatchObject({
      secret: true,
      insideSecretSelect: true,
      isAriaOption: true,
      text: '',
      attributes: {
        role: '[redacted]',
        'data-value': '[redacted]',
      },
    });
    expect(secretSeedsIn(stored(model))).toEqual([]);
  });

  it('withholds secret ARIA combobox text from unrelated ancestors and inspect', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const body = findTreeNode(
      root,
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      body,
      elementRecord(9585, 'section', { id: 'combo-wrapper' }, [
        elementRecord(
          9586,
          'div',
          {
            id: 'text-combo',
            role: 'combobox',
            autocomplete: 'cc-number',
            'aria-controls': 'text-combo-list',
          },
          [textRecord(9587, 'SEED-ARIA-COMBO-ANCESTOR-9555')],
        ),
      ]),
    );
    // Keep the named list outside the wrapper to isolate descendant handling.
    appendChild(
      body,
      elementRecord(9588, 'div', { id: 'text-combo-list', role: 'listbox' }, [
        elementRecord(9589, 'div', { role: 'option' }, []),
      ]),
    );
    const shadowScope = findTreeNode(root, (node) => node.nodeType === 11);
    appendChild(
      shadowScope,
      elementRecord(9590, 'label', { id: 'combo-label' }, [
        elementRecord(
          9591,
          'div',
          {
            role: 'combobox',
            autocomplete: 'cc-number',
            'aria-controls': 'label-combo-list',
          },
          [textRecord(9592, 'SEED-ARIA-COMBO-LABEL-9666')],
        ),
      ]),
    );
    appendChild(
      shadowScope,
      elementRecord(9593, 'div', { id: 'label-combo-list', role: 'listbox' }, [
        elementRecord(9594, 'div', { role: 'option' }, []),
      ]),
    );

    const model = await buildPageModel(recordedDeps(recording));
    const wrapper = nodeById(model, 'combo-wrapper');
    expect(wrapper).toMatchObject({ hasSecretDescendant: true, text: '' });
    const label = nodeById(model, 'combo-label');
    expect(label).toMatchObject({
      text: '',
      labelText: '',
      nameText: '',
      ownText: '',
    });
    expect(secretSeedsIn(stored(model))).toEqual([]);
    const inspected = await projectInspect(model, wrapper.identity, {
      enrich: () => Promise.resolve(null),
    });
    expect(secretSeedsIn(JSON.stringify(inspected))).toEqual([]);
    const inspectedLabel = await projectInspect(model, label.identity, {
      enrich: () => Promise.resolve(null),
    });
    expect(secretSeedsIn(JSON.stringify(inspectedLabel))).toEqual([]);
  });

  it('does not resolve secret list IDs across frame documents', async () => {
    const recording = cloneRecording(loadRecording('frames'));
    const mainRoot = treeRoot(recording);
    const mainBody = findTreeNode(
      mainRoot,
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      mainBody,
      elementRecord(
        9551,
        'input',
        {
          id: 'frame-combo',
          type: 'password',
          role: 'combobox',
          'aria-controls': 'frame-list',
        },
        [],
      ),
    );
    const childOwner = findTreeNode(
      mainRoot,
      (node) => node.nodeType === 1 && hasAttribute(node, 'id', 'framed'),
    );
    const childDocument = childOwner.contentDocument;
    if (!isJsonRecord(childDocument)) throw new Error('Missing child frame');
    const childBody = findTreeNode(
      childDocument,
      (node) => node.nodeType === 1 && node.localName === 'body',
    );
    appendChild(
      childBody,
      elementRecord(9552, 'div', { id: 'frame-list', role: 'listbox' }, [
        elementRecord(
          9553,
          'div',
          { role: 'option', 'data-value': 'SEED-FRAME-OPTION-9111' },
          [textRecord(9554, 'SEED-FRAME-TEXT-9222')],
        ),
      ]),
    );
    const model = await buildPageModel(recordedDeps(recording));
    const childListbox = model.nodes.find(
      (node) => node.identity.backendNodeId === 9552,
    );
    expect(childListbox).toMatchObject({
      secret: false,
      text: 'SEED-FRAME-TEXT-9222',
    });
    expect(
      model.nodes.find((node) => node.identity.backendNodeId === 9553),
    ).toMatchObject({
      secret: false,
      insideSecretSelect: false,
      text: 'SEED-FRAME-TEXT-9222',
      attributes: { 'data-value': 'SEED-FRAME-OPTION-9111' },
    });
  });

  it('projects selected only for nonsecret native options with snapshot state', async () => {
    const recording = cloneRecording(loadRecording('form-controls'));
    const response = recording.responses.find(
      (entry) => entry.method === 'DOMSnapshot.captureSnapshot',
    );
    if (!response) throw new Error('Missing recorded DOM snapshot');
    const decoded = decodeDOMSnapshot(response.response);
    if (!decoded) throw new Error('Cannot decode recorded DOM snapshot');
    const selectedEntry = Array.from(decoded.nodes.entries()).find(
      ([, info]) => info.optionSelected,
    );
    if (!selectedEntry) throw new Error('Missing selected native option');

    const model = await buildPageModel(recordedDeps(recording));
    const selectedOption = model.nodes.find(
      (node) => node.identity.backendNodeId === selectedEntry[0],
    );
    expect(selectedOption).toMatchObject({
      tagName: 'option',
      secret: false,
      insideSecretSelect: false,
      selected: true,
    });

    const secretModel = await buildPageModel(
      recordedDeps(loadRecording('secrets')),
    );
    const secretOptions = secretModel.nodes.filter(
      (node) => node.tagName === 'option' && node.insideSecretSelect,
    );
    expect(secretOptions.length).toBeGreaterThan(0);
    for (const option of secretOptions) {
      expect(option).not.toHaveProperty('selected');
    }

    const staleRecording = cloneRecording(recording);
    const selectedTreeNode = findTreeNode(
      treeRoot(staleRecording),
      (node) => node.nodeType === 1 && node.backendNodeId === selectedEntry[0],
    );
    selectedTreeNode.nodeId = 9591;
    selectedTreeNode.backendNodeId = 9591;
    const staleModel = await buildPageModel(recordedDeps(staleRecording));
    const staleOption = staleModel.nodes.find(
      (node) => node.identity.backendNodeId === 9591,
    );
    expect(staleOption).not.toHaveProperty('selected');
  });
});

describe('review M2 redaction cases', () => {
  const visibleStyles: NonNullable<ReplayOptions['readStyles']> = (
    _frameId,
    _sessionId,
    ids,
  ) =>
    Promise.resolve(
      ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
    );

  async function inspectAll(model: BrowserPageModel): Promise<string> {
    const results: unknown[] = [];
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      results.push(
        await projectInspect(model, node.identity, {
          enrich: () => Promise.resolve(null),
        }),
      );
    }
    return JSON.stringify(results);
  }

  function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
    const node = model.nodes.find(
      (candidate) => candidate.attributes.id === id,
    );
    if (!node) throw new Error(`Missing #${id}`);
    return node;
  }

  it('suppresses all text inside a shadow label that wraps a control, nested elements and labelledby included (blocker 1)', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const revealed = findTreeNode(root, (node) =>
      hasAttribute(node, 'id', 'shadow-revealed'),
    );
    const label = parentOf(root, revealed);
    const mirror = childList(label).find((node) => node.nodeType === 3);
    if (!mirror) throw new Error('Missing mirrored text');
    // <label><b id=mirror tabindex=0>Saved password: SEED…</b><input></label>
    replaceChild(
      label,
      mirror,
      elementRecord(9001, 'b', { id: 'mirror', tabindex: '0' }, [mirror]),
    );
    const shadowRoot = parentOf(root, label);
    appendChild(
      shadowRoot,
      elementRecord(
        9002,
        'button',
        { id: 'mirror-labelled', 'aria-labelledby': 'mirror' },
        [textRecord(9003, 'Reveal')],
      ),
    );
    // Text outside such a label stays ordinary page text.
    appendChild(
      shadowRoot,
      elementRecord(9004, 'div', { id: 'plain-wrapper' }, [
        textRecord(9005, 'Ordinary wrapper text'),
        elementRecord(9006, 'input', { id: 'wrapped-plain' }, []),
      ]),
    );
    appendChild(
      shadowRoot,
      elementRecord(
        9007,
        'button',
        { id: 'plain-labelled', 'aria-labelledby': 'plain-wrapper' },
        [textRecord(9008, 'Go')],
      ),
    );
    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
    );
    expect(secretSeedsIn(stored(model))).toEqual([]);
    const snapshot = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    );
    expect(secretSeedsIn(JSON.stringify(snapshot))).toEqual([]);
    expect(secretSeedsIn(await inspectAll(model))).toEqual([]);
    expect(nodeWithId(model, 'mirror')).toMatchObject({
      text: '',
      labelText: '',
      nameText: '',
      ownText: '',
    });
    const rowsById = (id: string): unknown =>
      snapshot.inputs.find((row) => {
        const identity = model.registry.resolveRef(row.ref);
        return (
          identity?.backendNodeId ===
          nodeWithId(model, id).identity.backendNodeId
        );
      });
    expect(rowsById('mirror')).toMatchObject({ tagName: 'b' });
    expect(rowsById('mirror-labelled')).toMatchObject({ name: 'Reveal' });
    // The boundary: a non-label element containing a control keeps its text.
    expect(rowsById('plain-labelled')).toMatchObject({
      name: 'Ordinary wrapper text',
    });
    // Button text and for= labels keep working in conservative scopes.
    expect(rowsById('shadow-button')).toMatchObject({ name: 'Open action' });
    expect(rowsById('note')).toMatchObject({ name: 'Note' });
  });

  it('suppresses text inside a child-frame label that wraps a control (blocker 1)', async () => {
    const recording = cloneRecording(loadRecording('frames'));
    const root = treeRoot(recording);
    const input = findTreeNode(root, (node) =>
      hasAttribute(node, 'id', 'frame-name'),
    );
    const parent = parentOf(root, input);
    replaceChild(
      parent,
      input,
      elementRecord(9101, 'label', { id: 'frame-wrap' }, [
        elementRecord(9102, 'i', { tabindex: '0', id: 'frame-mirror' }, [
          textRecord(9103, 'Mirror SEED-FRAME-MIRROR-1212'),
        ]),
        input,
      ]),
    );
    const model = await buildPageModel(
      recordedDeps(recording, { readStyles: visibleStyles }),
    );
    expect(secretSeedsIn(stored(model))).toEqual([]);
    expect(
      secretSeedsIn(
        JSON.stringify(
          projectInputSnapshot(
            model,
            { browserId: 'secrets', limit: 100 },
            PAGE,
          ),
        ),
      ),
    ).toEqual([]);
    expect(secretSeedsIn(await inspectAll(model))).toEqual([]);
    // Text outside the label in the same frame is ordinary page text.
    expect(nodeWithId(model, 'frame-button').text).toBe('Frame action');
  });

  it('classifies with the snapshot attributes when the page changed after DOM.getDocument (blocker 2)', async () => {
    const recording = cloneRecording(loadRecording('form-controls'));
    const root = treeRoot(recording);
    const email = numberField(
      findTreeNode(root, (node) => hasAttribute(node, 'id', 'email')),
      'backendNodeId',
    );
    const fullName = numberField(
      findTreeNode(root, (node) => hasAttribute(node, 'id', 'full-name')),
      'backendNodeId',
    );
    const snapshot = snapshotEditor(recording);
    snapshot.addAttribute(email, 'autocomplete', 'one-time-code');
    snapshot.setRareString('inputValue', email, 'SEED-OTP-LIVE-5522');
    snapshot.addAttribute(fullName, 'type', 'password');
    snapshot.setRareString('inputValue', fullName, 'SEED-PW-LIVE-4418');
    const model = await buildPageModel(recordedDeps(recording));
    expect(nodeWithId(model, 'email')).toMatchObject({ secret: true });
    expect(nodeWithId(model, 'full-name')).toMatchObject({ secret: true });
    expect(secretSeedsIn(stored(model))).toEqual([]);
    const rows = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs;
    expect(secretSeedsIn(JSON.stringify(rows))).toEqual([]);
    expect(rows.filter((row) => row.valueRedacted)).toHaveLength(2);
    expect(secretSeedsIn(await inspectAll(model))).toEqual([]);
  });

  it('withholds every form-control value when the page never held still (blocker 2)', async () => {
    const recording = loadRecording('form-controls');
    let revision = 0;
    const result = await buildConsistentModel(
      () => ({
        domEventRevision: revision,
        navigationSequence: 0,
        actionSequence: 0,
      }),
      async () => {
        revision += 1;
        return buildPageModelWithFallback(recordedDeps(recording));
      },
    );
    expect(result.consistent).toBe(false);
    const controls = result.model.nodes.filter((node) =>
      ['input', 'textarea', 'select'].includes(node.tagName),
    );
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) {
      expect(control.value).toBeUndefined();
      expect(control.secret).toBe(true);
    }
    const rows = projectInputSnapshot(
      result.model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs;
    expect(rows.find((row) => row.tagName === 'textarea')).toMatchObject({
      valueRedacted: true,
    });
    expect(JSON.stringify(rows)).not.toContain('live@example.test');
  });

  it('reports a select value as unknown when an option has no snapshot entry (minor 5)', async () => {
    const recording = cloneRecording(loadRecording('form-controls'));
    const root = treeRoot(recording);
    const select = findTreeNode(root, (node) =>
      hasAttribute(node, 'id', 'color'),
    );
    // The options were replaced between DOM.getDocument and the snapshot.
    let nextId = 9201;
    const renumber = (node: Record<string, unknown>): void => {
      node.nodeId = nextId;
      node.backendNodeId = nextId;
      nextId += 1;
      for (const child of childList(node)) renumber(child);
    };
    for (const option of childList(select)) renumber(option);
    const model = await buildPageModel(recordedDeps(recording));
    expect(nodeWithId(model, 'color')).toMatchObject({ valueUnknown: true });
    expect(nodeWithId(model, 'color').value).toBeUndefined();
    const row = projectInputSnapshot(
      model,
      { browserId: 'secrets', limit: 100 },
      PAGE,
    ).inputs.find((item) => item.tagName === 'select');
    expect(row).toMatchObject({ valueRedacted: true });
    expect(row?.value).toBeUndefined();
  });
});

describe('changing-page fallback (PR #4917 finding 2)', () => {
  /**
   * Every form value the recording carries: live input and textarea values
   * from the snapshot, default `value` attributes, textarea text, and each
   * option's value and text. Values under three characters are skipped:
   * they also occur as ordinary substrings of the JSON.
   */
  function formValues(recording: Recording): string[] {
    const values = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const trimmed = value.replace(/\s+/g, ' ').trim();
      if (trimmed.length >= 3) values.add(trimmed);
    };
    const textOf = (node: Record<string, unknown>): string =>
      childList(node)
        .map((child) =>
          child.nodeType === 3 ? String(child.nodeValue) : textOf(child),
        )
        .join('');
    const attribute = (
      node: Record<string, unknown>,
      name: string,
    ): unknown => {
      const list = node.attributes;
      if (!Array.isArray(list)) return undefined;
      const index = list.indexOf(name);
      return index >= 0 && index % 2 === 0 ? list[index + 1] : undefined;
    };
    for (const entry of recording.responses) {
      if (entry.method === 'DOMSnapshot.captureSnapshot') {
        const snapshot = decodeDOMSnapshot(entry.response);
        for (const info of Array.from(snapshot?.nodes.values() ?? [])) {
          add(info.inputValue);
          add(info.textValue);
        }
      }
      if (entry.method !== 'DOM.getDocument') continue;
      const pending = [treeRoot(recording, entry.sessionId)];
      while (pending.length > 0) {
        const node = pending.pop();
        if (!node) break;
        const tag = typeof node.localName === 'string' ? node.localName : '';
        if (tag === 'input') add(attribute(node, 'value'));
        if (tag === 'textarea') add(textOf(node));
        if (tag === 'option') {
          add(attribute(node, 'value'));
          add(textOf(node));
        }
        pending.push(...childList(node), ...childList(node, 'shadowRoots'));
        const content = node.contentDocument;
        if (
          typeof content === 'object' &&
          content !== null &&
          !Array.isArray(content)
        ) {
          pending.push(Object.fromEntries(Object.entries(content)));
        }
      }
    }
    return Array.from(values);
  }

  /**
   * A value at letter boundaries, so `red` does not match `[redacted]` or
   * `valueRedacted`.
   */
  function containsValue(serialized: string, value: string): boolean {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`).test(serialized);
  }

  async function inconsistentBuild(name: string): Promise<BrowserPageModel> {
    const recording = loadRecording(name);
    let revision = 0;
    const result = await buildConsistentModel(
      () => ({
        domEventRevision: revision,
        navigationSequence: 0,
        actionSequence: 0,
      }),
      async () => {
        revision += 1;
        return buildPageModelWithFallback(recordedDeps(recording));
      },
    );
    expect(result.consistent).toBe(false);
    return result.model;
  }

  async function serializedOutputs(model: BrowserPageModel): Promise<string> {
    const outputs: unknown[] = [
      projectInputSnapshot(model, { browserId: 'secrets', limit: 100 }, PAGE),
    ];
    for (const node of model.nodes) {
      if (node.nodeType !== 1) continue;
      outputs.push(
        await projectInspect(model, node.identity, {
          enrich: () => Promise.resolve(null),
        }),
      );
    }
    return JSON.stringify(outputs);
  }

  it.each(['form-controls', 'secrets'])(
    '%s: an inconsistent build exposes no form value in rows, text, attributes or markup',
    async (name) => {
      const recording = loadRecording(name);
      const values = formValues(recording);
      expect(values.length).toBeGreaterThan(5);
      // The consistent model shows ordinary values, so the search is live.
      const consistent = await serializedOutputs(
        await buildPageModel(recordedDeps(recording)),
      );
      expect(values.some((value) => containsValue(consistent, value))).toBe(
        true,
      );
      const serialized = await serializedOutputs(await inconsistentBuild(name));
      expect(
        values.filter((value) => containsValue(serialized, value)),
      ).toEqual([]);
    },
  );
});
