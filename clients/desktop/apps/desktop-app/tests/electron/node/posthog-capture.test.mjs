import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import {
  decodePostHogSnapshotData,
  decodedCaptureWire,
  mainReplaySince,
  readPostHogCapture,
  recordedAttributeValues,
  recordedChildren,
  replayNodes,
  startPostHogCapture,
} from '../posthogCapture.mjs';

test('decodes rrweb 2024-10 full snapshots, mutations, and stylesheet rules', () => {
  const encode = (value) => gzipSync(JSON.stringify(value)).toString('latin1');
  const raw = {
    event: '$snapshot',
    properties: {
      $snapshot_data: [
        {
          cv: '2024-10',
          type: 2,
          data: encode({ node: { type: 0, childNodes: [] } }),
        },
        {
          cv: '2024-10',
          type: 3,
          data: {
            source: 0,
            texts: encode([{ value: 'masked' }]),
            attributes: encode([]),
            removes: encode([]),
            adds: encode([]),
          },
        },
        {
          cv: '2024-10',
          type: 3,
          data: {
            source: 8,
            adds: encode([{ rule: '*{}' }]),
            removes: encode([]),
          },
        },
      ],
    },
  };
  const decoded = decodePostHogSnapshotData(raw);
  assert.deepEqual(decoded[0].data, { node: { type: 0, childNodes: [] } });
  assert.deepEqual(decoded[1].data.texts, [{ value: 'masked' }]);
  assert.deepEqual(decoded[1].data.attributes, []);
  assert.deepEqual(decoded[1].data.removes, []);
  assert.deepEqual(decoded[1].data.adds, []);
  assert.deepEqual(decoded[2].data.adds, [{ rule: '*{}' }]);
  assert.deepEqual(decoded[2].data.removes, []);
  assert.notEqual(decoded[0].data, raw.properties.$snapshot_data[0].data);
});

test('flattens replay nodes with parents and collects recorded attributes', () => {
  const decoded = [
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'div',
              attributes: { class: 'ph-no-capture', rr_width: '10px' },
              childNodes: [],
            },
            {
              type: 2,
              id: 3,
              tagName: 'style',
              attributes: { _cssText: 'a{color:red}' },
              childNodes: [{ type: 3, id: 4, textContent: 'masked' }],
            },
          ],
        },
      },
    },
    {
      type: 3,
      data: {
        source: 0,
        adds: [
          {
            parentId: 3,
            node: { type: 2, id: 5, tagName: 'span', attributes: {} },
          },
        ],
        attributes: [{ id: 2, attributes: { class: 'later', style: null } }],
      },
    },
  ];
  const nodes = replayNodes(decoded);
  assert.deepEqual(
    nodes.map((node) => [node.id, node.parentId]),
    [
      [1, undefined],
      [2, 1],
      [3, 1],
      [4, 3],
      [5, 3],
    ],
  );
  const style = nodes.find((node) => node.id === 3);
  assert.deepEqual(
    recordedChildren(nodes, style).map((node) => node.id),
    [4, 5],
  );
  assert.deepEqual(
    recordedChildren(
      nodes,
      nodes.find((node) => node.id === 2),
    ),
    [],
  );
  assert.deepEqual(recordedAttributeValues(decoded, 'class'), [
    'ph-no-capture',
    'later',
  ]);
  assert.deepEqual(recordedAttributeValues(decoded, '_cssText'), [
    'a{color:red}',
  ]);
  assert.deepEqual(recordedAttributeValues(decoded, 'style'), []);
});

test('reads main-window replay after an index and decodes snapshots for leak checks', () => {
  const encode = (value) => gzipSync(JSON.stringify(value)).toString('latin1');
  const snapshot = (surface, text) => ({
    event: '$snapshot',
    properties: {
      surface,
      $snapshot_data: [
        {
          cv: '2024-10',
          type: 2,
          data: encode({ node: { type: 3, id: 1, textContent: text } }),
        },
      ],
    },
  });
  const events = [
    snapshot('main', 'before'),
    { event: '$pageview', properties: { surface: 'main' } },
    snapshot('app-advisor', 'advisor'),
    snapshot('main', 'after'),
  ];
  const collector = { requests: [], events, parseErrors: [] };
  assert.deepEqual(
    mainReplaySince(collector, 1).map((event) => event.data.node.textContent),
    ['after'],
  );
  const wire = decodedCaptureWire(events);
  for (const text of ['before', 'advisor', 'after', '$pageview']) {
    assert.ok(wire.includes(text), text);
  }
});

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers,
    body,
  });
}

