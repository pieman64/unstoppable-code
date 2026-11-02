import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePerformanceResults } from './comparison.mjs';
import {
  admitMainInterval,
  admitRendererCompletion,
  admitTreatment,
  admitTrial,
  assertStableTreatment,
  labsTreatmentObservation,
} from './daemon-treatment-admission.mjs';

const CONTEXT = 'a'.repeat(64);

function labs(arm, overrides = {}) {
  const on = arm === 'on';
  return {
    experimentId: 'daemon-files-reads',
    generation: 2,
    revision: 7,
    scope: 'account-1',
    contextIdentity: CONTEXT,
    ready: true,
    choicesReady: true,
    availability: 'offered',
    source: 'live',
    rawFlag: 'offered',
    choice: on,
    enabled: on,
    ...overrides,
  };
}

function routeKeys(values = {}) {
  const keys = {};
  for (const operation of ['roots', 'directory'])
    for (const outcome of [
      'direct',
      'daemon',
      'daemon.queries',
      'daemon.retries',
      'daemon.served',
      'direct.discarded',
      'daemon.failed.internal',
    ])
      keys[`files.${operation}.${outcome}`] = 0;
  return { ...keys, ...values };
}

function counters(invocations = {}, route = {}, extra = {}) {
  return {
    generation: 0,
    overflow: 0,
    invocations: { roots: 0, directory: 0, ...invocations },
    route: routeKeys(route),
    ...extra,
  };
}

function read(operation, backend, request, phase, sequence, extra = {}) {
  return {
    operation,
    backend,
    senderId: 3,
    generation: 0,
    request,
    phase,
    sequence,
    ...extra,
  };
}

/** An observed interval of `count` directory reads on one backend. */
function interval(arm, { count = 2, entries, after = {}, beforeRoute } = {}) {
  const backend = arm === 'on' ? 'daemon' : 'direct';
  const journal =
    entries ??
    Array.from({ length: count }, (_, index) => [
      read('directory', backend, index + 1, 'started', 5 + index * 2 + 1),
      read('directory', backend, index + 1, 'success', 5 + index * 2 + 2),
    ]).flat();
  const route =
    arm === 'on'
      ? {
          'files.directory.daemon': count,
          'files.directory.daemon.served': count,
          'files.directory.daemon.queries': count,
        }
      : { 'files.directory.direct': count };
  const cursor = { observerId: 'main-1', sequence: 5 };
  const before = {
    source: 'desktop-main-files-singleton-v1',
    route:
      beforeRoute === undefined
        ? {
            cursor,
            complete: true,
            entries: [],
            enabled: arm === 'on',
            generation: 0,
            disposed: false,
          }
        : beforeRoute,
    counters: counters(),
  };
  return {
    before,
    after: {
      source: 'desktop-main-files-singleton-v1',
      route: {
        cursor: { observerId: 'main-1', sequence: 5 + journal.length },
        capacity: 256,
        dropped: 0,
        complete: true,
        entries: journal,
        enabled: arm === 'on',
        generation: 0,
        disposed: false,
        ...after.route,
      },
      counters: counters({ directory: count }, route, after.counters),
    },
    arm,
    operations: ['roots', 'directory'],
  };
}

function rendererSnapshot(overrides = {}) {
  return {
    source: 'desktop-renderer-file-list-store-v1',
    cursor: { observerId: 'renderer-1', sequence: 9 },
    complete: true,
    entries: [
      { request: 2, phase: 'started', matchesTarget: true, sequence: 8 },
      { request: 2, phase: 'success', matchesTarget: true, sequence: 9 },
    ],
    currentSuccess: true,
    settled: true,
    hasError: false,
    itemCount: 120,
    version: 4,
    ...overrides,
  };
}

function renderer(first = {}, recheck = {}, extra = {}) {
  return {
    first: rendererSnapshot(first),
    recheck: rendererSnapshot(recheck),
    expectedItemCount: 120,
    visibleItemCount: 120,
    animationFrames: 2,
    ...extra,
  };
}

test('treatment admission accepts both arms from an effective settled entry', () => {
  for (const arm of ['on', 'off']) {
    const admitted = admitTreatment(labs(arm), arm);
    assert.deepEqual(admitted.reasons, []);
    assert.equal(admitted.treatment.source, 'live');
    assert.equal(admitted.treatment.rawFlag, 'offered');
  }
});

