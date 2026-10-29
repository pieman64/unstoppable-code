import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  parsePsCpuTime,
  parsePsSnapshot,
  createOwnedCpuLedger,
  assertEarlyStartupCoverage,
  createValidatedAppMetricSource,
  startStartupSampler,
} from './browser-profiles-startup-sampler.mjs';

const started = 'Fri Sep 11 12:34:56 2026';
const row = (
  pid,
  ppid,
  cpuTimeMs,
  rssKb = 1024,
  birth = started,
  {
    state = 'S',
    command = '/Applications/Electron Helper (Renderer)',
    cpuTimeText = `${cpuTimeMs}ms`,
  } = {},
) => ({
  pid,
  ppid,
  cpuTimeMs,
  cpuTimeText,
  rssKb,
  state,
  started: birth,
  command,
});

test('Darwin CPU time parses hundredths, unbounded minutes and long-lived hour fields', () => {
  assert.equal(parsePsCpuTime('0:00.01'), 10);
  assert.equal(parsePsCpuTime('12:34.56'), 754560);
  assert.equal(parsePsCpuTime('123:45.67'), 7425670);
  assert.equal(parsePsCpuTime('1:02:03'), 3723000);
  assert.equal(parsePsCpuTime('24:59:59.99'), 89999990);
  for (const value of [
    '',
    'unavailable',
    '-1:02.00',
    '1:60.00',
    '2:61:00',
    '00:01.1234',
    '1.23',
  ])
    assert.throws(() => parsePsCpuTime(value), /Invalid ps CPU time/);
});

test('ps parsing retains full owned command path and rejects missing/malformed fields', () => {
  const parsed = parsePsSnapshot(
    `  200  1  0:01.25  8192  S  ${started} /Applications/Electron App.app/Contents/MacOS/Electron\n`,
  );
  assert.equal(parsed[0].cpuTimeText, '0:01.25');
  assert.equal(parsed[0].cpuTimeMs, 1250);
  assert.equal(parsed[0].rssKb, 8192);
  assert.equal(parsed[0].state, 'S');
  assert.equal(
    parsed[0].command,
    '/Applications/Electron App.app/Contents/MacOS/Electron',
  );
  for (const input of [
    '',
    'PID PPID TIME RSS STATE COMMAND',
    `200 1 0:00.00 -1 S ${started} Electron`,
    `200 1 unavailable 20 S ${started} Electron`,
    `200 1 0:00.00 20 ${started} Electron`,
  ])
    assert.throws(() => parsePsSnapshot(input));
  assert.throws(
    () =>
      parsePsSnapshot(
        `200 1 0:00.00 20 S ${started} Electron\n200 1 0:00.00 20 S ${started} Electron`,
      ),
    /duplicate/,
  );
});

test('known owned child zombie retains prior CPU but keeps its raw zero resource row', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe(
    [row(200, 1, 100, 1000), row(201, 200, 250, 4608, started, { state: 'S' })],
    100,
  );
  const zombie = ledger.observe(
    [
      row(200, 1, 120, 1000),
      row(201, 200, 0, 0, started, {
        state: 'Z+',
        command: '<defunct>',
        cpuTimeText: '0:00.00',
      }),
    ],
    200,
  );
  assert.equal(zombie.observedCumulativeCpuMs, 370);
  assert.equal(zombie.observedCpuDeltaMs, 20);
  assert.equal(zombie.rssKb, 1000);
  assert.deepEqual(zombie.processes.at(-1), {
    ...row(201, 200, 0, 0, started, {
      state: 'Z+',
      command: '<defunct>',
      cpuTimeText: '0:00.00',
    }),
  });
});

test('Darwin exiting child retains its observed CPU across the recorded R to ?E transition', () => {
  const childStarted = 'Wed Sep 16 12:36:39 2026';
  const rootStarted = 'Wed Sep 16 12:36:38 2026';
  // Child identity/counters/state/command are qualification09 evidence. Root
  // counters and current RSS are synthetic: the failure diagnostic omitted RSS.
  const ledger = createOwnedCpuLedger(9039);
  ledger.observe(
    parsePsSnapshot(
      `9039 9038 0:00.47 1000 Rs ${rootStarted} Electron\n9048 9039 0:00.02 48416 R ${childStarted} /Users/tirish/.local/share/claude/versions/2.1.270`,
    ),
    485.042959,
  );
  const exiting = ledger.observe(
    parsePsSnapshot(
      `9039 9038 0:00.49 1000 Rs ${rootStarted} Electron\n9048 9039 0:00.00 0 ?E ${childStarted} (2.1.270)`,
    ),
    581.828042,
  );
  assert.equal(exiting.observedCumulativeCpuMs, 510);
  assert.equal(exiting.observedCpuDeltaMs, 20);
  assert.equal(exiting.observedProcessIdentities, 2);
  assert.equal(exiting.rssKb, 1000);
  assert.deepEqual(exiting.processes[1], {
    pid: 9048,
    ppid: 9039,
    cpuTimeText: '0:00.00',
    cpuTimeMs: 0,
    rssKb: 0,
    state: '?E',
    started: childStarted,
    command: '(2.1.270)',
  });
});