test('captures event and replay endpoint variants while retaining request paths', async () => {
  const collector = await startPostHogCapture({
    stubUrl: 'http://127.0.0.1:0',
  });
  try {
    const paths = [
      '/batch',
      '/batch/',
      '/batch?compression=json',
      '/e',
      '/e/',
      '/s',
      '/s/',
      '/i/v0/e/',
      '/i/v0/s/',
      '/i/v1/analytics/events',
    ];
    for (const [index, endpoint] of paths.entries()) {
      const response = await post(
        `${collector.url}${endpoint}`,
        JSON.stringify({ event: `event-${index}`, properties: { index } }),
        { 'content-type': 'application/json' },
      );
      assert.equal(response.status, 200);
    }

    const capture = readPostHogCapture(collector);
    assert.deepEqual(
      capture.events.map((event) => event.event),
      paths.map((_, index) => `event-${index}`),
    );
    assert.deepEqual(
      capture.requests.map((request) => request.path),
      paths,
    );
    assert.deepEqual(capture.parseErrors, []);
  } finally {
    await collector.shutdown();
  }
});

test('decodes gzip, form/base64 envelopes, arrays, and batch payloads', async () => {
  const collector = await startPostHogCapture({
    stubUrl: 'http://127.0.0.1:0',
  });
  try {
    await post(
      `${collector.url}/i/v0/e/?compression=gzip`,
      gzipSync(
        JSON.stringify({
          batch: [
            { event: 'gzip-one', properties: {} },
            { event: 'gzip-two', properties: {} },
          ],
        }),
      ),
      {
        'content-encoding': 'gzip',
        'content-type': 'application/json',
      },
    );
    const formPayload = Buffer.from(
      JSON.stringify([
        { event: 'form-one', properties: {} },
        { event: 'form-two', properties: {} },
      ]),
    ).toString('base64');
    await post(
      `${collector.url}/e`,
      new URLSearchParams({ data: formPayload }),
      { 'content-type': 'application/x-www-form-urlencoded' },
    );
    const compressedFormPayload = gzipSync(
      JSON.stringify({ event: 'form-gzip', properties: {} }),
    ).toString('base64');
    await post(
      `${collector.url}/e?compression=gzip`,
      new URLSearchParams({ data: compressedFormPayload }),
      { 'content-type': 'application/x-www-form-urlencoded' },
    );

    assert.deepEqual(
      readPostHogCapture(collector).events.map((event) => event.event),
      ['gzip-one', 'gzip-two', 'form-one', 'form-two', 'form-gzip'],
    );
    assert.deepEqual(readPostHogCapture(collector).parseErrors, []);
  } finally {
    await collector.shutdown();
  }
});

test('reports malformed payloads while ignoring preflight and empty requests', async () => {
  const collector = await startPostHogCapture({
    stubUrl: 'http://127.0.0.1:0',
  });
  try {
    const preflight = await fetch(`${collector.url}/e`, {
      method: 'OPTIONS',
    });
    assert.equal(preflight.status, 200);
    await post(`${collector.url}/e`, '', {
      'content-type': 'application/json',
    });
    await post(`${collector.url}/batch`, '{broken', {
      'content-type': 'application/json',
    });

    const capture = readPostHogCapture(collector);
    assert.equal(capture.events.length, 0);
    assert.equal(capture.parseErrors.length, 1);
    assert.match(capture.parseErrors[0], /JSON|Unexpected|position/i);
  } finally {
    await collector.shutdown();
  }
});

test('holds caller-selected responses and shuts down keep-alive connections idempotently', async () => {
  const collector = await startPostHogCapture({
    stubUrl: 'http://127.0.0.1:0',
    holdResponse: ({ events }) =>
      events.some((event) => event.event === 'hold-this-response'),
  });
  const request = post(
    `${collector.url}/e/`,
    JSON.stringify({ event: 'hold-this-response', properties: {} }),
    { 'content-type': 'application/json' },
  ).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(collector.heldResponseCount, 1);
  await collector.shutdown();
  await request;
  await collector.shutdown();
});
