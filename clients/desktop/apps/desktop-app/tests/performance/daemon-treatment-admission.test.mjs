import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePerformanceResults } from './comparison.mjs';
import * as filesRouteModule from '../../src/main/canopy-runtime/daemon-files-route.ts';
import * as readRouteModule from '../../src/main/canopy-runtime/daemon-read-route-guard.ts';
import {
  admitMainInterval,
  admitRendererCompletion,
  admitTreatment,
  admitTrial,
  armBackend,
  assertStableTreatment,
  labsTreatmentObservation,
} from './daemon-treatment-admission.mjs';

// tsx loads the TypeScript source as CommonJS, behind a default export.
const { DAEMON_FILES_PRODUCTION_SELECTION } =
  filesRouteModule.default ?? filesRouteModule;
const { READ_ROUTE_TABLE } = readRouteModule.default ?? readRouteModule;

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

const FILES_OPERATIONS = ['roots', 'directory', 'file', 'search', 'link'];

function routeKeys(values = {}) {
  const keys = {};
  for (const operation of FILES_OPERATIONS)
    for (const outcome of [
      'direct',
      'daemon',
      'daemon.queries',
      'daemon.retries',
      'daemon.served',
      'daemon.bypassed',
      'daemon.fallback.connect_failed',
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
    invocations: {
      roots: 0,
      directory: 0,
      file: 0,
      search: 0,
      link: 0,
      ...invocations,
    },
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
  assert.deepEqual(admitted.starts, {
    roots: 1,
    directory: 2,
    file: 0,
    search: 0,
    link: 0,
  });
  value.operations = ['directory'];
  assert.ok(admitMainInterval(value).reasons.includes('unexpected roots read'));
});

const servedRoute = (operation, count) => ({
  [`files.${operation}.daemon`]: count,
  [`files.${operation}.daemon.served`]: count,
  [`files.${operation}.daemon.queries`]: count,
});
const directRoute = (operation, count) => ({
  [`files.${operation}.direct`]: count,
});

/** `count` reads of one operation; `backend` defaults to the arm's. */
function reads(arm, operation, { count = 2, backend, platform } = {}) {
  const served = backend ?? (arm === 'on' ? 'daemon' : 'direct');
  const entries = Array.from({ length: count }, (_, index) => [
    read(operation, served, index + 1, 'started', 5 + index * 2 + 1),
    read(operation, served, index + 1, 'success', 5 + index * 2 + 2),
  ]).flat();
  const value = interval(arm, { entries });
  value.after.counters = counters(
    { [operation]: count },
    served === 'daemon'
      ? servedRoute(operation, count)
      : directRoute(operation, count),
  );
  value.operations = [operation];
  value.platform = platform;
  return value;
}

const expectReason = (reasons, reason) =>
  assert.ok(reasons.includes(reason), `${reason}: ${reasons}`);

test('file, search and link reads are measured on the arm backend', () => {
  for (const operation of ['file', 'search', 'link'])
    for (const [arm, platform] of [
      ['on', 'darwin'],
      ['on', 'linux'],
      ['off', 'darwin'],
      ['off', 'win32'],
      ['off', undefined],
    ]) {
      const admitted = admitMainInterval(reads(arm, operation, { platform }));
      assert.deepEqual(admitted.reasons, [], `${operation} ${arm} ${platform}`);
      assert.equal(admitted.starts[operation], 2);
    }
});

test('on-arm file, search and link reads that went direct, failed, fell back, ran twice or never finished are rejected', () => {
  for (const operation of ['file', 'search', 'link']) {
    const mutate = (arm, change, options = {}) => {
      const value = reads(arm, operation, { platform: 'darwin', ...options });
      change(value);
      return admitMainInterval(value).reasons;
    };
    const direct = mutate('on', () => {}, { backend: 'direct' });
    expectReason(direct, 'direct read in on arm');
    expectReason(
      direct,
      `route counter files.${operation}.direct changed by 2`,
    );
    expectReason(
      mutate('off', () => {}, { backend: 'daemon' }),
      'daemon read in off arm',
    );
    expectReason(
      mutate('on', (v) => (v.after.route.entries[1].phase = 'failed')),
      'read failed',
    );
    expectReason(
      mutate('on', (v) => (v.after.route.entries[2].request = 1)),
      'duplicate read start',
    );
    expectReason(
      mutate(
        'on',
        (v) => v.after.route.entries.pop() && v.after.route.cursor.sequence--,
      ),
      'read without a finish',
    );
    expectReason(
      mutate(
        'on',
        (v) =>
          (v.after.counters.route[`files.${operation}.daemon.failed.internal`] =
            1),
      ),
      `route counter files.${operation}.daemon.failed.internal changed by 1`,
    );
    // Unreachable daemon: the direct reader answered a daemon selection.
    const fellBack = mutate('on', (v) => {
      for (const entry of v.after.route.entries)
        if (entry.phase === 'success') entry.phase = 'fallback';
      v.after.counters = counters(
        { [operation]: 2 },
        {
          [`files.${operation}.daemon`]: 2,
          [`files.${operation}.daemon.fallback.connect_failed`]: 2,
        },
      );
    });
    expectReason(fellBack, 'read fallback');
    expectReason(
      fellBack,
      `route counter files.${operation}.daemon.fallback.connect_failed changed by 2`,
    );
  }
});

test('a search walk selected while latched is rejected like a latched directory read', () => {
  // Both journal a daemon selection ending in `fallback` and count
  // `daemon` + `daemon.bypassed` with no query sent.
  const latched = (operation) => {
    const value = reads('on', operation, { platform: 'darwin' });
    for (const entry of value.after.route.entries)
      if (entry.phase === 'success') entry.phase = 'fallback';
    value.after.counters = counters(
      { [operation]: 2 },
      {
        [`files.${operation}.daemon`]: 2,
        [`files.${operation}.daemon.bypassed`]: 2,
      },
    );
    return admitMainInterval(value).reasons;
  };
  const search = latched('search');
  expectReason(search, 'read fallback');
  expectReason(
    search,
    'route counter files.search.daemon.bypassed changed by 2',
  );
  assert.deepEqual(
    search.map((reason) => reason.replace('files.search.', 'files.*.')),
    latched('directory').map((reason) =>
      reason.replace('files.directory.', 'files.*.'),
    ),
  );
});

test('on Windows the on arm keeps file, search and link direct and roots and directory on the daemon', () => {
  for (const operation of ['file', 'search', 'link']) {
    assert.deepEqual(
      admitMainInterval(
        reads('on', operation, { backend: 'direct', platform: 'win32' }),
      ).reasons,
      [],
      operation,
    );
    expectReason(
      admitMainInterval(reads('on', operation, { platform: 'win32' })).reasons,
      'daemon read in on arm',
    );
    // Which backend the on arm expects depends on the host; never guess it.
    for (const platform of [undefined, 'freebsd'])
      expectReason(
        admitMainInterval(reads('on', operation, { platform })).reasons,
        `${operation} read without a host platform`,
      );
  }
  for (const operation of ['roots', 'directory']) {
    assert.deepEqual(
      admitMainInterval(reads('on', operation, { platform: 'win32' })).reasons,
      [],
    );
    expectReason(
      admitMainInterval(
        reads('on', operation, { backend: 'direct', platform: 'win32' }),
      ).reasons,
      'direct read in on arm',
    );
  }
  // The trial passes the host platform with its main evidence.
  const trial = {
    arm: 'on',
    workload: 'query',
    artifactSha256: 'c'.repeat(64),
    brand: 'canopy',
    treatment: { before: labs('on'), after: labs('on') },
    main: reads('on', 'file', { backend: 'direct', platform: 'win32' }),
  };
  assert.deepEqual(admitTrial(trial).reasons, []);
});

test('undeclared file, search and link reads are unexpected in both arms', () => {
  for (const operation of ['file', 'search', 'link'])
    for (const arm of ['on', 'off']) {
      const backend = arm === 'on' ? 'daemon' : 'direct';
      const value = interval(arm, {
        entries: [
          read('directory', backend, 1, 'started', 6),
          read(operation, backend, 2, 'started', 7),
          read(operation, backend, 2, 'success', 8),
          read('directory', backend, 1, 'success', 9),
        ],
      });
      value.platform = 'darwin';
      value.after.counters = counters(
        { directory: 1, [operation]: 1 },
        arm === 'on'
          ? { ...servedRoute('directory', 1), ...servedRoute(operation, 1) }
          : { ...directRoute('directory', 1), ...directRoute(operation, 1) },
      );
      // One reason per journal entry, as for roots and directory.
      assert.deepEqual(
        [...new Set(admitMainInterval(value).reasons)],
        [`unexpected ${operation} read`],
        `${operation} ${arm}`,
      );
      value.operations = ['directory', operation];
      assert.deepEqual(admitMainInterval(value).reasons, []);
    }
});

test('file and link invocations may exceed their routed reads; search pages need a call', () => {
  for (const operation of ['file', 'link']) {
    // Unscoped and sealed-viewer calls are invoked but never routed.
    const extra = reads('on', operation, { platform: 'darwin' });
    extra.after.counters.invocations[operation] = 5;
    assert.deepEqual(admitMainInterval(extra).reasons, []);
    const missing = reads('on', operation, { platform: 'darwin' });
    missing.after.counters.invocations[operation] = 1;
    expectReason(
      admitMainInterval(missing).reasons,
      `unexplained ${operation} invocations`,
    );
  }
  for (const calls of [1, 3]) {
    const search = reads('on', 'search', { platform: 'darwin' });
    search.after.counters.invocations.search = calls;
    assert.deepEqual(admitMainInterval(search).reasons, []);
  }
  // Every page runs inside a file-index:get call; pages without one belong
  // to a walk that began before the interval.
  for (const arm of ['on', 'off']) {
    const orphaned = reads(arm, 'search', { platform: 'darwin' });
    orphaned.after.counters.invocations.search = 0;
    expectReason(
      admitMainInterval(orphaned).reasons,
      'unexplained search invocations',
    );
  }
});

test('the on-arm reads the treatment once ignored are now rejected unless the host keeps them direct', () => {
  // The interleaved shapes admission used to journal outside the treatment.
  const searches = (platform) => {
    const value = interval('on', {
      entries: [
        read('roots', 'daemon', 1, 'started', 6),
        read('search', 'direct', 2, 'started', 7),
        read('search', 'direct', 3, 'started', 8),
        read('search', 'direct', 2, 'success', 9),
        read('search', 'direct', 3, 'success', 10),
        read('roots', 'daemon', 1, 'success', 11),
      ],
    });
    value.platform = platform;
    value.operations = ['roots', 'search'];
    value.after.counters = counters(
      { roots: 1, search: 1 },
      { ...servedRoute('roots', 1), ...directRoute('search', 2) },
    );
    return admitMainInterval(value);
  };
  const rejected = searches('darwin');
  expectReason(rejected.reasons, 'direct read in on arm');
  expectReason(
    rejected.reasons,
    'route counter files.search.direct changed by 2',
  );
  assert.deepEqual(searches('win32').reasons, []);
  assert.deepEqual(searches('win32').starts, {
    roots: 1,
    directory: 0,
    file: 0,
    search: 2,
    link: 0,
  });

  const links = interval('on', {
    entries: [
      read('roots', 'daemon', 1, 'started', 6),
      read('link', 'direct', 2, 'started', 7),
      read('link', 'direct', 2, 'failed', 8),
      read('file', 'direct', 3, 'started', 9),
      read('file', 'direct', 3, 'success', 10),
      read('roots', 'daemon', 1, 'success', 11),
    ],
  });
  links.operations = ['roots', 'file', 'link'];
  links.after.counters = counters(
    { roots: 1, file: 1, link: 1 },
    {
      ...servedRoute('roots', 1),
      ...directRoute('file', 1),
      ...directRoute('link', 1),
    },
  );
  for (const platform of ['darwin', 'linux']) {
    links.platform = platform;
    const reasons = admitMainInterval(links).reasons;
    expectReason(reasons, 'direct read in on arm');
    expectReason(reasons, 'read failed');
  }
  // Direct is right on Windows, but a failed resolution is still no evidence.
  links.platform = 'win32';
  assert.deepEqual(admitMainInterval(links).reasons, ['read failed']);
});

test('the on-arm backends follow the production selection and the read-route table', () => {
  for (const operation of FILES_OPERATIONS)
    for (const platform of ['darwin', 'linux', 'win32']) {
      const daemon =
        DAEMON_FILES_PRODUCTION_SELECTION.has(operation) &&
        READ_ROUTE_TABLE[`files.${operation}`][platform].kind === 'eligible';
      assert.equal(
        armBackend(operation, 'on', platform),
        daemon ? 'daemon' : 'direct',
        `${operation} ${platform}`,
      );
      assert.equal(armBackend(operation, 'off', platform), 'direct');
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