test('sampler accepts and retains the raw Darwin exiting collection without an error', async () => {
  const snapshots = [
    `200 1 0:00.10 1000 S ${started} Electron\n201 200 0:00.02 4000 R ${started} Child`,
    `200 1 0:00.12 1000 S ${started} Electron\n201 200 0:00.00 0 ?E ${started} (Child)`,
  ];
  const lastRead = Promise.withResolvers();
  const clocks = [0, 10, 20, 110, 120, 130];
  const sampler = startStartupSampler({
    pidFile: '/test/electron.pid',
    parsePid: Number,
    launchStartedAt: 0,
    platform: 'darwin',
    monotonicNow: () => clocks.shift() ?? 140,
    readPidFile: async () => '200',
    executePs: async () => {
      const stdout = snapshots.shift();
      if (!snapshots.length) lastRead.resolve();
      return { stdout };
    },
    wait: async () => {},
  });
  await lastRead.promise;
  const raw = await sampler.stop();
  assert.equal(raw.error, null);
  assert.equal(raw.failureDiagnostic, null);
  assert.equal(raw.samples.length, 2);
  assert.equal(raw.samples[1].observedCumulativeCpuMs, 140);
  assert.equal(raw.samples[1].processes[1].cpuTimeText, '0:00.00');
  assert.equal(raw.samples[1].processes[1].state, '?E');
  assert.equal(raw.samples[1].collectionStartedMs, 120);
  assert.equal(raw.samples[1].collectionCompletedMs, 130);
});

test('Darwin exiting accounting recognizes valid state modifiers independently of command text', () => {
  for (const state of [
    '?E',
    'RE',
    'UE',
    'SE',
    'IE',
    'TE',
    'HE',
    '?<XEVLs+',
    '?NXEVLs+',
  ]) {
    const ledger = createOwnedCpuLedger(200);
    ledger.observe([row(200, 1, 100), row(201, 200, 20)], 100);
    const current = row(201, 200, 0, 7, started, { state, command: 'Child' });
    const sample = ledger.observe([row(200, 1, 110), current], 200);
    assert.equal(sample.observedCumulativeCpuMs, 130, state);
    assert.equal(sample.rssKb, 1031, state);
    assert.deepEqual(sample.processes[1], current, state);
  }
});

test('Darwin exiting accounting repeats, reconciles upward, progresses to zombie and survives disappearance', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 20)], 100);
  const samples = [
    {
      at: 200,
      root: 110,
      cpu: 0,
      state: '?E',
      command: '(Child)',
      total: 130,
      delta: 10,
    },
    {
      at: 300,
      root: 120,
      cpu: 30,
      state: 'RE',
      command: 'Child',
      total: 150,
      delta: 20,
    },
    {
      at: 400,
      root: 130,
      cpu: 0,
      state: '?E',
      command: '(Child)',
      total: 160,
      delta: 10,
    },
    {
      at: 500,
      root: 140,
      cpu: 0,
      state: 'Z+',
      command: '<defunct>',
      total: 170,
      delta: 10,
    },
  ];
  for (const { at, root, cpu, state, command, total, delta } of samples) {
    const current = row(201, 1, cpu, 0, started, { state, command });
    const sample = ledger.observe([row(200, 1, root), current], at);
    assert.equal(sample.observedCumulativeCpuMs, total);
    assert.equal(sample.observedCpuDeltaMs, delta);
    assert.equal(sample.observedProcessIdentities, 2);
    assert.deepEqual(sample.processes[1], current);
  }
  const absent = ledger.observe([row(200, 1, 150)], 600);
  assert.equal(absent.observedCumulativeCpuMs, 180);
  assert.equal(absent.observedCpuDeltaMs, 10);
});

