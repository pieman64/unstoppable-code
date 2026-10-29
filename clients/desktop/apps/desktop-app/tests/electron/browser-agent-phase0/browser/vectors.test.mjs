import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregate,
  buildCases,
  classifyCase,
  STATUS,
  VECTOR_IDS,
  VECTORS,
} from './vectors.mjs';

const none = () => ({
  exercised: true,
  destinationHits: 0,
  listenerDenies: [],
  gatewayDenies: [],
  handlerEvents: [],
});

test('every required vector has leased cases in both bindings', () => {
  for (const binding of ['shared', 'task']) {
    const cases = buildCases(binding);
    for (const id of VECTOR_IDS) {
      assert.ok(
        cases.some((entry) => entry.vector === id && entry.tab === 'leased'),
        `${binding} lacks ${id}`,
      );
    }
    assert.equal(
      new Set(cases.map((entry) => entry.caseId)).size,
      cases.length,
    );
  }
});

test('only the shared binding has control-tab non-interference cases', () => {
  assert.ok(buildCases('shared').some((entry) => entry.tab === 'control'));
  assert.ok(!buildCases('task').some((entry) => entry.tab === 'control'));
  for (const entry of buildCases('shared').filter((c) => c.tab === 'control')) {
    assert.equal(entry.expect, 'allow');
  }
});

test('the matrix never targets a non-synthetic name or a real scheme handler', () => {
  for (const entry of [...buildCases('shared'), ...buildCases('task')]) {
    const target = String(entry.target);
    if (target.startsWith('{vector}')) continue;
    const url = new URL(target.replaceAll(/\{[a-z]+\}/g, '1'));
    if (url.protocol === 's03-probe-unregistered:') continue;
    assert.ok(
      url.hostname === '127.0.0.1' ||
        url.hostname === '[::ffff:7f00:1]' ||
        url.hostname.endsWith('.s03.test'),
      `${entry.caseId} targets ${url.hostname}`,
    );
  }
});

test('an unexercised case is unobserved, never pass', () => {
  const spec = buildCases('task').find(
    (entry) => entry.vector === 'fetch.page',
  );
  const result = classifyCase(spec, {
    ...none(),
    exercised: false,
    error: 'timeout',
  });
  assert.equal(result.status, STATUS.unobserved);
});

test('a leased denial without any mechanism evidence is unobserved', () => {
  const spec = buildCases('task').find(
    (entry) => entry.caseId === 'task:fetch.page:literal',
  );
  assert.equal(classifyCase(spec, none()).status, STATUS.unobserved);
});

test('a destination hit is a leak regardless of denials', () => {
  const spec = buildCases('task').find(
    (entry) => entry.caseId === 'task:fetch.page:literal',
  );
  const result = classifyCase(spec, {
    ...none(),
    destinationHits: 1,
    listenerDenies: [{ attributed: true }],
  });
  assert.equal(result.status, STATUS.fail);
});

test('resolved-address cases require a gateway denial, not a URL-layer cancel', () => {
  const spec = buildCases('task').find(
    (entry) => entry.caseId === 'task:address.resolved-name:fetch',
  );
  assert.equal(
    classifyCase(spec, { ...none(), listenerDenies: [{ attributed: true }] })
      .status,
    STATUS.unobserved,
  );
  assert.equal(
    classifyCase(spec, {
      ...none(),
      gatewayDenies: [{ attributed: false, addressClass: 'loopback' }],
    }).status,
    STATUS.pass,
  );
});

test('shared binding needs attribution; task binding is session scoped', () => {
  const shared = buildCases('shared').find(
    (entry) => entry.caseId === 'shared:address.resolved-name:fetch',
  );
  const task = buildCases('task').find(
    (entry) => entry.caseId === 'task:address.resolved-name:fetch',
  );
  const unattributed = {
    ...none(),
    gatewayDenies: [{ attributed: false, addressClass: 'loopback' }],
  };
  assert.equal(classifyCase(shared, unattributed).status, STATUS.unobserved);
  assert.equal(classifyCase(task, unattributed).status, STATUS.pass);
});

test('control cases fail on collateral denial and pass only when reached', () => {
  const spec = buildCases('shared').find(
    (entry) => entry.caseId === 'shared:fetch.page:control-user-service',
  );
  assert.equal(
    classifyCase(spec, { ...none(), destinationHits: 1 }).status,
    STATUS.pass,
  );
  assert.equal(
    classifyCase(spec, {
      ...none(),
      destinationHits: 0,
      gatewayDenies: [{ attributed: false, addressClass: 'loopback' }],
    }).status,
    STATUS.fail,
  );
  assert.equal(classifyCase(spec, none()).status, STATUS.unobserved);
});

test('handler cases need an attributed denial and no observed capability', () => {
  const spec = buildCases('shared').find(
    (entry) => entry.caseId === 'shared:popup.deny:window-open',
  );
  assert.equal(classifyCase(spec, none()).status, STATUS.unobserved);
  const denied = {
    ...none(),
    handlerEvents: [{ kind: 'popup', decision: 'deny', attributed: true }],
  };
  assert.equal(
    classifyCase(spec, { ...denied, handlerSatisfied: true }).status,
    STATUS.pass,
  );
  assert.equal(
    classifyCase(spec, { ...denied, handlerSatisfied: false }).status,
    STATUS.fail,
  );
});

test('unsupported evidence is reported as unsupported', () => {
  const spec = buildCases('task').find(
    (entry) => entry.vector === 'chooser.device',
  );
  assert.equal(
    classifyCase(spec, { ...none(), unsupported: 'no WebUSB' }).status,
    STATUS.unsupported,
  );
});

test('aggregate is unqualified when any vector is unproved and lists refusals', () => {
  const results = [];
  for (const binding of ['shared', 'task']) {
    for (const entry of VECTORS) {
      results.push({
        binding,
        vector: entry.id,
        caseId: `${binding}:${entry.id}:x`,
        status: STATUS.pass,
        reason: '',
      });
    }
  }
  const allPass = aggregate(results, {
    platform: 'darwin',
    windowsEvidence: true,
  });
  assert.equal(allPass.qualified, true);
  assert.equal(allPass.productionCompositionQualified, false);

  const noWindows = aggregate(results, { platform: 'darwin' });
  assert.equal(noWindows.qualified, false);
  assert.equal(noWindows.platforms.win32, 'outstanding');

  results[0] = { ...results[0], status: STATUS.unobserved };
  const one = aggregate(results, { platform: 'darwin', windowsEvidence: true });
  assert.equal(one.qualified, false);
  assert.equal(one.bindings.shared.qualified, false);
  assert.deepEqual(one.bindings.shared.mustRefuse, [
    { vector: VECTORS[0].id, status: STATUS.unobserved },
  ]);
  assert.equal(one.bindings.task.qualified, true);
});

test('a vector with no cases is unobserved', () => {
  const summary = aggregate([], { platform: 'darwin', windowsEvidence: true });
  assert.equal(summary.qualified, false);
  assert.equal(
    summary.bindings.task.vectors['fetch.page'].status,
    STATUS.unobserved,
  );
});
