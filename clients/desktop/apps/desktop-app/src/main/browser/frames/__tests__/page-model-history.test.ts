import type {
  BrowserPageModel,
  PageModelDeps,
  PageModelNode,
} from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot, projectInspect } from '../projections';
import type { ControlHistory } from '../trackers';
import {
  loadRecording,
  recordedDeps,
  recordedRegistry,
  type Recording,
} from './fixtures/recorded-cdp';
import {
  appendChild,
  childList,
  cloneRecording,
  elementRecord,
  findTreeNode,
  hasAttribute,
  numberField,
  parentOf,
  snapshotEditor,
  textRecord,
  treeRoot,
  type JsonRecord,
} from './fixtures/recording-edit';

const PAGE = { browserId: 'history', url: '', title: '' };

/** Nodes added to a recording have no layout box; report them visible. */
const visibleStyles: NonNullable<PageModelDeps['readStyles']> = (
  _frameId,
  _sessionId,
  ids,
) =>
  Promise.resolve(
    ids.map(() => ({ display: 'inline-block', visibility: 'visible' })),
  );

/** Explicitly available preload holder for synthetic main-frame shadow inputs. */
function availablePreload(
  recording: Recording,
): PageModelDeps['isPasswordEverSeen'] {
  const original = recordedDeps(recording);
  return (frameId, sessionId, ids, purpose) =>
    purpose === 'remembered'
      ? Promise.resolve(ids.map(() => false))
      : original.isPasswordEverSeen(frameId, sessionId, ids);
}

interface HistoryCall {
  frameId: string;
  sessionId: string;
  scope: 'light' | 'shadow';
  backendNodeIds: number[];
}

type Answer = (call: HistoryCall) => Promise<ControlHistory[]>;

function bridge(answer: Answer): {
  controlHistory: NonNullable<PageModelDeps['controlHistory']>;
  calls: HistoryCall[];
} {
  const calls: HistoryCall[] = [];
  return {
    calls,
    controlHistory: (
      frameId,
      sessionId,
      scope,
      backendNodeIds,
    ): Promise<ControlHistory[]> => {
      const call = { frameId, sessionId, scope, backendNodeIds };
      calls.push(call);
      return answer(call);
    },
  };
}

/** Answers per input id, looked up in the recording's trees. */
function answersById(
  recording: Recording,
  byId: Record<string, ControlHistory>,
): Answer {
  const ids = new Map<string, ControlHistory>();
  for (const [id, status] of Object.entries(byId)) {
    for (const entry of recording.responses) {
      if (entry.method !== 'DOM.getDocument') continue;
      try {
        const node = findTreeNode(treeRoot(recording, entry.sessionId), (n) =>
          hasAttribute(n, 'id', id),
        );
        ids.set(
          `${entry.sessionId}\u0000${numberField(node, 'backendNodeId')}`,
          status,
        );
      } catch {
        // Not in this session.
      }
    }
  }
  return (call) =>
    Promise.resolve(
      call.backendNodeIds.map(
        (backendNodeId) =>
          ids.get(`${call.sessionId}\u0000${backendNodeId}`) ?? 'unknown',
      ),
    );
}

function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

function idsOf(model: BrowserPageModel, call: HistoryCall): string[] {
  return call.backendNodeIds.map(
    (backendNodeId) =>
      model.nodes.find(
        (node) =>
          node.identity.sessionId === call.sessionId &&
          node.identity.backendNodeId === backendNodeId,
      )?.attributes.id ?? `?${backendNodeId}`,
  );
}

function rows(
  model: BrowserPageModel,
): Map<string, ReturnType<typeof projectInputSnapshot>['inputs'][number]> {
  const byId = new Map<
    string,
    ReturnType<typeof projectInputSnapshot>['inputs'][number]
  >();
  for (const row of projectInputSnapshot(
    model,
    { browserId: 'history', limit: 100 },
    PAGE,
  ).inputs) {
    const identity = model.registry.resolveRef(row.ref);
    const node = model.nodes.find(
      (candidate) =>
        identity !== undefined &&
        candidate.identity.sessionId === identity.sessionId &&
        candidate.identity.backendNodeId === identity.backendNodeId,
    );
    byId.set(node?.attributes.id ?? row.ref, row);
  }
  return byId;
}