test('Darwin exiting rows first seen as owned contribute only observed CPU and cannot become live', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100)], 100);
  const first = ledger.observe(
    [
      row(200, 1, 110),
      row(201, 200, 0, 0, started, {
        state: '?E',
        command: '(Electron Helper)',
      }),
    ],
    200,
  );
  assert.equal(first.observedCumulativeCpuMs, 110);
  assert.equal(first.observedProcessIdentities, 2);
  assert.throws(
    () => ledger.observe([row(200, 1, 120), row(201, 200, 20)], 300),
    /Owned terminal process identity became nonterminal/,
  );
  const differentStart = 'Fri Sep 11 12:35:00 2026';
  const foreignReuse = ledger.observe(
    [
      row(200, 1, 120),
      row(201, 500, 0, 0, differentStart, { state: '?E' }),
      row(501, 500, 0, 0, started, { state: '?E' }),
    ],
    300,
  );
  assert.deepEqual(
    foreignReuse.processes.map(({ pid }) => pid),
    [200],
  );
  assert.equal(foreignReuse.observedCumulativeCpuMs, 120);
  const ownedReuse = ledger.observe(
    [row(200, 1, 130), row(201, 200, 10, 0, differentStart, { state: 'RE' })],
    400,
  );
  assert.equal(ownedReuse.observedProcessIdentities, 3);
  assert.equal(ownedReuse.observedCumulativeCpuMs, 140);
});

test('Darwin exiting exception rejects live, ambiguous and malformed state decreases', () => {
  for (const state of [
    'R',
    'S',
    '?',
    'E',
    'ZE',
    '?EE',
    '?EX',
    '?EN',
    '?VE',
    '?EsL',
    '?E++',
    '?Egarbage',
    '?<>E',
  ]) {
    const ledger = createOwnedCpuLedger(200);
    ledger.observe([row(200, 1, 100), row(201, 200, 20)], 100);
    assert.throws(
      () =>
        ledger.observe(
          [
            row(200, 1, 120),
            row(201, 200, 0, 0, started, { state, command: '(Child)' }),
          ],
          200,
        ),
      /Owned process cumulative CPU decreased/,
      state,
    );
    const recovered = ledger.observe(
      [row(200, 1, 110), row(201, 200, 30)],
      200,
    );
    assert.equal(recovered.observedCumulativeCpuMs, 140, state);
    assert.equal(recovered.observedCpuDeltaMs, 20, state);
  }
  const root = createOwnedCpuLedger(200);
  root.observe([row(200, 1, 20)], 100);
  assert.throws(
    () =>
      root.observe(
        [row(200, 1, 0, 0, started, { state: '?E', command: '(Electron)' })],
        200,
      ),
    /Owned process cumulative CPU decreased/,
  );
});

test('Darwin exiting and zombie progression rejects regressions using the latest raw terminal diagnostic', () => {
  for (const terminal of [
    { state: '?E', command: '(Child)', nextState: '?' },
    { state: '?E', command: '(Child)', nextState: 'S' },
    { state: 'Z+', command: '<defunct>', nextState: '?E' },
  ]) {
    const ledger = createOwnedCpuLedger(200);
    ledger.observe([row(200, 1, 100), row(201, 200, 20)], 100);
    const terminalRow = row(201, 200, 0, 0, started, terminal);
    ledger.observe([row(200, 1, 110), terminalRow], 200, {
      collectionStartedMs: 180,
      collectionCompletedMs: 200,
    });
    ledger.observe([row(200, 1, 120), terminalRow], 300, {
      collectionStartedMs: 280,
      collectionCompletedMs: 300,
    });
    let error;
    assert.throws(() => {
      try {
        ledger.observe(
          [
            row(200, 1, 130),
            row(201, 200, 30, 1, started, { state: terminal.nextState }),
          ],
          400,
          { collectionStartedMs: 380, collectionCompletedMs: 400 },
        );
      } catch (caught) {
        error = caught;
        throw caught;
      }
    }, /Owned terminal process identity became nonterminal/);
    assert.equal(
      error.failureDiagnostic.kind,
      'owned-terminal-identity-became-nonterminal',
    );
    assert.deepEqual(error.failureDiagnostic.identity, { pid: 201, started });
    assert.equal(error.failureDiagnostic.prior.cpuTimeMs, 0);
    assert.equal(error.failureDiagnostic.prior.state, terminal.state);
    assert.equal(error.failureDiagnostic.prior.collectionStartedMs, 280);
    assert.equal(error.failureDiagnostic.current.state, terminal.nextState);
    assert.equal(error.failureDiagnostic.current.collectionCompletedMs, 400);
    const recovered = ledger.observe([row(200, 1, 130), terminalRow], 400);
    assert.equal(recovered.observedCumulativeCpuMs, 150);
    assert.equal(recovered.observedCpuDeltaMs, 10);
  }
});