test('treatment admission fails closed on pending, fallback-raw and mismatched evidence', () => {
  const cases = [
    [labs('on', { choicesReady: false }), 'choices not settled'],
    [labs('on', { ready: false, enabled: false }), 'Labs not ready'],
    [
      labs('on', { source: 'raw-flag' }),
      'not an effective treatment source: raw-flag',
    ],
    [
      labs('on', { source: 'fixture' }),
      'not an effective treatment source: fixture',
    ],
    [
      labs('on', { source: undefined }),
      'not an effective treatment source: undefined',
    ],
    [labs('on', { choice: null }), 'persisted choice is not the arm'],
    [labs('on', { enabled: false }), 'effective enabled is not the arm'],
    [labs('on', { availability: 'hidden' }), 'experiment hidden'],
    [
      labs('on', { contextIdentity: 'short' }),
      'treatment context identity missing',
    ],
    [
      labs('on', { generation: undefined }),
      'treatment generation/revision missing',
    ],
    [
      labs('on', { source: 'cached', contextIdentity: null }),
      'treatment context identity missing',
    ],
  ];
  assert.deepEqual(
    admitTreatment(
      labs('on', {
        source: 'fallback:launchdarkly_disabled',
        contextIdentity: null,
      }),
      'on',
    ).reasons,
    [],
  );
  for (const [observation, reason] of cases) {
    const result = admitTreatment(observation, 'on');
    assert.equal(result.admitted, false, reason);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons}`);
  }
  assert.deepEqual(admitTreatment(undefined, 'on').reasons, [
    'treatment observation missing',
  ]);
});

test('a revision increase is harmless; a treatment or context change is not', () => {
  assert.equal(
    assertStableTreatment(labs('on'), labs('on', { revision: 9 })).admitted,
    true,
  );
  for (const change of [
    { enabled: false },
    { contextIdentity: 'b'.repeat(64) },
    { generation: 3 },
    { source: 'cached' },
    { revision: 6 },
  ])
    assert.equal(
      assertStableTreatment(labs('on'), labs('on', change)).admitted,
      false,
    );
});

test('main admission accepts served daemon reads and direct reads per arm', () => {
  assert.deepEqual(admitMainInterval(interval('on')).reasons, []);
  assert.deepEqual(admitMainInterval(interval('off')).reasons, []);
  const retried = interval('on');
  retried.after.counters.route['files.directory.daemon.retries'] = 1;
  retried.after.counters.route['files.directory.daemon.queries'] = 3;
  assert.deepEqual(admitMainInterval(retried).reasons, []);
  const overRetried = interval('on');
  overRetried.after.counters.route['files.directory.daemon.retries'] = 3;
  overRetried.after.counters.route['files.directory.daemon.queries'] = 5;
  assert.ok(
    admitMainInterval(overRetried).reasons.includes(
      'route counter files.directory.daemon.retries changed by 3',
    ),
  );
});

test('first use covers the whole journal of a route that did not exist', () => {
  const first = interval('on', { beforeRoute: null });
  first.after.route.cursor.sequence = 4;
  first.after.route.entries = first.after.route.entries.map((entry, index) => ({
    ...entry,
    sequence: index + 1,
  }));
  assert.deepEqual(admitMainInterval(first).reasons, []);
  first.after.route.complete = false;
  assert.ok(
    admitMainInterval(first).reasons.includes(
      'route journal interval incomplete',
    ),
  );
});

test('main admission rejects missing, ambiguous or unexplained evidence', () => {
  const mutate = (arm, change) => {
    const value = interval(arm);
    change(value);
    return admitMainInterval(value).reasons;
  };
  const expectReason = (reasons, reason) =>
    assert.ok(reasons.includes(reason), `${reason}: ${reasons}`);
  expectReason(
    mutate('on', (v) => (v.after.route = null)),
    'Files route evidence missing',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.entries[1].sequence = 9)),
    'route journal sequence gap',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.cursor.sequence = 12)),
    'route journal sequence gap',
  );
  expectReason(
    mutate('on', (v) => (v.after.counters.overflow = 1)),
    'counter overflow',
  );
  expectReason(
    mutate('on', (v) => (v.after.counters.generation = 1)),
    'counter generation changed',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.entries[2].senderId = 4)),
    'ambiguous sender attribution',
  );
  expectReason(
    mutate('on', (v) => (v.after.counters.invocations.directory = 3)),
    'unexplained directory invocations',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.entries[1].phase = 'failed')),
    'read failed',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.entries[1].request = 9)),
    'read finish without its start',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.entries[2].request = 1)),
    'duplicate read start',
  );
  expectReason(
    mutate('on', (v) => (v.after.route.enabled = false)),
    'route treatment is not the arm',
  );
  expectReason(
    mutate(
      'on',
      (v) => v.after.route.entries.pop() && v.after.route.cursor.sequence--,
    ),
    'read without a finish',
  );
  expectReason(
    mutate('off', (v) => (v.after.route.entries[0].backend = 'daemon')),
    'daemon read in off arm',
  );
  expectReason(
    mutate(
      'on',
      (v) =>
        (v.after.counters.route['files.directory.daemon.failed.internal'] = 1),
    ),
    'route counter files.directory.daemon.failed.internal changed by 1',
  );
  expectReason(
    mutate('off', (v) => (v.after.counters.route['files.roots.daemon'] = 1)),
    'route counter files.roots.daemon changed by 1',
  );
  expectReason(
    admitMainInterval(interval('on', { count: 0 })).reasons,
    'no Files invocation in interval',
  );
  assert.deepEqual(
    admitMainInterval({ before: {}, after: {}, arm: 'on', operations: [] })
      .reasons,
    ['main Files observer missing'],
  );
  expectReason(
    mutate('on', (v) => (v.after.route = { complete: true })),
    'Files route evidence missing',
  );
  expectReason(
    mutate('on', (v) => (v.before.route = { complete: true })),
    'Files route evidence malformed',
  );
  expectReason(
    mutate('on', (v) => (v.before.route = undefined)),
    'Files route evidence malformed',
  );
  expectReason(
    mutate('on', (v) => {
      v.before.counters.generation = undefined;
      v.after.counters.generation = undefined;
    }),
    'counter generation changed',
  );
});

test('renderer admission rejects stale success and changes after two frames', () => {
  assert.deepEqual(admitRendererCompletion(renderer()).reasons, []);
  const rejected = (first, recheck, extra) =>
    admitRendererCompletion(renderer(first, recheck, extra)).admitted;
  assert.equal(rejected({ currentSuccess: false }), false);
  assert.equal(rejected({}, { currentSuccess: false }), false);
  assert.equal(rejected({ complete: false }), false);
  const later = rendererSnapshot().entries;
  // Another target's read after completion is harmless; the target's is not.
  assert.equal(
    rejected(
      {},
      {
        cursor: { observerId: 'renderer-1', sequence: 10 },
        entries: [...later, { request: 3, matchesTarget: false, sequence: 10 }],
      },
    ),
    true,
  );
  assert.equal(
    rejected(
      {},
      {
        cursor: { observerId: 'renderer-1', sequence: 10 },
        entries: [...later, { request: 3, matchesTarget: true, sequence: 10 }],
      },
    ),
    false,
  );
  assert.equal(
    rejected({}, { cursor: { observerId: 'renderer-2', sequence: 9 } }),
    false,
  );
  assert.equal(rejected({}, { entries: undefined }), false);
  assert.equal(rejected({}, { version: 5 }), false);
  assert.equal(rejected({ itemCount: 119 }), false);
  assert.equal(rejected({}, {}, { visibleItemCount: 0 }), false);
  assert.equal(rejected({}, {}, { animationFrames: 1 }), false);
  assert.equal(
    admitRendererCompletion({ first: null, recheck: null }).admitted,
    false,
  );
});

test('Labs snapshot entries flatten into the admitted observation', () => {
  const snapshot = {
    generation: 2,
    revision: 7,
    scope: 'account-1',
    ready: true,
    choicesReady: true,
    earlyAccessEnabled: false,
    experiments: [
      { id: 'sidebar', availability: 'on', choice: null, enabled: true },
      {
        id: 'daemon-files-reads',
        availability: 'offered',
        choice: true,
        enabled: true,
      },
    ],
  };
  const provenance = {
    source: 'live',
    contextIdentity: CONTEXT,
    rawFlag: 'offered',
  };
  assert.deepEqual(labsTreatmentObservation(snapshot, provenance), labs('on'));
  assert.equal(
    labsTreatmentObservation({ ...snapshot, experiments: [] }, provenance),
    null,
  );
  // Without the projection's provenance, admission rejects instead of guessing.
  assert.deepEqual(
    admitTreatment(labsTreatmentObservation(snapshot), 'on').reasons,
    [
      'treatment context identity missing',
      'not an effective treatment source: undefined',
    ],
  );
});

test('interleaved concurrent roots and directory reads pair by request', () => {
  const entries = [
    read('roots', 'daemon', 1, 'started', 6),
    read('directory', 'daemon', 2, 'started', 7),
    read('directory', 'daemon', 3, 'started', 8),
    read('directory', 'daemon', 3, 'success', 9),
    read('roots', 'daemon', 1, 'success', 10),
    read('directory', 'daemon', 2, 'success', 11),
  ];
  const value = interval('on', { entries });
  value.after.counters = counters(
    { roots: 1, directory: 2 },
    {
      'files.roots.daemon': 1,
      'files.roots.daemon.served': 1,
      'files.roots.daemon.queries': 1,
      'files.directory.daemon': 2,
      'files.directory.daemon.served': 2,
      'files.directory.daemon.queries': 2,
    },
  );
  const admitted = admitMainInterval(value);
  assert.deepEqual(admitted.reasons, []);
  assert.deepEqual(admitted.starts, { roots: 1, directory: 2 });
  value.operations = ['directory'];
  assert.ok(admitMainInterval(value).reasons.includes('unexpected roots read'));
});

test('direct file reads are journaled outside the treatment in both arms', () => {
  for (const [arm, backend] of [
    ['on', 'daemon'],
    ['off', 'direct'],
  ]) {
    const entries = [
      read('directory', backend, 1, 'started', 6),
      read('file', 'direct', 2, 'started', 7),
      read('file', 'direct', 2, 'success', 8),
      read('directory', backend, 1, 'success', 9),
    ];
    const value = interval(arm, { entries });
    value.after.counters = counters(
      { roots: 0, directory: 1, file: 1 },
      arm === 'on'
        ? {
            'files.directory.daemon': 1,
            'files.directory.daemon.served': 1,
            'files.directory.daemon.queries': 1,
            'files.file.direct': 1,
          }
        : { 'files.directory.direct': 1, 'files.file.direct': 1 },
    );
    const admitted = admitMainInterval(value);
    assert.deepEqual(admitted.reasons, [], arm);
    assert.deepEqual(admitted.starts, { roots: 0, directory: 1 });
  }
});

test('direct index searches are journaled outside the treatment in both arms', () => {
  for (const [arm, backend] of [
    ['on', 'daemon'],
    ['off', 'direct'],
  ]) {
    const entries = [
      read('roots', backend, 1, 'started', 6),
      read('search', 'direct', 2, 'started', 7),
      read('search', 'direct', 3, 'started', 8),
      read('search', 'direct', 2, 'success', 9),
      read('search', 'direct', 3, 'success', 10),
      read('roots', backend, 1, 'success', 11),
    ];
    const value = interval(arm, { entries });
    value.after.counters = counters(
      { roots: 1, directory: 0, search: 1 },
      arm === 'on'
        ? {
            'files.roots.daemon': 1,
            'files.roots.daemon.served': 1,
            'files.roots.daemon.queries': 1,
            'files.search.direct': 2,
          }
        : { 'files.roots.direct': 1, 'files.search.direct': 2 },
    );
    const admitted = admitMainInterval(value);
    assert.deepEqual(admitted.reasons, [], arm);
    assert.deepEqual(admitted.starts, { roots: 1, directory: 0 });
  }
});

test('direct link resolutions are journaled outside the treatment in both arms', () => {
  for (const [arm, backend] of [
    ['on', 'daemon'],
    ['off', 'direct'],
  ]) {
    const entries = [
      read('roots', backend, 1, 'started', 6),
      read('link', 'direct', 2, 'started', 7),
      read('link', 'direct', 2, 'failed', 8),
      read('file', 'direct', 3, 'started', 9),
      read('file', 'direct', 3, 'success', 10),
      read('roots', backend, 1, 'success', 11),
    ];
    const value = interval(arm, { entries });
    value.after.counters = counters(
      { roots: 1, directory: 0, file: 1, link: 1 },
      arm === 'on'
        ? {
            'files.roots.daemon': 1,
            'files.roots.daemon.served': 1,
            'files.roots.daemon.queries': 1,
            'files.file.direct': 1,
            'files.link.direct': 1,
          }
        : {
            'files.roots.direct': 1,
            'files.file.direct': 1,
            'files.link.direct': 1,
          },
    );
    const admitted = admitMainInterval(value);
    assert.deepEqual(admitted.reasons, [], arm);
    assert.deepEqual(admitted.starts, { roots: 1, directory: 0 });
  }
});

test('trial admission requires every component', () => {
  const trial = {
    arm: 'on',
    workload: 'visible',
    artifactSha256: 'c'.repeat(64),
    brand: 'canopy',
    treatment: { before: labs('on'), after: labs('on', { revision: 8 }) },
    main: interval('on'),
    renderer: renderer(),
  };
  const admitted = admitTrial(trial);
  assert.deepEqual(admitted.reasons, []);
  assert.equal(admitted.treatment.artifactSha256, 'c'.repeat(64));
  assert.equal(admitted.treatment.brand, 'canopy');
  assert.deepEqual(
    admitTrial({ ...trial, artifactSha256: undefined, brand: '' }).reasons,
    ['artifact: artifact hash missing', 'artifact: brand missing'],
  );
  // Visible listings need renderer completion; queries complete in main.
  assert.deepEqual(admitTrial({ ...trial, renderer: undefined }).reasons, [
    'renderer: renderer Files observer missing',
  ]);
  assert.equal(
    admitTrial({ ...trial, workload: 'query', renderer: undefined }).admitted,
    true,
  );
  assert.deepEqual(admitTrial({ ...trial, workload: 'scroll' }).reasons, [
    'workload: unknown workload scroll',
  ]);
  assert.ok(
    admitTrial({ ...trial, treatment: undefined }).reasons.includes(
      'treatment: treatment observation missing',
    ),
  );
  trial.treatment.after = labs('on', { enabled: false });
  assert.ok(
    admitTrial(trial).reasons.includes(
      'treatment-stability: treatment enabled changed',
    ),
  );
});

function comparable(treatment, config = { files: 120 }) {
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'release-like',
    profile: 'baseline',
    config,
    environment: { windowVisible: false },
    scenarios: [{ name: 'files', status: 'ok' }],
    metrics: {
      'files.open_ms': { value: 100, unit: 'ms', direction: 'lower' },
    },
    ...(treatment && { treatment }),
  };
}

const TREATMENT = {
  experimentId: 'daemon-files-reads',
  source: 'live',
  contextIdentity: CONTEXT,
  brand: 'canopy',
  artifactSha256: 'c'.repeat(64),
};
const arm = (name, extra = {}) => ({
  ...TREATMENT,
  arm: name,
  enabled: name === 'on',
  choice: name === 'on',
  ...extra,
});

test('comparator admits arms of one artifact and one arm across builds only', () => {
  const pair = (left, right) =>
    comparePerformanceResults(comparable(left), comparable(right))
      .incompatibilities;
  assert.deepEqual(pair(arm('off'), arm('on')), []);
  assert.deepEqual(
    pair(arm('on'), arm('on', { artifactSha256: 'd'.repeat(64) })),
    [],
  );
  assert.deepEqual(pair(arm('on'), arm('on')), []);
  assert.deepEqual(
    pair(arm('off'), arm('on', { artifactSha256: 'd'.repeat(64) })),
    ['treatment.artifactSha256'],
  );
  // The Labs context hash includes the app version, so it may differ only
  // across builds.
  const otherContext = { contextIdentity: 'b'.repeat(64) };
  assert.deepEqual(
    pair(
      arm('on'),
      arm('on', { artifactSha256: 'd'.repeat(64), ...otherContext }),
    ),
    [],
  );
  assert.deepEqual(pair(arm('off'), arm('on', otherContext)), [
    'treatment.contextIdentity',
  ]);
  // One build under another targeting context is not a build difference.
  for (const name of ['off', 'on']) {
    const result = comparePerformanceResults(
      comparable(arm(name)),
      comparable(arm(name, otherContext)),
    );
    assert.deepEqual(
      {
        compatible: result.compatible,
        passed: result.passed,
        incompatibilities: result.incompatibilities,
      },
      {
        compatible: false,
        passed: false,
        incompatibilities: ['treatment.contextIdentity'],
      },
    );
  }
  assert.deepEqual(pair(arm('off'), arm('on', { brand: 'other' })), [
    'treatment.brand',
  ]);
  assert.deepEqual(pair(arm('off'), arm('on', { source: 'cached' })), [
    'treatment.source',
  ]);
  assert.deepEqual(pair(arm('off'), undefined), ['treatment']);
  assert.deepEqual(pair(arm('off'), arm('on', { enabled: false })), [
    'treatment.arm',
  ]);
  // Without an artifact hash the arm-vs-build rule would be vacuous.
  assert.deepEqual(
    pair(
      arm('off', { artifactSha256: undefined }),
      arm('on', { artifactSha256: undefined }),
    ),
    ['treatment.artifact'],
  );
  assert.deepEqual(pair(arm('on'), arm('on', { brand: undefined })), [
    'treatment.artifact',
  ]);
});

test('comparator rejects treatment in workload config and keeps config equality', () => {
  const baseline = comparable(undefined, { files: 120, treatment: 'on' });
  assert.deepEqual(
    comparePerformanceResults(baseline, comparable(undefined))
      .incompatibilities,
    ['config', 'treatmentInConfig'],
  );
  assert.deepEqual(
    comparePerformanceResults(
      comparable(arm('off')),
      comparable(arm('on'), { files: 80 }),
    ).incompatibilities,
    ['config'],
  );
});