async function everyOutput(model: BrowserPageModel): Promise<string> {
  const outputs: unknown[] = [
    projectInputSnapshot(model, { browserId: 'history', limit: 100 }, PAGE),
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

describe('document-start tracking: which controls are asked about (D6)', () => {
  it('asks the main-world tracker about shadow-root inputs that can leak, in document order', async () => {
    const recording = loadRecording('shadow');
    const { controlHistory, calls } = bridge(answersById(recording, {}));
    const model = await buildPageModel(
      recordedDeps(recording, { controlHistory }),
    );
    expect(calls.map((call) => [call.scope, idsOf(model, call)])).toEqual([
      ['shadow', ['note', 'shadow-revealed', 'closed-input']],
    ]);
    expect(calls[0]?.frameId).toBe(model.frames[0]?.frameId);
    expect(model.trackerHistory).toMatchObject({
      queried: 3,
      never: 0,
      was: 0,
    });
  });

  it('asks the isolated-world tracker about child-frame light DOM, in each frame session', async () => {
    for (const [name, expected] of [
      ['frames', [['light', ['frame-name']]]],
      ['oopif', [['light', ['child-name']]]],
    ] as const) {
      const recording = loadRecording(name);
      const { controlHistory, calls } = bridge(answersById(recording, {}));
      const model = await buildPageModel(
        recordedDeps(recording, { controlHistory }),
      );
      expect(calls.map((call) => [call.scope, idsOf(model, call)])).toEqual(
        expected,
      );
      const frame = model.frames.find(
        (candidate) => candidate.frameId === calls[0]?.frameId,
      );
      expect(frame?.parentFrameId).toBeDefined();
      expect(frame?.sessionId).toBe(calls[0]?.sessionId);
    }
  });

  it('does not ask about an input with nothing to leak, and shows its empty value', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const closed = findTreeNode(root, (node) =>
      hasAttribute(node, 'id', 'closed-input'),
    );
    closed.attributes = ['id', 'closed-input', 'aria-label', 'Closed field'];
    snapshotEditor(recording).setRareString(
      'inputValue',
      numberField(closed, 'backendNodeId'),
      '',
    );
    const { controlHistory, calls } = bridge(answersById(recording, {}));
    const model = await buildPageModel(
      recordedDeps(recording, { controlHistory }),
    );
    expect(calls.flatMap((call) => idsOf(model, call))).not.toContain(
      'closed-input',
    );
    expect(rows(model).get('closed-input')).toMatchObject({
      name: 'Closed field',
      value: '',
    });
    expect(rows(model).get('closed-input')?.valueRedacted).toBeUndefined();
  });

  it('asks about at most 200 inputs per build; the rest stay unknown', async () => {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const note = findTreeNode(root, (node) => hasAttribute(node, 'id', 'note'));
    const shadowRoot = parentOf(root, note);
    for (let index = 0; index < 250; index += 1) {
      appendChild(
        shadowRoot,
        elementRecord(9_500 + index, 'input', { id: `bulk-${index}` }, []),
      );
    }
    const { controlHistory, calls } = bridge((call) =>
      Promise.resolve(call.backendNodeIds.map((): ControlHistory => 'never')),
    );
    const model = await buildPageModel(
      recordedDeps(recording, {
        controlHistory,
        isPasswordEverSeen: availablePreload(recording),
      }),
    );
    const asked = calls.flatMap((call) => call.backendNodeIds);
    expect(asked).toHaveLength(200);
    expect(model.trackerHistory).toMatchObject({ queried: 200, never: 200 });
    // The first 200 in document order were answered; the last are unknown.
    expect(nodeWithId(model, 'note').secret).toBe(false);
    expect(nodeWithId(model, 'bulk-249').secret).toBe(true);
  });
});

describe('document-start tracking narrows the conservative rule', () => {
  it('keeps every shadow and child-frame input with a value withheld without a tracker', async () => {
    for (const name of ['shadow', 'frames', 'oopif']) {
      const model = await buildPageModel(recordedDeps(loadRecording(name)));
      const conservative = model.nodes.filter(
        (node) =>
          node.tagName === 'input' &&
          (node.inShadowRoot ||
            model.frames.find((frame) => frame.frameRef === node.frameRef)
              ?.parentFrameId !== undefined),
      );
      expect(conservative.length).toBeGreaterThan(0);
      for (const input of conservative) expect(input.secret).toBe(true);
    }
  });

  it('exposes a tracked never-password input like a main-frame input', async () => {
    const recording = loadRecording('shadow');
    const { controlHistory } = bridge(
      answersById(recording, {
        note: 'never',
        'closed-input': 'never',
        'shadow-revealed': 'was',
      }),
    );
    const model = await buildPageModel(
      recordedDeps(recording, {
        controlHistory,
        isPasswordEverSeen: availablePreload(recording),
      }),
    );
    const byId = rows(model);
    expect(byId.get('note')).toMatchObject({
      name: 'Note',
      value: 'SEED-SHADOW-OPEN-1188',
    });
    expect(byId.get('closed-input')).toMatchObject({
      value: 'SEED-SHADOW-CLOSED-2299',
    });
    expect(byId.get('shadow-revealed')).toMatchObject({ valueRedacted: true });
    expect(model.trackerHistory).toMatchObject({ never: 2, was: 1 });
  });

  it('withholds a revealed password and the label text around it with tracking confirmed (pins the label rule)', async () => {
    const recording = loadRecording('shadow');
    const { controlHistory } = bridge(
      answersById(recording, {
        note: 'never',
        'closed-input': 'never',
        'shadow-revealed': 'was',
      }),
    );
    const model = await buildPageModel(
      recordedDeps(recording, { controlHistory }),
    );
    // The page mirrors the revealed value into the wrapping label's text.
    // The preload's rule would expose it; a label around a control that is
    // or was secret exposes no text in a shadow root or child frame.
    const serialized = await everyOutput(model);
    expect(serialized).not.toContain('SEED-SHADOW-LABEL-5150');
    const revealed = nodeWithId(model, 'shadow-revealed');
    expect(model.nodes[revealed.parentIndex ?? -1]).toMatchObject({
      tagName: 'label',
      text: '',
      labelText: '',
    });
    expect(rows(model).get('shadow-revealed')?.name).toBeUndefined();
  });

  it('exposes child-frame values the tracker never saw as passwords, in both frame kinds', async () => {
    for (const [name, id, value] of [
      ['frames', 'frame-name', 'SEED-FRAME-3377'],
      ['oopif', 'child-name', 'SEED-OOPIF-4466'],
    ] as const) {
      const recording = loadRecording(name);
      const never = bridge(answersById(recording, { [id]: 'never' }));
      const exposed = await buildPageModel(
        recordedDeps(recording, {
          controlHistory: never.controlHistory,
          controlHistorySummary: () => Promise.resolve('none'),
        }),
      );
      expect(rows(exposed).get(id)).toMatchObject({ value });
      const was = bridge(answersById(recording, { [id]: 'was' }));
      const withheld = await buildPageModel(
        recordedDeps(recording, { controlHistory: was.controlHistory }),
      );
      expect(await everyOutput(withheld)).not.toContain(value);
    }
  });

  it.each([
    ['throws', (): Promise<ControlHistory[]> => Promise.reject(new Error('x'))],
    [
      'answers the wrong length',
      (): Promise<ControlHistory[]> => Promise.resolve(['never']),
    ],
    [
      'answers garbage',
      (): Promise<ControlHistory[]> => {
        const garbage: ControlHistory[] = ['never', 'never', 'never'];
        Reflect.set(garbage, 1, 'nope');
        return Promise.resolve(garbage);
      },
    ],
    [
      'never answers',
      (): Promise<ControlHistory[]> => new Promise<ControlHistory[]>(() => {}),
    ],
  ])('treats a bridge that %s as unknown', async (_label, answer) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
    try {
      const recording = loadRecording('shadow');
      let now = 1_800_000_000_000;
      const building = buildPageModel(
        recordedDeps(recording, {
          controlHistory: () => answer(),
          now: () => now,
        }),
      );
      for (let step = 0; step < 50; step += 1) {
        now += 100;
        await jest.advanceTimersByTimeAsync(100);
      }
      const model = await building;
      for (const id of ['note', 'shadow-revealed', 'closed-input']) {
        expect([id, nodeWithId(model, id).secret]).toEqual([id, true]);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('discards answers for a frame whose document changed before they arrived', async () => {
    const recording = loadRecording('frames');
    const registry = recordedRegistry(recording);
    const child = recording.frames.find(
      (frame) => frame.parentId !== undefined && frame.sessionId === '',
    );
    if (!child) throw new Error('Missing child frame');
    const model = await buildPageModel(
      recordedDeps(recording, {
        registry,
        controlHistory: (frameId, _sessionId, _scope, ids) => {
          registry.noteFrameNavigated('', {
            id: frameId,
            loaderId: 'next-document',
            url: child.url,
            parentId: child.parentId,
          });
          return Promise.resolve(ids.map((): ControlHistory => 'never'));
        },
      }),
    );
    expect(nodeWithId(model, 'frame-name').secret).toBe(true);
  });
});

describe('textarea and select in shadow roots and child frames (D12)', () => {
  it('follow the main-frame rules in every scope, tracked or not', async () => {
    for (const [name, plain, value, secret, seed] of [
      [
        'shadow',
        'shadow-textarea',
        'SEED-SHADOW-TEXTAREA-6262',
        'shadow-secret-note',
        'SEED-SHADOW-OTP-9090',
      ],
      [
        'frames',
        'frame-note',
        'frame note',
        'frame-secret-note',
        'SEED-FRAME-OTP-4242',
      ],
      [
        'trackers',
        'open-note',
        'open note',
        'open-secret-note',
        'SEED-TRK-OTP-1107',
      ],
    ] as const) {
      // No tracker answers at all: textareas do not depend on them.
      const model = await buildPageModel(
        recordedDeps(loadRecording(name), { controlHistory: null }),
      );
      const byId = rows(model);
      expect([name, byId.get(plain)?.value]).toEqual([name, value]);
      expect(byId.get(secret)).toMatchObject({ valueRedacted: true });
      expect(await everyOutput(model)).not.toContain(seed);
    }
    const shadow = await buildPageModel(recordedDeps(loadRecording('shadow')));
    expect(rows(shadow).get('closed-select')).toMatchObject({
      value: 'SEED-SHADOW-OPTION-7373',
    });
  });
});

describe('document-start tracking on a recorded Chromium page', () => {
  const TRACKED_SEED = /SEED-TRK-[A-Z]+-\d{4}/;

  it('answers from real trackers: revealed passwords stay withheld, plain values show (D2, D3)', async () => {
    const recording = loadRecording('trackers');
    expect(recording.controlHistory?.length).toBeGreaterThan(0);
    const model = await buildPageModel(recordedDeps(recording));
    const serialized = await everyOutput(model);
    expect(serialized).not.toMatch(TRACKED_SEED);
    const byId = rows(model);
    for (const [id, value] of [
      ['open-plain', 'open plain value'],
      ['closed-plain', 'closed plain value'],
      ['frame-plain', 'frame plain value'],
      ['frame-shadow-plain', 'frame shadow plain'],
      ['cross-plain', 'cross plain value'],
    ]) {
      expect([id, byId.get(id)?.value]).toEqual([id, value]);
    }
    for (const id of [
      'open-revealed',
      'open-mirror',
      'closed-revealed',
      'frame-revealed',
      'frame-shadow-revealed',
      'cross-revealed',
      // Revealed in one scope, then moved (D5): light to shadow, shadow to
      // light, root to root, frame light to shadow, frame shadow to light.
      'move-lts',
      'move-stl',
      'move-rtr',
      'frame-lts',
      'frame-stl',
    ]) {
      expect([id, byId.get(id)?.valueRedacted]).toEqual([id, true]);
    }
    // Labels: never-secret controls name them; a revealed or current
    // password's label exposes nothing (the main frame would name it).
    expect(byId.get('open-remember')?.name).toBe('Remember me');
    expect(byId.get('frame-remember')?.name).toBe('Remember');
    expect(byId.get('open-mirror')?.name).toBeUndefined();
    expect(byId.get('open-password')?.name).toBeUndefined();
    // Each moved input is "was" from the holder that saw it revealed; the
    // main-frame light one (move-stl) took budget for the main-world ask.
    expect(model.trackerHistory).toMatchObject({
      queried: 18,
      was: 10,
      never: 7,
      summaries: 4,
    });
  });

  it.each(['unknown', 'none'] as const)(
    'requires the child light input other holder to vouch (summary %s)',
    async (summary) => {
      const recording = loadRecording('trackers');
      const { controlHistory } = bridge(
        answersById(recording, {
          'frame-stl': 'never',
          'frame-plain': 'never',
        }),
      );
      const model = await buildPageModel(
        recordedDeps(recording, {
          controlHistory,
          controlHistorySummary: (_frameId, _sessionId, scope) =>
            Promise.resolve(scope === 'shadow' ? summary : 'none'),
        }),
      );
      const byId = rows(model);
      const serialized = await everyOutput(model);
      for (const [id, value] of [
        ['frame-stl', 'SEED-TRK-FSTL-1114'],
        ['frame-plain', 'frame plain value'],
      ]) {
        if (summary === 'unknown') {
          expect(byId.get(id)).toMatchObject({ valueRedacted: true });
          if (id === 'frame-stl') expect(serialized).not.toContain(value);
          expect(nodeWithId(model, id).secret).toBe(true);
        } else {
          expect(byId.get(id)).toMatchObject({ value });
          expect(serialized).toContain(value);
        }
      }
    },
  );

  it.each(['unavailable', 'unknown', 'never', 'was'] as const)(
    'checks a child light input against an asked other holder (%s)',
    async (other) => {
      const recording = loadRecording('trackers');
      const own = answersById(recording, {
        'frame-stl': 'never',
        'frame-plain': 'never',
      });
      const { controlHistory } = bridge((call) => {
        if (call.scope === 'light') return own(call);
        if (other === 'unavailable') return Promise.resolve([]);
        return Promise.resolve(call.backendNodeIds.map(() => other));
      });
      const model = await buildPageModel(
        recordedDeps(recording, {
          controlHistory,
          controlHistorySummary: () => Promise.resolve('some'),
        }),
      );
      for (const id of ['frame-stl', 'frame-plain'])
        expect(nodeWithId(model, id).secret).toBe(
          other === 'unavailable' || other === 'was',
        );
    },
  );

  it('withholds a main-frame shadow input when the preload remembered call fails', async () => {
    const recording = loadRecording('trackers');
    const { controlHistory } = bridge(
      answersById(recording, { 'open-plain': 'never' }),
    );
    const base = recordedDeps(recording);
    const model = await buildPageModel(
      recordedDeps(recording, {
        controlHistory,
        isPasswordEverSeen: (frameId, sessionId, ids, purpose) =>
          purpose === 'remembered'
            ? Promise.reject(new Error('Preload unavailable'))
            : base.isPasswordEverSeen(frameId, sessionId, ids),
      }),
    );
    expect(rows(model).get('open-plain')).toMatchObject({
      valueRedacted: true,
    });
    expect(await everyOutput(model)).not.toContain('open plain value');
  });

  it('withholds every tracked input when the trackers did not answer, except the known limit', async () => {
    const recording = loadRecording('trackers');
    const model = await buildPageModel(
      recordedDeps(recording, { controlHistory: null }),
    );
    // Remaining legacy limit, main-frame light DOM only: when its shadow
    // holder is unavailable, the preload's "never" stands. A password
    // revealed in a shadow root and then moved into main-frame light DOM
    // can leak. Child light DOM and all shadow inputs instead fail closed
    // when another holder is unavailable (S5 F4).
    const leaked = Array.from(
      new Set((await everyOutput(model)).match(/SEED-TRK-[A-Z]+-\d{4}/g) ?? []),
    );
    expect(leaked).toEqual(['SEED-TRK-STL-1111']);
    const byId = rows(model);
    for (const id of [
      'open-plain',
      'closed-plain',
      'frame-plain',
      'cross-plain',
    ])
      expect([id, byId.get(id)?.valueRedacted]).toEqual([id, true]);
    expect(byId.get('open-remember')?.name).toBeUndefined();
    expect(byId.get('open-note')?.value).toBe('open note');
  });
});

describe('labels that wrap controls in shadow roots and child frames', () => {
  function withWrappedControl(type: string): {
    recording: Recording;
    control: JsonRecord;
  } {
    const recording = cloneRecording(loadRecording('shadow'));
    const root = treeRoot(recording);
    const note = findTreeNode(root, (node) => hasAttribute(node, 'id', 'note'));
    const control = elementRecord(9_402, 'input', { id: 'wrapped', type }, []);
    appendChild(
      parentOf(root, note),
      elementRecord(9_400, 'label', { id: 'wrapper' }, [
        textRecord(9_401, 'Remember me '),
        control,
      ]),
    );
    return { recording, control };
  }

  it('use the preload rule when every wrapped control is known and never secret', async () => {
    const { recording } = withWrappedControl('checkbox');
    const { controlHistory, calls } = bridge(
      answersById(recording, { wrapped: 'never' }),
    );
    const model = await buildPageModel(
      recordedDeps(recording, {
        controlHistory,
        readStyles: visibleStyles,
        isPasswordEverSeen: availablePreload(recording),
      }),
    );
    expect(calls.flatMap((call) => idsOf(model, call))).toContain('wrapped');
    expect(nodeWithId(model, 'wrapper').labelText).toBe('Remember me');
    expect(rows(model).get('wrapped')?.name).toBe('Remember me');
  });

  it.each([
    ['unknown', 'checkbox'],
    ['was', 'checkbox'],
    ['never', 'password'],
  ] as const)(
    'expose no text when a wrapped control is %s (type %s)',
    async (status, type) => {
      const { recording } = withWrappedControl(type);
      const { controlHistory } = bridge(
        answersById(recording, { wrapped: status }),
      );
      const model = await buildPageModel(
        recordedDeps(recording, { controlHistory, readStyles: visibleStyles }),
      );
      expect(rows(model).has('wrapped')).toBe(true);
      expect(nodeWithId(model, 'wrapper')).toMatchObject({
        text: '',
        labelText: '',
      });
      // A wrapped password has no name here; the main frame names it.
      expect(rows(model).get('wrapped')?.name).toBeUndefined();
    },
  );

  it('keep the wrapped controls of every label in the same scope known before exposing text', async () => {
    const { recording, control } = withWrappedControl('checkbox');
    const label = parentOf(treeRoot(recording), control);
    appendChild(
      label,
      elementRecord(9_403, 'input', { id: 'second', type: 'text' }, []),
    );
    const { controlHistory } = bridge(
      answersById(recording, { wrapped: 'never' }),
    );
    const model = await buildPageModel(
      recordedDeps(recording, { controlHistory }),
    );
    expect(childList(label)).toHaveLength(3);
    expect(nodeWithId(model, 'wrapper').labelText).toBe('');
  });
});