test('rejected collection cannot commit a Darwin exiting transition before a later live decrease', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 20), row(202, 200, 50)], 100);
  assert.throws(
    () =>
      ledger.observe(
        [
          row(200, 1, 140),
          row(201, 200, 0, 0, started, { state: '?E' }),
          row(202, 200, 0),
        ],
        200,
      ),
    /Owned process cumulative CPU decreased/,
  );
  const recovered = ledger.observe(
    [row(200, 1, 110), row(201, 200, 30), row(202, 200, 60)],
    200,
  );
  assert.equal(recovered.observedCumulativeCpuMs, 200);
  assert.equal(recovered.observedCpuDeltaMs, 30);
  assert.equal(recovered.intervalMs, 100);
});

test('sampler catch retains a bounded decrease diagnostic without accepting the rejected collection', async () => {
  const snapshots = [
    `200 1 0:00.10 1000 S ${started} Electron\n201 200 0:00.25 4608 S ${started} Child`,
    `200 1 0:00.12 1000 S ${started} Electron\n201 200 0:00.00 0 S ${started} Child`,
  ];
  const clocks = [0, 10, 20, 110, 120];
  const sampler = startStartupSampler({
    pidFile: '/test/electron.pid',
    parsePid: Number,
    launchStartedAt: 0,
    platform: 'darwin',
    monotonicNow: () => clocks.shift() ?? 130,
    readPidFile: async () => '200',
    executePs: async () => ({ stdout: snapshots.shift() }),
    wait: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const raw = await sampler.stop();
  assert.match(raw.error, /Owned process cumulative CPU decreased/);
  assert.equal(raw.samples.length, 1);
  assert.equal(raw.failureDiagnostic.schemaVersion, 1);
  assert.equal(
    raw.failureDiagnostic.kind,
    'owned-process-cumulative-cpu-decreased',
  );
  assert.deepEqual(raw.failureDiagnostic.rootIdentity, { pid: 200, started });
  assert.deepEqual(raw.failureDiagnostic.identity, { pid: 201, started });
  assert.deepEqual(raw.failureDiagnostic.prior, {
    cpuTimeText: '0:00.25',
    cpuTimeMs: 250,
    ppid: 200,
    state: 'S',
    command: 'Child',
    commandTruncated: false,
    collectionStartedMs: 10,
    collectionCompletedMs: 20,
  });
  assert.deepEqual(raw.failureDiagnostic.current, {
    cpuTimeText: '0:00.00',
    cpuTimeMs: 0,
    ppid: 200,
    state: 'S',
    command: 'Child',
    commandTruncated: false,
    collectionStartedMs: 120,
    collectionCompletedMs: 130,
  });
  assert.equal(raw.failureDiagnostic.deltaMs, -250);
  assert.deepEqual(raw.failureDiagnostic.collection, {
    startedMs: 120,
    completedMs: 130,
    costMs: 10,
    parsedRowCount: 2,
    ownedRowCount: 2,
    ledgerIdentityCount: 2,
  });
});

for (const { label, pidPolls: initialPidPolls } of [
  { label: 'immediate PID', pidPolls: ['200'] },
  { label: 'one ENOENT poll before PID', pidPolls: [null, '200'] },
]) {
  test(`sampler default clock retains its Performance receiver (${label})`, async () => {
    const pidPolls = [...initialPidPolls];
    const snapshot = `200 1 0:00.10 1000 S ${started} Electron`;
    let psCalls = 0;
    const sampler = startStartupSampler({
      pidFile: '/test/electron.pid',
      parsePid: Number,
      launchStartedAt: 0,
      platform: 'darwin',
      readPidFile: async () => {
        const next = pidPolls.shift();
        if (next === null)
          throw Object.assign(new Error('PID file is not present yet'), {
            code: 'ENOENT',
          });
        return next;
      },
      executePs: async () => {
        psCalls += 1;
        return { stdout: snapshot };
      },
      wait: async () => {
        if (psCalls > 0) await new Promise((resolve) => setImmediate(resolve));
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    const raw = await sampler.stop();
    assert.equal(raw.error, null);
    assert.equal(pidPolls.length, 0);
    assert.equal(psCalls, 1);
    assert.equal(raw.samples.length, 1);
    assert.ok(Number.isFinite(raw.pidObservedMs));
    assert.equal(raw.rootPid, 200);
  });
}

test('terminal accounting repeats, reconciles upward, and never invents unseen zombie CPU', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 250, 4608)], 100);
  const zero = (cpuTimeMs = 0) =>
    row(201, 200, cpuTimeMs, 0, started, {
      state: 'Z',
      command: '<defunct>',
      cpuTimeText: `0:00.${String(cpuTimeMs / 10).padStart(2, '0')}`,
    });
  assert.equal(
    ledger.observe([row(200, 1, 120), zero()], 200).observedCumulativeCpuMs,
    370,
  );
  assert.equal(
    ledger.observe([row(200, 1, 130), zero()], 300).observedCumulativeCpuMs,
    380,
  );
  assert.equal(
    ledger.observe([row(200, 1, 140)], 400).observedCumulativeCpuMs,
    390,
  );

  const reconciled = createOwnedCpuLedger(200);
  reconciled.observe([row(200, 1, 100), row(201, 200, 250)], 100);
  reconciled.observe([row(200, 1, 110), zero(260)], 200);
  const afterLowerTerminal = reconciled.observe(
    [row(200, 1, 120), zero()],
    300,
  );
  assert.equal(afterLowerTerminal.observedCumulativeCpuMs, 380);
  assert.equal(afterLowerTerminal.processes.at(-1).cpuTimeMs, 0);

  const unseen = createOwnedCpuLedger(200);
  unseen.observe([row(200, 1, 100)], 100);
  const firstTerminal = unseen.observe([row(200, 1, 110), zero()], 200);
  assert.equal(firstTerminal.observedCumulativeCpuMs, 110);
  assert.equal(firstTerminal.rssKb, 1024);
  assert.equal(firstTerminal.observedProcessIdentities, 2);
  const foreign = unseen.observe(
    [
      row(200, 1, 120),
      row(501, 500, 0, 0, started, { state: 'Z', command: '<defunct>' }),
    ],
    300,
  );
  assert.deepEqual(
    foreign.processes.map((entry) => entry.pid),
    [200],
  );
  const unseenResurrection = createOwnedCpuLedger(200);
  unseenResurrection.observe([row(200, 1, 100)], 100);
  unseenResurrection.observe([row(200, 1, 110), zero()], 200);
  assert.throws(
    () => unseenResurrection.observe([row(200, 1, 120), row(201, 200, 1)], 300),
    /Owned terminal process identity became nonterminal/,
  );
});

test('terminal boundary controls reject active resets and resurrection without mutating the ledger', () => {
  const cases = [
    row(201, 200, 0, 0, started, { state: 'S', command: 'Child' }),
    row(201, 200, 0, 0, started, { state: 'Z', command: 'Child' }),
    row(201, 200, 0, 0, started, { state: 'S', command: '<defunct>' }),
  ];
  for (const currentChild of cases) {
    const ledger = createOwnedCpuLedger(200);
    ledger.observe([row(200, 1, 100), row(201, 200, 250)], 100, {
      collectionStartedMs: 1,
      collectionCompletedMs: 2,
    });
    let error;
    assert.throws(() => {
      try {
        ledger.observe([row(200, 1, 120), currentChild], 200, {
          collectionStartedMs: 3,
          collectionCompletedMs: 4,
        });
      } catch (caught) {
        error = caught;
        throw caught;
      }
    }, /Owned process cumulative CPU decreased/);
    assert.equal(
      error.failureDiagnostic.kind,
      'owned-process-cumulative-cpu-decreased',
    );
    assert.equal(error.failureDiagnostic.prior.collectionStartedMs, 1);
    assert.equal(error.failureDiagnostic.current.collectionCompletedMs, 4);
    assert.equal(
      ledger.observe([row(200, 1, 120), row(201, 200, 260)], 200)
        .observedCumulativeCpuMs,
      380,
    );
  }

  const rootDecrease = createOwnedCpuLedger(200);
  rootDecrease.observe([row(200, 1, 250)], 100);
  assert.throws(
    () =>
      rootDecrease.observe(
        [row(200, 1, 0, 0, started, { state: 'Z', command: '<defunct>' })],
        200,
      ),
    /Owned process cumulative CPU decreased/,
  );

  const resurrection = createOwnedCpuLedger(200);
  resurrection.observe([row(200, 1, 100), row(201, 200, 250)], 100);
  resurrection.observe(
    [
      row(200, 1, 110),
      row(201, 200, 0, 0, started, { state: 'Z', command: '<defunct>' }),
    ],
    200,
  );
  let error;
  assert.throws(() => {
    try {
      resurrection.observe([row(200, 1, 120), row(201, 200, 260)], 300);
    } catch (caught) {
      error = caught;
      throw caught;
    }
  }, /Owned terminal process identity became nonterminal/);
  assert.equal(
    error.failureDiagnostic.kind,
    'owned-terminal-identity-became-nonterminal',
  );
  assert.equal(
    resurrection.observe(
      [
        row(200, 1, 120),
        row(201, 200, 0, 0, started, { state: 'Z', command: '<defunct>' }),
      ],
      300,
    ).observedCumulativeCpuMs,
    370,
  );

  const olderPrior = createOwnedCpuLedger(200);
  olderPrior.observe([row(200, 1, 100), row(201, 200, 250)], 100, {
    collectionStartedMs: 10,
    collectionCompletedMs: 20,
  });
  olderPrior.observe([row(200, 1, 110)], 200, {
    collectionStartedMs: 30,
    collectionCompletedMs: 40,
  });
  let olderPriorError;
  assert.throws(() => {
    try {
      olderPrior.observe(
        [
          row(200, 1, 120),
          row(201, 1, 0, 0, started, {
            command: 'x'.repeat(2048),
          }),
        ],
        300,
        {
          collectionStartedMs: 50,
          collectionCompletedMs: 60,
        },
      );
    } catch (caught) {
      olderPriorError = caught;
      throw caught;
    }
  }, /Owned process cumulative CPU decreased/);
  assert.equal(olderPriorError.failureDiagnostic.prior.collectionStartedMs, 10);
  assert.equal(olderPriorError.failureDiagnostic.current.command.length, 1024);
  assert.equal(
    olderPriorError.failureDiagnostic.current.commandTruncated,
    true,
  );
});

test('rejected observations cannot leak ledger or terminal-map state into recovery', () => {
  const activeRecovery = createOwnedCpuLedger(200);
  activeRecovery.observe([row(200, 1, 100), row(201, 200, 250)], 100);
  assert.throws(
    () => activeRecovery.observe([row(200, 1, 140), row(201, 200, 0)], 200),
    /Owned process cumulative CPU decreased/,
  );
  const afterActiveRecovery = activeRecovery.observe(
    [row(200, 1, 120), row(201, 200, 260)],
    200,
  );
  assert.equal(afterActiveRecovery.observedCumulativeCpuMs, 380);
  assert.equal(afterActiveRecovery.observedCpuDeltaMs, 30);
  assert.equal(afterActiveRecovery.intervalMs, 100);

  const terminalRecovery = createOwnedCpuLedger(200);
  terminalRecovery.observe(
    [row(200, 1, 100), row(201, 200, 250), row(202, 200, 50)],
    100,
  );
  assert.throws(
    () =>
      terminalRecovery.observe(
        [
          row(200, 1, 140),
          row(201, 200, 0, 0, started, {
            state: 'Z',
            command: '<defunct>',
          }),
          row(202, 200, 0),
        ],
        200,
      ),
    /Owned process cumulative CPU decreased/,
  );
  const afterTerminalRecovery = terminalRecovery.observe(
    [row(200, 1, 120), row(201, 200, 260), row(202, 200, 60)],
    200,
  );
  assert.equal(afterTerminalRecovery.observedCumulativeCpuMs, 440);
  assert.equal(afterTerminalRecovery.observedCpuDeltaMs, 40);
  assert.equal(afterTerminalRecovery.intervalMs, 100);
});

test('resurrection diagnostics use the latest raw terminal observation and exact identity', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 250)], 100, {
    collectionStartedMs: 10,
    collectionCompletedMs: 20,
  });
  ledger.observe(
    [
      row(200, 1, 110),
      row(201, 200, 0, 0, started, {
        state: 'Z',
        command: '<defunct>',
        cpuTimeText: '0:00.00',
      }),
    ],
    200,
    { collectionStartedMs: 30, collectionCompletedMs: 40 },
  );
  ledger.observe(
    [
      row(200, 1, 120),
      row(201, 200, 0, 0, started, {
        state: 'Z+',
        command: '<defunct>',
        cpuTimeText: '0:00.00',
      }),
    ],
    300,
    { collectionStartedMs: 50, collectionCompletedMs: 60 },
  );
  let error;
  assert.throws(() => {
    try {
      ledger.observe(
        [row(200, 1, 130), row(201, 200, 260, 512, started, { state: 'S' })],
        400,
        { collectionStartedMs: 70, collectionCompletedMs: 80 },
      );
    } catch (caught) {
      error = caught;
      throw caught;
    }
  }, /Owned terminal process identity became nonterminal/);
  assert.deepEqual(error.failureDiagnostic.identity, { pid: 201, started });
  assert.deepEqual(error.failureDiagnostic.prior, {
    cpuTimeText: '0:00.00',
    cpuTimeMs: 0,
    ppid: 200,
    state: 'Z+',
    command: '<defunct>',
    commandTruncated: false,
    collectionStartedMs: 50,
    collectionCompletedMs: 60,
  });
  assert.deepEqual(error.failureDiagnostic.current, {
    cpuTimeText: '260ms',
    cpuTimeMs: 260,
    ppid: 200,
    state: 'S',
    command: '/Applications/Electron Helper (Renderer)',
    commandTruncated: false,
    collectionStartedMs: 70,
    collectionCompletedMs: 80,
  });

  const differentStarted = createOwnedCpuLedger(200);
  differentStarted.observe([row(200, 1, 100), row(201, 200, 250)], 100);
  differentStarted.observe(
    [
      row(200, 1, 110),
      row(201, 200, 0, 0, started, { state: 'Z', command: '<defunct>' }),
    ],
    200,
  );
  const differentIdentity = differentStarted.observe(
    [
      row(200, 1, 120),
      row(201, 200, 20, 256, 'Fri Sep 11 12:35:00 2026', { state: 'S' }),
    ],
    300,
  );
  assert.equal(differentIdentity.observedCumulativeCpuMs, 390);
  assert.equal(
    differentIdentity.processes.at(-1).started,
    'Fri Sep 11 12:35:00 2026',
  );
});

