import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractEvidence, handlerSatisfied, redactUrl } from './evidence.mjs';

const base = {
  tabId: 7,
  leaseToken: 'lease-1',
  listener: [],
  gateway: [],
  handlers: [],
  destinationHits: 0,
  page: { exercised: true, outcome: 'rejected:TypeError', error: null },
};

test('keeps own and unattributed listener denials, drops other tabs', () => {
  const evidence = extractEvidence({
    ...base,
    spec: { tab: 'leased' },
    listener: [
      {
        webContentsId: 7,
        cancel: true,
        resourceType: 'xhr',
        reason: 'address-class:loopback',
      },
      { webContentsId: null, cancel: true, resourceType: 'other', reason: 'x' },
      { webContentsId: 9, cancel: true, resourceType: 'xhr', reason: 'x' },
      {
        webContentsId: 7,
        cancel: false,
        resourceType: 'mainFrame',
        reason: 'fixture-origin-exception',
      },
    ],
  });
  assert.deepEqual(
    evidence.listenerDenies.map((event) => event.attributed),
    [true, false],
  );
});

test('gateway denials are attributed only by the lease token', () => {
  const evidence = extractEvidence({
    ...base,
    spec: { tab: 'leased' },
    gateway: [
      {
        decision: 'deny',
        attribution: 'lease-1',
        addressClass: 'loopback',
        kind: 'http',
        reason: 'r',
      },
      {
        decision: 'deny',
        attribution: null,
        addressClass: 'loopback',
        kind: 'connect',
        reason: 'r',
      },
      {
        decision: 'allow',
        attribution: 'lease-1',
        addressClass: 'synthetic-public',
        kind: 'http',
        reason: 'r',
      },
    ],
  });
  assert.deepEqual(
    evidence.gatewayDenies.map((event) => event.attributed),
    [true, false],
  );
});

test('handler events are filtered to the handler kind under test', () => {
  const evidence = extractEvidence({
    ...base,
    spec: { tab: 'leased', handler: 'popup' },
    handlers: [
      { kind: 'popup', decision: 'deny', webContentsId: 7 },
      {
        kind: 'permission',
        decision: 'deny',
        webContentsId: 7,
        permission: 'geolocation',
      },
    ],
  });
  assert.deepEqual(evidence.handlerEvents, [
    { kind: 'popup', decision: 'deny', attributed: true },
  ]);
  assert.equal(evidence.handlerSatisfied, true);
});

test('control notifications case ignores unrelated permission checks', () => {
  const evidence = extractEvidence({
    ...base,
    spec: {
      tab: 'control',
      handler: 'permission',
      query: 'only=notifications',
    },
    page: { exercised: true, outcome: 'notifications:granted', error: null },
    handlers: [
      {
        kind: 'permission',
        decision: 'allow',
        webContentsId: 7,
        permission: 'notifications',
      },
      {
        kind: 'permission',
        decision: 'deny',
        webContentsId: 7,
        permission: 'storage-access',
      },
    ],
  });
  assert.deepEqual(evidence.handlerEvents, [
    { kind: 'permission', decision: 'allow', attributed: true },
  ]);
  assert.equal(evidence.handlerSatisfied, true);
});

test('usb unavailable is reported as unsupported', () => {
  const evidence = extractEvidence({
    ...base,
    spec: { tab: 'leased', handler: 'device' },
    page: { exercised: true, outcome: 'usb:unavailable', error: null },
  });
  assert.match(evidence.unsupported, /usb/);
});

test('handlerSatisfied inverts for control tabs', () => {
  const created = [{ kind: 'popup', decision: 'created' }];
  assert.equal(
    handlerSatisfied({ tab: 'leased', handler: 'popup' }, '', created),
    false,
  );
  assert.equal(
    handlerSatisfied({ tab: 'control', handler: 'popup' }, '', created),
    true,
  );
  assert.equal(
    handlerSatisfied(
      { tab: 'leased', handler: 'permission' },
      'geo:error:1|clipboard:resolved-content-discarded',
      [],
    ),
    false,
  );
  assert.equal(
    handlerSatisfied(
      { tab: 'leased', handler: 'permission' },
      'notifications:denied|clipboard:rejected:NotAllowedError',
      [],
    ),
    true,
  );
  assert.equal(
    handlerSatisfied(
      { tab: 'leased', handler: 'file-chooser' },
      'change:1',
      [],
    ),
    false,
  );
});

test('redactUrl strips credentials and query values', () => {
  assert.equal(
    redactUrl('http://u:p@public.s03.test/hit/a?x=1&y=2'),
    'http://redacted@public.s03.test/hit/a?[2%20params]',
  );
  assert.equal(redactUrl('not a url'), 'not a url');
});