test('diagnostic string bounds apply to prior and current observations', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe(
    [
      row(200, 1, 100),
      row(201, 200, 250, 1024, started, {
        state: `S${'a'.repeat(128)}`,
        command: 'p'.repeat(2048),
        cpuTimeText: 't'.repeat(129),
      }),
    ],
    100,
  );
  let error;
  assert.throws(() => {
    try {
      ledger.observe(
        [
          row(200, 1, 110),
          row(201, 200, 0, 0, started, {
            state: `R${'b'.repeat(128)}`,
            command: 'c'.repeat(2048),
            cpuTimeText: 'u'.repeat(129),
          }),
        ],
        200,
      );
    } catch (caught) {
      error = caught;
      throw caught;
    }
  }, /Owned process cumulative CPU decreased/);
  for (const observation of [
    error.failureDiagnostic.prior,
    error.failureDiagnostic.current,
  ]) {
    assert.equal(observation.cpuTimeText.length, 128);
    assert.equal(observation.state.length, 128);
    assert.equal(observation.command.length, 1024);
    assert.equal(observation.commandTruncated, true);
  }
});

test('post-implementation negative control proves removal of the resurrection guard admits the forbidden row', async () => {
  const source = await readFile(
    new URL('./browser-profiles-startup-sampler.mjs', import.meta.url),
    'utf8',
  );
  const mutated = source.replace(
    'if (terminalRegression)',
    'if (false && terminalRegression)',
  );
  assert.notEqual(mutated, source, 'Scoped resurrection mutation must apply');
  const { createOwnedCpuLedger: createMutatedLedger } = await import(
    `data:text/javascript,${encodeURIComponent(mutated)}`
  );
  const ledger = createMutatedLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 250)], 100);
  ledger.observe(
    [
      row(200, 1, 110),
      row(201, 200, 0, 0, started, { state: 'Z', command: '<defunct>' }),
    ],
    200,
  );
  assert.doesNotThrow(() =>
    ledger.observe([row(200, 1, 120), row(201, 200, 260)], 300),
  );
});

test('resource ownership follows descendants in arbitrary order, excluding launcher and foreign Electron trees', () => {
  const sample = createOwnedCpuLedger(200).observe(
    [
      row(202, 201, 30, 300),
      row(501, 500, 9000, 9000),
      row(100, 1, 7000, 7000),
      row(200, 100, 100, 1000),
      row(500, 1, 8000, 8000),
      row(201, 200, 50, 500),
    ],
    100,
  );
  assert.deepEqual(
    sample.processes.map((entry) => entry.pid).sort(),
    [200, 201, 202],
  );
  assert.equal(sample.rssKb, 1800);
  assert.equal(sample.observedCumulativeCpuMs, 180);
  assert.equal(sample.observedCpuPercent, null);
  assert.equal(sample.observedCpuDeltaMs, null);
});

test('CPU remains monotonic when a busy child exits; resident memory drops and new children contribute cumulative CPU', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100, 1000), row(201, 200, 300, 500)], 100);
  const afterExit = ledger.observe([row(200, 1, 120, 1000)], 200);
  assert.equal(afterExit.observedCumulativeCpuMs, 420);
  assert.equal(afterExit.observedCpuDeltaMs, 20);
  assert.equal(afterExit.observedCpuPercent, 20);
  assert.equal(afterExit.rssKb, 1000);
  const newChild = ledger.observe(
    [row(200, 1, 150, 1000), row(202, 200, 40, 600)],
    300,
  );
  assert.equal(newChild.observedCumulativeCpuMs, 490);
  assert.equal(newChild.observedCpuDeltaMs, 70);
});

test('reparented known descendants remain owned; reused foreign child PIDs do not', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100), row(201, 200, 300)], 100);
  assert.equal(
    ledger.observe([row(200, 1, 110), row(201, 1, 320)], 200)
      .observedCumulativeCpuMs,
    430,
  );
  const foreignReuse = ledger.observe(
    [row(200, 1, 120), row(201, 1, 9000, 9999, 'Fri Sep 11 12:35:00 2026')],
    300,
  );
  assert.deepEqual(
    foreignReuse.processes.map((entry) => entry.pid),
    [200],
  );
  assert.equal(foreignReuse.observedCumulativeCpuMs, 440);
});

test('missing resources, root loss, PID reuse and counter regression cannot become successful zero samples', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100)], 100);
  assert.throws(() => ledger.observe([row(200, 1, 99)], 200), /decreased/);
  assert.throws(() => ledger.observe([row(200, 1, undefined)], 200), /Missing/);
  assert.throws(
    () =>
      ledger.observe(
        [row(200, 1, 120, undefined)].map((entry) => ({
          ...entry,
          rssKb: null,
        })),
        200,
      ),
    /Missing/,
  );
  assert.throws(() => ledger.observe([row(201, 1, 120)], 200), /root missing/);
  assert.throws(
    () =>
      ledger.observe([row(200, 1, 120, 1024, 'Fri Sep 11 12:35:00 2026')], 200),
    /PID reused/,
  );
  assert.throws(() => ledger.observe([row(200, 1, 120)], 100), /Non-monotonic/);
});

test('startup acceptance rejects absent, late, incomplete or failed pre-window sampling', () => {
  const early = (atMs) => ({
    atMs,
    collectionCompletedMs: atMs,
    observedCumulativeCpuMs: atMs * 2,
    rssKb: 1024 + atMs,
  });
  const raw = {
    pidObservedMs: 10,
    error: null,
    samples: [early(30), early(130), early(230)],
  };
  assert.deepEqual(assertEarlyStartupCoverage(raw, 200), {
    preWindowSampleCount: 2,
    firstSampleMs: 30,
    lastPreWindowSampleMs: 130,
    preWindowObservedCumulativeCpuMs: 260,
    preWindowPeakRssKb: 1154,
  });
  assert.throws(
    () => assertEarlyStartupCoverage({ ...raw, samples: [] }, 200),
    /coverage invalid/,
  );
  assert.throws(() => assertEarlyStartupCoverage(raw, 100), /coverage invalid/);
  assert.throws(
    () => assertEarlyStartupCoverage({ ...raw, error: 'ps timed out' }, 200),
    /ps timed out/,
  );
  assert.throws(
    () => assertEarlyStartupCoverage({ ...raw, pidObservedMs: null }, 200),
    /coverage invalid/,
  );
  assert.throws(
    () => assertEarlyStartupCoverage(raw, undefined),
    /coverage invalid/,
  );
});

test('every app metric batch is validated, including a new process after an initially valid batch', async () => {
  const valid = {
    pid: 200,
    cpu: { percentCPUUsage: 4 },
    memory: { workingSetSize: 2048 },
  };
  const batches = [
    [valid],
    [valid, { pid: 201, memory: { workingSetSize: 100 } }],
    [valid, { pid: 202, cpu: { percentCPUUsage: 2 } }],
    [{ ...valid, cpu: { percentCPUUsage: NaN } }],
    [{ ...valid, memory: { workingSetSize: -1 } }],
    [],
    [
      valid,
      { pid: 203, cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } },
    ],
  ];
  const callback = () => 'fixture';
  const source = createValidatedAppMetricSource({
    async evaluate(received) {
      assert.equal(received, callback);
      return batches.shift();
    },
  });
  assert.deepEqual(await source.evaluate(callback), [valid]);
  for (let index = 0; index < 5; index++)
    await assert.rejects(
      () => source.evaluate(callback),
      /App resource sample/,
    );
  // Explicit, genuinely reported zero is valid; unavailable is never substituted.
  const final = await source.evaluate(callback);
  assert.equal(final[1].cpu.percentCPUUsage, 0);
  assert.equal(final[1].memory.workingSetSize, 0);
});

test('CPU ledger-delta rate includes newly discovered pre-interval CPU and preserves its legacy alias', () => {
  const ledger = createOwnedCpuLedger(200);
  ledger.observe([row(200, 1, 100)], 100);
  const sample = ledger.observe([row(200, 1, 110), row(201, 200, 1000)], 200);
  assert.equal(sample.observedCpuLedgerDeltaRatePercent, 1010);
  assert.equal(
    sample.observedCpuPercent,
    sample.observedCpuLedgerDeltaRatePercent,
  );
  // This is a ledger update rate: it cannot assert that the child consumed all
  // of its observed 1000ms within this 100ms observation interval.
  assert.equal(sample.observedCpuDeltaMs, 1010);
});
