import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const PROBE_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
];
const EMPTY_EVIDENCE = { events: [], commands: [] };

function errorMessage(error) {
  return String(error?.stack ?? error);
}

async function recordFinding(target, key, run) {
  try {
    target[key] = { status: 'recorded', ...(await run()) };
  } catch (error) {
    target[key] = { status: 'error', error: errorMessage(error) };
  }
}

function protocolValue(response) {
  if (response?.exceptionDetails) {
    return {
      exception:
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'Runtime.evaluate exception',
    };
  }
  return response?.result?.value;
}

function decodedProtocolValue(response) {
  const value = protocolValue(response);
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function countDomNodes(root) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.nodeType !== undefined) count += 1;
    for (const key of [
      'children',
      'childNodes',
      'shadowRoots',
      'pseudoElements',
      'distributedNodes',
    ]) {
      for (const child of node[key] ?? []) visit(child);
    }
    for (const key of ['contentDocument', 'templateContent']) visit(node[key]);
  };
  visit(root);
  return count;
}

function inspectDOMTree(root) {
  const shadowRoots = [];
  const contentDocuments = [];
  const backendNodes = new Map();
  const visit = (node, parentName = null) => {
    if (!node || typeof node !== 'object') return;
    if (node.backendNodeId !== undefined) {
      const name = node.nodeName ?? '#unknown';
      const names = backendNodes.get(node.backendNodeId) ?? [];
      names.push(name);
      backendNodes.set(node.backendNodeId, names);
    }
    for (const shadow of node.shadowRoots ?? []) {
      shadowRoots.push({
        host: node.nodeName ?? parentName,
        type: shadow.shadowRootType ?? 'unknown',
        backendNodeId: shadow.backendNodeId ?? null,
      });
      visit(shadow, node.nodeName ?? parentName);
    }
    if (node.contentDocument) {
      contentDocuments.push({
        owner: node.nodeName ?? parentName,
        url: node.contentDocument.documentURL ?? null,
        backendNodeId: node.contentDocument.backendNodeId ?? null,
      });
      visit(node.contentDocument, node.nodeName ?? parentName);
    }
    for (const key of [
      'children',
      'childNodes',
      'pseudoElements',
      'distributedNodes',
    ]) {
      for (const child of node[key] ?? [])
        visit(child, node.nodeName ?? parentName);
    }
    visit(node.templateContent, node.nodeName ?? parentName);
  };
  visit(root);
  return { shadowRoots, contentDocuments, backendNodes };
}

function requireArray(value, description) {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `Malformed DOMSnapshot: ${description} must be an array`,
    );
  }
  return value;
}

function snapshotSummary(snapshot, expectedValues = []) {
  const strings = requireArray(snapshot?.strings, 'strings');
  const documents = requireArray(snapshot?.documents, 'documents');
  const inputValues = [];
  const checkedNodes = [];
  for (const [documentIndex, document] of documents.entries()) {
    const nodes = document?.nodes;
    if (!nodes || typeof nodes !== 'object') {
      throw new TypeError(
        `Malformed DOMSnapshot: documents[${documentIndex}].nodes is required`,
      );
    }
    const names = requireArray(
      nodes.nodeName,
      `documents[${documentIndex}].nodes.nodeName`,
    );
    const inputValue = nodes.inputValue;
    const inputChecked = nodes.inputChecked;
    if (!inputValue || typeof inputValue !== 'object') {
      throw new TypeError(
        `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputValue is required`,
      );
    }
    if (!inputChecked || typeof inputChecked !== 'object') {
      throw new TypeError(
        `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputChecked is required`,
      );
    }
    const valueNodeIndices = requireArray(
      inputValue.index,
      `documents[${documentIndex}].nodes.inputValue.index`,
    );
    const valueStringIndices = requireArray(
      inputValue.value,
      `documents[${documentIndex}].nodes.inputValue.value`,
    );
    if (valueNodeIndices.length !== valueStringIndices.length) {
      throw new TypeError(
        `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputValue index/value lengths differ`,
      );
    }
    const seenValueNodes = new Set();
    for (const [entryIndex, nodeIndex] of valueNodeIndices.entries()) {
      const stringIndex = valueStringIndices[entryIndex];
      if (
        !Number.isInteger(nodeIndex) ||
        nodeIndex < 0 ||
        nodeIndex >= names.length
      ) {
        throw new TypeError(
          `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputValue.index[${entryIndex}] is out of range`,
        );
      }
      if (seenValueNodes.has(nodeIndex)) {
        throw new TypeError(
          `Malformed DOMSnapshot: duplicate inputValue node index ${nodeIndex}`,
        );
      }
      // DOMSnapshot uses string index -1 for an empty value.
      if (
        !Number.isInteger(stringIndex) ||
        stringIndex < -1 ||
        (stringIndex >= 0 && typeof strings[stringIndex] !== 'string')
      ) {
        throw new TypeError(
          `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputValue.value[${entryIndex}] is not a valid strings index`,
        );
      }
      const nameStringIndex = names[nodeIndex];
      if (
        !Number.isInteger(nameStringIndex) ||
        typeof strings[nameStringIndex] !== 'string'
      ) {
        throw new TypeError(
          `Malformed DOMSnapshot: documents[${documentIndex}].nodes.nodeName[${nodeIndex}] is not a valid strings index`,
        );
      }
      seenValueNodes.add(nodeIndex);
      inputValues.push({
        nodeIndex,
        nodeName: strings[nameStringIndex],
        value: stringIndex === -1 ? '' : strings[stringIndex],
      });
    }
    const checkedNodeIndices = requireArray(
      inputChecked.index,
      `documents[${documentIndex}].nodes.inputChecked.index`,
    );
    const seenCheckedNodes = new Set();
    for (const [entryIndex, nodeIndex] of checkedNodeIndices.entries()) {
      if (
        !Number.isInteger(nodeIndex) ||
        nodeIndex < 0 ||
        nodeIndex >= names.length
      ) {
        throw new TypeError(
          `Malformed DOMSnapshot: documents[${documentIndex}].nodes.inputChecked.index[${entryIndex}] is out of range`,
        );
      }
      if (seenCheckedNodes.has(nodeIndex)) {
        throw new TypeError(
          `Malformed DOMSnapshot: duplicate inputChecked node index ${nodeIndex}`,
        );
      }
      const nameStringIndex = names[nodeIndex];
      if (
        !Number.isInteger(nameStringIndex) ||
        typeof strings[nameStringIndex] !== 'string'
      ) {
        throw new TypeError(
          `Malformed DOMSnapshot: documents[${documentIndex}].nodes.nodeName[${nodeIndex}] is not a valid strings index`,
        );
      }
      seenCheckedNodes.add(nodeIndex);
      checkedNodes.push({
        nodeIndex,
        nodeName: strings[nameStringIndex],
        checked: true,
      });
    }
  }
  return {
    documentCount: documents.length,
    inputValueCount: inputValues.length,
    inputCheckedCount: checkedNodes.length,
    inputValues: inputValues.filter(({ value }) =>
      expectedValues.includes(value),
    ),
    checkedNodes,
  };
}

export function runS2S3SelfTests() {
  const snapshot = {
    strings: ['input', 'button', 'live secret-free value', ''],
    documents: [
      {
        nodes: {
          nodeName: [0, 0, 1],
          inputValue: { index: [0, 1], value: [2, 3] },
          inputChecked: { index: [2] },
        },
      },
    ],
  };
  const summary = snapshotSummary(snapshot, ['live secret-free value', '']);
  assert.deepEqual(summary, {
    documentCount: 1,
    inputValueCount: 2,
    inputCheckedCount: 1,
    inputValues: [
      { nodeIndex: 0, nodeName: 'input', value: 'live secret-free value' },
      { nodeIndex: 1, nodeName: 'input', value: '' },
    ],
    checkedNodes: [{ nodeIndex: 2, nodeName: 'button', checked: true }],
  });

  assert.throws(
    () =>
      snapshotSummary({
        strings: ['input', 'value'],
        documents: [
          {
            nodes: {
              nodeName: [0],
              inputValue: { index: [0], value: [] },
              inputChecked: { index: [] },
            },
          },
        ],
      }),
    /index\/value lengths differ/,
    'malformed RareStringData must be an error, not an empty-value finding',
  );
  assert.throws(
    () =>
      snapshotSummary({
        strings: ['input'],
        documents: [
          {
            nodes: {
              nodeName: [0],
              inputValue: { index: [], value: [] },
              inputChecked: { index: [2] },
            },
          },
        ],
      }),
    /inputChecked\.index\[0\] is out of range/,
  );

  const backendNodes = collectBackendIds({
    nodeType: 9,
    nodeName: '#document',
    backendNodeId: 1,
    children: [{ nodeType: 1, nodeName: 'DIV', backendNodeId: 42 }],
    shadowRoots: [
      {
        nodeType: 11,
        nodeName: '#document-fragment',
        shadowRootType: 'closed',
        backendNodeId: 43,
      },
    ],
    contentDocument: {
      nodeType: 9,
      nodeName: '#document',
      documentURL: 'http://localhost/frame',
      backendNodeId: 44,
      children: [{ nodeType: 1, nodeName: 'INPUT', backendNodeId: 45 }],
    },
  });
  assert(backendNodes instanceof Map);
  assert.equal(backendNodes.get(42)?.[0], 'DIV');
  assert.equal(backendNodes.get(43)?.[0], '#document-fragment');
  assert.equal(backendNodes.get(45)?.[0], 'INPUT');

  assert.equal(percentile([3, 1, 2, 4], 0.5), 2);
  assert.equal(percentile([3, 1, 2, 4], 0.95), 4);
  return { passed: 9 };
}

function domSnapshotParams() {
  return {
    computedStyles: PROBE_STYLES,
    includeDOMRects: true,
    includePaintOrder: true,
  };
}

function collectBackendIds(root) {
  return inspectDOMTree(root).backendNodes;
}

function topFrameId(frameTree) {
  return frameTree?.frameTree?.frame?.id ?? null;
}

function sessionEntry(view, urlFragment) {
  return (
    [...view.sessions.entries()].find(
      ([, info]) =>
        info.type === 'iframe' && String(info.url ?? '').includes(urlFragment),
    ) ?? null
  );
}

async function waitForSession(ctx, view, urlFragment) {
  return ctx.until(
    () => sessionEntry(view, urlFragment),
    ctx.config.caseTimeoutMs ?? 12000,
  );
}

async function waitForDocument(ctx, view, expression, sessionId = null) {
  return ctx.until(async () => {
    try {
      const response = await view.send(
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
        },
        sessionId,
      );
      return protocolValue(response) === true;
    } catch {
      return false;
    }
  }, ctx.config.caseTimeoutMs ?? 12000);
}

async function findNode(view, selector, sessionId = null) {
  const document = await view.send(
    'DOM.getDocument',
    {
      depth: -1,
      pierce: true,
    },
    sessionId,
  );
  const queried = await view.send(
    'DOM.querySelector',
    {
      nodeId: document.root.nodeId,
      selector,
    },
    sessionId,
  );
  if (!queried.nodeId) throw new Error(`No node matched ${selector}`);
  const described = await view.send(
    'DOM.describeNode',
    {
      nodeId: queried.nodeId,
    },
    sessionId,
  );
  return {
    nodeId: queried.nodeId,
    backendNodeId: described.node.backendNodeId,
    nodeName: described.node.nodeName,
  };
}

function boxCenter(boxModel) {
  const quad = boxModel?.model?.content ?? boxModel?.model?.border;
  if (!Array.isArray(quad) || quad.length < 8) {
    throw new Error('DOM.getBoxModel returned no usable content quad');
  }
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    originX: quad[0],
    originY: quad[1],
  };
}

async function clickNode(view, node, sessionId = null) {
  await view.send(
    'DOM.scrollIntoViewIfNeeded',
    { nodeId: node.nodeId },
    sessionId,
  );
  const box = await view.send(
    'DOM.getBoxModel',
    { nodeId: node.nodeId },
    sessionId,
  );
  const point = boxCenter(box);
  await view.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    },
    sessionId,
  );
  await view.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    },
    sessionId,
  );
  await view.send(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    },
    sessionId,
  );
  return point;
}

async function queryCommandLineListeners(view, selector, sessionId = null) {
  const expression = `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return { found: false }; const listeners = getEventListeners(node); return { found: true, eventTypes: Object.fromEntries(Object.entries(listeners).map(([type, list]) => [type, list.length])) }; })()`;
  const response = await view.send(
    'Runtime.evaluate',
    {
      expression,
      includeCommandLineAPI: true,
      returnByValue: true,
    },
    sessionId,
  );
  return {
    exceptionDetails: response.exceptionDetails ?? null,
    result: protocolValue(response),
  };
}

function registerS2Fixtures(server) {
  const sameOriginChild = `${server.mainOrigin}/can1570/s2-same-child`;
  const oopifChild = `${server.crossOrigin}/can1570/s2-oopif-child`;
  server.register(
    '/can1570/s2-main',
    `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S2 main</title>
<style>body{margin:0;font:16px sans-serif}iframe{position:absolute;border:0;width:360px;height:240px}#same-frame{left:20px;top:330px}#oopif-frame{left:430px;top:80px}</style>
<button id="main-event-target">main event target</button>
<input id="main-live-value" value="initial-main-value">
<input id="main-live-check" type="checkbox">
<div id="open-shadow-host"></div><div id="closed-shadow-host"></div>
<iframe id="same-frame" src="${sameOriginChild}"></iframe>
<iframe id="oopif-frame" src="${oopifChild}"></iframe>
<script>
  document.querySelector('#main-event-target').addEventListener('click', () => {});
  document.querySelector('#main-live-value').value = 'can1570-live-main-value';
  document.querySelector('#main-live-check').checked = true;
  const openRoot = document.querySelector('#open-shadow-host').attachShadow({mode:'open'});
  openRoot.innerHTML = '<button id="open-shadow-target">open shadow target</button>';
  const closedRoot = document.querySelector('#closed-shadow-host').attachShadow({mode:'closed'});
  closedRoot.innerHTML = '<button id="closed-shadow-target">closed shadow target</button>';
</script>`,
  );
  server.register(
    '/can1570/s2-same-child',
    `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S2 same-origin child</title>
<input id="same-live-value" value="initial-same-value">
<input id="same-live-check" type="checkbox">
<script>
  document.querySelector('#same-live-value').value = 'can1570-live-same-value';
  document.querySelector('#same-live-check').checked = true;
</script>`,
  );
  server.register(
    '/can1570/s2-oopif-child',
    `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S2 OOPIF child</title>
<style>body{margin:0;font:16px sans-serif}button,input{margin:30px;min-width:120px;min-height:32px}</style>
<button id="oopif-mouse-target">OOPIF mouse target</button>
<input id="oopif-key-target" value="">
<input id="oopif-live-value" value="initial-oopif-value">
<input id="oopif-live-check" type="checkbox">
<script>
  window.can1570Probe = { mouse: null, keys: [] };
  document.querySelector('#oopif-mouse-target').addEventListener('click', event => {
    window.can1570Probe.mouse = { id: event.target.id, x: event.clientX, y: event.clientY };
  });
  document.querySelector('#oopif-key-target').addEventListener('keydown', event => {
    window.can1570Probe.keys.push({ key: event.key, code: event.code });
  });
  document.querySelector('#oopif-live-value').value = 'can1570-live-oopif-value';
  document.querySelector('#oopif-live-check').checked = true;
</script>`,
  );
  return { sameOriginChild, oopifChild };
}

function registerS3Fixtures(server) {
  const childUrl = `${server.crossOrigin}/can1570/s3-oopif-child`;
  server.register(
    '/can1570/s3-main',
    `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S3 main chooser</title>
<style>body{margin:0;font:16px sans-serif}input,button{display:block;margin:24px;width:320px;height:42px}iframe{position:absolute;left:450px;top:40px;border:0;width:360px;height:260px}</style>
<input id="main-file-input" type="file">
<button id="show-open-file-picker">Exercise showOpenFilePicker</button>
<iframe id="s3-oopif-frame" src="${childUrl}"></iframe>
<script>
  window.can1570ChooserEvents = { change: 0, cancel: 0, picker: null };
  const input = document.querySelector('#main-file-input');
  input.addEventListener('change', () => window.can1570ChooserEvents.change++);
  input.addEventListener('cancel', () => window.can1570ChooserEvents.cancel++);
  document.querySelector('#show-open-file-picker').addEventListener('click', () => {
    if (typeof window.showOpenFilePicker !== 'function') {
      window.can1570ChooserEvents.picker = { supported: false };
      return;
    }
    window.showOpenFilePicker({ multiple: false }).then(
      handles => { window.can1570ChooserEvents.picker = { supported: true, fulfilled: true, count: handles.length }; },
      error => { window.can1570ChooserEvents.picker = { supported: true, fulfilled: false, name: error.name, message: error.message }; },
    );
  });
</script>`,
  );
  server.register(
    '/can1570/s3-oopif-child',
    `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S3 OOPIF chooser</title>
<style>body{margin:0;font:16px sans-serif}input{display:block;margin:24px;width:300px;height:42px}</style>
<input id="oopif-file-input" type="file">
<script>
  window.can1570ChooserEvents = { change: 0, cancel: 0 };
  const input = document.querySelector('#oopif-file-input');
  input.addEventListener('change', () => window.can1570ChooserEvents.change++);
  input.addEventListener('cancel', () => window.can1570ChooserEvents.cancel++);
</script>`,
  );
  return childUrl;
}

async function runS2(ctx) {
  const result = {
    status: 'recorded',
    findings: {},
    cost: {
      status: 'deferred',
      reason: 'Opt-in S2 cost measurement was not requested.',
    },
    evidence: EMPTY_EVIDENCE,
    errors: [],
  };
  let view = null;
  let childSession = null;
  let mainDocument = null;
  let childDocument = null;
  let fixtureUrls;
  try {
    fixtureUrls = registerS2Fixtures(ctx.server);
    view = await ctx.newView(`${ctx.server.mainOrigin}/can1570/s2-main`);
    await waitForDocument(ctx, view, "document.readyState === 'complete'");
    await waitForDocument(
      ctx,
      view,
      "document.querySelector('#same-frame')?.contentDocument?.readyState === 'complete'",
    );
  } catch (error) {
    result.errors.push(`S2 fixture/view setup: ${errorMessage(error)}`);
  }

  if (view) {
    try {
      const [sessionId, info] = await waitForSession(
        ctx,
        view,
        '/can1570/s2-oopif-child',
      );
      childSession = sessionId;
      await waitForDocument(
        ctx,
        view,
        "document.readyState === 'complete'",
        childSession,
      );
      result.oopifTarget = { sessionId, type: info.type, url: info.url };
    } catch (error) {
      result.oopifAttach = {
        status: 'not-observed',
        error: errorMessage(error),
      };
    }

    await recordFinding(result.findings, 'piercedDom', async () => {
      mainDocument = await view.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const facts = inspectDOMTree(mainDocument.root);
      const sameFrameUrl = fixtureUrls?.sameOriginChild ?? null;
      const sameFrameReady = await view.send('Runtime.evaluate', {
        expression:
          "document.querySelector('#same-frame')?.contentDocument?.readyState === 'complete'",
        returnByValue: true,
      });
      return {
        rootNodeName: mainDocument.root.nodeName,
        nodeCount: countDomNodes(mainDocument.root),
        openShadowRoots: facts.shadowRoots.filter(
          ({ type }) => type === 'open',
        ),
        closedShadowRoots: facts.shadowRoots.filter(
          ({ type }) => type === 'closed',
        ),
        allShadowRoots: facts.shadowRoots,
        contentDocuments: facts.contentDocuments,
        sameOriginFrameUrl: sameFrameUrl,
        sameOriginFrameReady: protocolValue(sameFrameReady),
        observedClosedShadow: facts.shadowRoots.some(
          ({ type }) => type === 'closed',
        ),
        observedOpenShadow: facts.shadowRoots.some(
          ({ type }) => type === 'open',
        ),
        observedSameProcessFrameDocument: facts.contentDocuments.some(
          ({ url }) =>
            url === sameFrameUrl ||
            String(url ?? '').includes('/can1570/s2-same-child'),
        ),
      };
    });

    await recordFinding(
      result.findings,
      'oopifRuntimeSessionEnabled',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        return {
          sessionId: childSession,
          response: await view.send('Runtime.enable', {}, childSession),
        };
      },
    );
    await recordFinding(
      result.findings,
      'oopifFrameTreeAndPiercedDocument',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        const frameTree = await view.send(
          'Page.getFrameTree',
          {},
          childSession,
        );
        childDocument = await view.send(
          'DOM.getDocument',
          { depth: -1, pierce: true },
          childSession,
        );
        const facts = inspectDOMTree(childDocument.root);
        return {
          sessionId: childSession,
          frameId: topFrameId(frameTree),
          pageFrameTree: frameTree,
          domNodeCount: countDomNodes(childDocument.root),
          childShadowRoots: facts.shadowRoots,
          backendNodeIdCount: facts.backendNodes.size,
        };
      },
    );
    await recordFinding(result.findings, 'oopifDomSnapshot', async () => {
      if (!childSession)
        throw new Error('No flattened OOPIF session was attached');
      const snapshot = await view.send(
        'DOMSnapshot.captureSnapshot',
        domSnapshotParams(),
        childSession,
      );
      return {
        documentCount: snapshot.documents?.length ?? 0,
        nodeCount: (snapshot.documents ?? []).reduce(
          (sum, doc) => sum + (doc.nodes?.nodeName?.length ?? 0),
          0,
        ),
      };
    });
    await recordFinding(result.findings, 'oopifAccessibilityTree', async () => {
      if (!childSession)
        throw new Error('No flattened OOPIF session was attached');
      const axTree = await view.send(
        'Accessibility.getFullAXTree',
        {},
        childSession,
      );
      return { nodeCount: axTree.nodes?.length ?? 0 };
    });

    const expectedValues = [
      'can1570-live-main-value',
      'can1570-live-same-value',
      'can1570-live-oopif-value',
    ];
    await recordFinding(
      result.findings,
      'liveValuesMainSessionSnapshot',
      async () => {
        const snapshot = await view.send(
          'DOMSnapshot.captureSnapshot',
          domSnapshotParams(),
        );
        return snapshotSummary(snapshot, expectedValues);
      },
    );
    await recordFinding(
      result.findings,
      'liveValuesSameProcessFrameReadback',
      async () => {
        const response = await view.send('Runtime.evaluate', {
          expression: `JSON.stringify({ value: document.querySelector('#same-frame')?.contentDocument?.querySelector('#same-live-value')?.value, checked: document.querySelector('#same-frame')?.contentDocument?.querySelector('#same-live-check')?.checked })`,
          returnByValue: true,
        });
        return { readback: decodedProtocolValue(response) };
      },
    );
    await recordFinding(
      result.findings,
      'liveValuesOopifSessionSnapshot',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        const snapshot = await view.send(
          'DOMSnapshot.captureSnapshot',
          domSnapshotParams(),
          childSession,
        );
        return snapshotSummary(snapshot, expectedValues);
      },
    );
    await recordFinding(
      result.findings,
      'liveValuesOopifSessionRuntimeReadback',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        const response = await view.send(
          'Runtime.evaluate',
          {
            expression: `JSON.stringify({ value: document.querySelector('#oopif-live-value')?.value, checked: document.querySelector('#oopif-live-check')?.checked })`,
            returnByValue: true,
          },
          childSession,
        );
        return { readback: decodedProtocolValue(response) };
      },
    );

    await recordFinding(
      result.findings,
      'oopifMouseInputInChildSession',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        const childMouse = await findNode(
          view,
          '#oopif-mouse-target',
          childSession,
        );
        const childBox = await view.send(
          'DOM.getBoxModel',
          { nodeId: childMouse.nodeId },
          childSession,
        );
        const childPoint = boxCenter(childBox);
        const mainFrameNode = await findNode(view, '#oopif-frame');
        const mainFrameBox = await view.send('DOM.getBoxModel', {
          nodeId: mainFrameNode.nodeId,
        });
        const mainFrameOrigin = boxCenter(mainFrameBox);
        const expectedRootPoint = {
          x: childPoint.x + mainFrameOrigin.originX,
          y: childPoint.y + mainFrameOrigin.originY,
        };

        await view.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x: childPoint.x,
            y: childPoint.y,
          },
          childSession,
        );
        await view.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mousePressed',
            x: childPoint.x,
            y: childPoint.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          },
          childSession,
        );
        await view.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseReleased',
            x: childPoint.x,
            y: childPoint.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          },
          childSession,
        );
        await ctx.sleep(100);
        const readback = await view.send(
          'Runtime.evaluate',
          {
            expression: 'JSON.stringify(window.can1570Probe.mouse)',
            returnByValue: true,
          },
          childSession,
        );
        const observed = decodedProtocolValue(readback);
        return {
          childSession,
          childLocalTargetPoint: { x: childPoint.x, y: childPoint.y },
          iframeContentOriginInRoot: {
            x: mainFrameOrigin.originX,
            y: mainFrameOrigin.originY,
          },
          correspondingRootPoint: expectedRootPoint,
          observedMouseEvent: observed,
          mouseHitObserved: observed?.id === 'oopif-mouse-target',
          observedMouseCoordinatesMatchChildLocal:
            observed?.x === Math.round(childPoint.x) &&
            observed?.y === Math.round(childPoint.y),
          observedMouseCoordinatesMatchRootTranslation:
            observed?.x === Math.round(expectedRootPoint.x) &&
            observed?.y === Math.round(expectedRootPoint.y),
        };
      },
    );

    await recordFinding(
      result.findings,
      'oopifKeyInputInChildSession',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        let focusEmulation;
        try {
          focusEmulation = await view.send(
            'Emulation.setFocusEmulationEnabled',
            {
              enabled: true,
            },
            childSession,
          );
        } catch (error) {
          focusEmulation = { error: errorMessage(error) };
        }
        const keyTarget = await findNode(
          view,
          '#oopif-key-target',
          childSession,
        );
        await view.send(
          'DOM.focus',
          { nodeId: keyTarget.nodeId },
          childSession,
        );
        const keyDown = {
          type: 'keyDown',
          key: 'A',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        };
        const keyChar = {
          type: 'char',
          key: 'a',
          code: 'KeyA',
          text: 'a',
          unmodifiedText: 'a',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        };
        const keyUp = {
          type: 'keyUp',
          key: 'A',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        };
        await view.send('Input.dispatchKeyEvent', keyDown, childSession);
        await view.send('Input.dispatchKeyEvent', keyChar, childSession);
        await view.send('Input.dispatchKeyEvent', keyUp, childSession);
        await ctx.sleep(100);
        const readback = await view.send(
          'Runtime.evaluate',
          {
            expression: `JSON.stringify({ keys: window.can1570Probe.keys, keyValue: document.querySelector('#oopif-key-target').value })`,
            returnByValue: true,
          },
          childSession,
        );
        const observed = decodedProtocolValue(readback);
        return {
          childSession,
          observedChildReadback: observed,
          focusEmulation,
          keyInputObserved: (observed?.keys?.length ?? 0) > 0,
        };
      },
    );

    await recordFinding(
      result.findings,
      'backendNodeIdReuseAcrossSessions',
      async () => {
        if (!mainDocument)
          mainDocument = await view.send('DOM.getDocument', {
            depth: -1,
            pierce: true,
          });
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        if (!childDocument)
          childDocument = await view.send(
            'DOM.getDocument',
            { depth: -1, pierce: true },
            childSession,
          );
        const mainFrameTree = await view.send('Page.getFrameTree', {});
        const childFrameTree = await view.send(
          'Page.getFrameTree',
          {},
          childSession,
        );
        const mainIds = collectBackendIds(mainDocument.root);
        const childIds = collectBackendIds(childDocument.root);
        const overlap = [...mainIds.keys()].filter((backendNodeId) =>
          childIds.has(backendNodeId),
        );
        const mainSpecific = await findNode(view, '#main-event-target');
        const childSpecific = await findNode(
          view,
          '#oopif-mouse-target',
          childSession,
        );
        return {
          comparedSessions: [null, childSession],
          documentFrameIds: [
            topFrameId(mainFrameTree),
            topFrameId(childFrameTree),
          ],
          mainBackendNodeCount: mainIds.size,
          oopifBackendNodeCount: childIds.size,
          overlappingBackendNodeIds: overlap.slice(0, 50),
          overlapCount: overlap.length,
          backendNodeIdReuseObserved: overlap.length > 0,
          selectedNodes: [
            {
              sessionId: null,
              selector: '#main-event-target',
              backendNodeId: mainSpecific.backendNodeId,
            },
            {
              sessionId: childSession,
              selector: '#oopif-mouse-target',
              backendNodeId: childSpecific.backendNodeId,
            },
          ],
          interpretation: overlap.length
            ? 'The same backendNodeId value was observed in both session-local DOM trees; identity must include session/document.'
            : 'No backendNodeId overlap was observed in the sampled trees; this probe reports observation only and does not assume reuse.',
        };
      },
    );

    await recordFinding(
      result.findings,
      'includeCommandLineAPIGetEventListenersMainSession',
      async () => queryCommandLineListeners(view, '#main-event-target'),
    );
    await recordFinding(
      result.findings,
      'includeCommandLineAPIGetEventListenersOopifSession',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        return queryCommandLineListeners(
          view,
          '#oopif-mouse-target',
          childSession,
        );
      },
    );
  }

  result.evidence = view?.evidence() ?? EMPTY_EVIDENCE;
  result.cost = await runCostMode(ctx);
  return result;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

async function measurePageModel(view, listenerDetection) {
  const startedAt = performance.now();
  const sessions = [
    null,
    ...[...view.sessions.entries()]
      .filter(([, info]) => info.type === 'iframe')
      .map(([sessionId]) => sessionId),
  ];
  const perSession = await Promise.all(
    sessions.map(async (sessionId) => {
      const protocolErrors = [];
      const summaryErrors = [];
      const modelSummary = {
        dom: null,
        snapshot: null,
        accessibility: null,
      };
      for (const methodAndParams of [
        ['DOM.getDocument', { depth: -1, pierce: true }],
        ['DOMSnapshot.captureSnapshot', domSnapshotParams()],
        ['Accessibility.getFullAXTree', {}],
      ]) {
        let response;
        try {
          response = await view.send(
            methodAndParams[0],
            methodAndParams[1],
            sessionId,
          );
        } catch (error) {
          protocolErrors.push({
            method: methodAndParams[0],
            error: errorMessage(error),
          });
          continue;
        }
        try {
          if (methodAndParams[0] === 'DOM.getDocument') {
            const tree = inspectDOMTree(response.root);
            modelSummary.dom = {
              nodeCount: countDomNodes(response.root),
              backendNodeCount: tree.backendNodes.size,
              shadowRootCount: tree.shadowRoots.length,
              contentDocumentCount: tree.contentDocuments.length,
            };
          } else if (methodAndParams[0] === 'DOMSnapshot.captureSnapshot') {
            modelSummary.snapshot = snapshotSummary(response);
          } else if (methodAndParams[0] === 'Accessibility.getFullAXTree') {
            modelSummary.accessibility = {
              nodeCount: response.nodes?.length ?? 0,
            };
          }
        } catch (error) {
          summaryErrors.push({
            method: methodAndParams[0],
            error: errorMessage(error),
            source:
              'local evidence summary extraction; the CDP command itself succeeded',
          });
        }
      }
      let listenerResult = null;
      if (listenerDetection) {
        try {
          const response = await view.send(
            'Runtime.evaluate',
            {
              expression: `(() => {
            const total = document.querySelectorAll('*').length;
            if (total > 10000) return { skipped: true, reason: 'element-limit', total };
            const selector = 'a,button,input,textarea,select,[role],[tabindex]';
            const candidates = document.querySelectorAll(selector);
            let visited = 0;
            let hits = 0;
            for (const element of candidates) {
              visited++;
              const listeners = getEventListeners(element);
              if (['click','mousedown','mouseup','pointerdown','pointerup'].some(type => (listeners[type] || []).length > 0)) hits++;
              if (hits >= 100) break;
              if (visited >= 1000) break;
            }
            return { skipped: false, total, visited, hits, truncated: visited >= 1000 && hits < 100 };
          })()`,
              includeCommandLineAPI: true,
              returnByValue: true,
            },
            sessionId,
          );
          listenerResult = protocolValue(response);
          if (response.exceptionDetails) {
            protocolErrors.push({
              method: 'Runtime.evaluate(getEventListeners)',
              error: response.exceptionDetails.text ?? 'Runtime exception',
            });
          }
        } catch (error) {
          protocolErrors.push({
            method: 'Runtime.evaluate(getEventListeners)',
            error: errorMessage(error),
          });
        }
      }
      return {
        sessionId,
        modelSummary,
        protocolErrors,
        summaryErrors,
        listenerResult,
      };
    }),
  );
  return {
    durationMs: performance.now() - startedAt,
    sessionCount: sessions.length,
    sessionScope: sessions.map((sessionId) => ({
      sessionId,
      targetInfo:
        sessionId == null ? null : (view.sessions.get(sessionId) ?? null),
    })),
    listenerDetection,
    perSession,
  };
}

async function runCostMode(ctx) {
  const config = ctx.config ?? {};
  if (!config.measureCost) {
    return {
      status: 'deferred',
      reason:
        'Set config.measureCost=true and provide a loopback config.externalPageUrl to run cost sampling.',
      requestedSamples: config.costSamples ?? null,
      externalPageUrlConfigured: Boolean(config.externalPageUrl),
      evidence: [],
    };
  }
  if (!config.externalPageUrl) {
    return {
      status: 'deferred',
      reason:
        'Cost mode was requested but config.externalPageUrl has not been supplied yet.',
      requestedSamples: config.costSamples ?? null,
      externalPageUrlConfigured: false,
      evidence: [],
    };
  }

  let url;
  try {
    url = new URL(config.externalPageUrl);
  } catch (error) {
    return {
      status: 'deferred',
      reason: `No cost request was issued because config.externalPageUrl is invalid: ${errorMessage(error)}`,
      requestedUrl: String(config.externalPageUrl),
      evidence: [],
    };
  }
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password
  ) {
    return {
      status: 'deferred',
      reason:
        'No cost request was issued: this probe only loads loopback HTTP synthetic pages.',
      requestedUrl: url.href,
      evidence: [],
    };
  }

  const requested = Number.isInteger(config.costSamples)
    ? config.costSamples
    : 20;
  const sampleCount = Math.max(20, Math.min(200, requested));
  const measurements = {};
  const views = [];
  const errors = [];
  const frameSessionScope = {};
  for (const warm of [false, true]) {
    for (const listenerDetection of [false, true]) {
      const key = `${warm ? 'warm' : 'cold'}-${listenerDetection ? 'with' : 'without'}-listener-detection`;
      let view = null;
      const samplesMs = [];
      const sampleSummaries = [];
      const sampleErrors = [];
      try {
        view = await ctx.newView(url.href, { retainResults: false });
        views.push({ key, view });
        await waitForDocument(ctx, view, "document.readyState === 'complete'");
        if (warm) {
          const prime = await measurePageModel(view, listenerDetection);
          frameSessionScope[key] = {
            primingSessionCount: prime.sessionCount,
            primingSessions: prime.sessionScope,
          };
        }
        for (let index = 0; index < sampleCount; index += 1) {
          try {
            if (!warm && index > 0) {
              await view.wc.loadURL(url.href);
              await waitForDocument(
                ctx,
                view,
                "document.readyState === 'complete'",
              );
            }
            const sample = await ctx.bounded(
              measurePageModel(view, listenerDetection),
              Math.max(30000, ctx.config.caseTimeoutMs ?? 12000),
            );
            samplesMs.push(sample.durationMs);
            sampleSummaries.push({
              index,
              durationMs: sample.durationMs,
              sessionCount: sample.sessionCount,
              sessionScope: sample.sessionScope,
              perSession: sample.perSession,
            });
            const scope = frameSessionScope[key] ?? {
              primingSessionCount: null,
              primingSessions: null,
            };
            scope.lastSampleSessionCount = sample.sessionCount;
            scope.lastSampleSessions = sample.sessionScope;
            scope.observedSessionCounts = [
              ...(scope.observedSessionCounts ?? []),
              sample.sessionCount,
            ];
            frameSessionScope[key] = scope;
            await ctx.sleep(ctx.config.settleMs ?? 400);
          } catch (error) {
            sampleErrors.push({ index, error: errorMessage(error) });
          }
        }
      } catch (error) {
        sampleErrors.push({ setup: true, error: errorMessage(error) });
      }
      measurements[key] = {
        warm,
        listenerDetection,
        requestedSampleCount: sampleCount,
        completedSampleCount: samplesMs.length,
        failedSampleCount: sampleErrors.length,
        samplesMs,
        sampleSummaries,
        p50Ms: percentile(samplesMs, 0.5),
        p95Ms: percentile(samplesMs, 0.95),
        minMs: samplesMs.length ? Math.min(...samplesMs) : null,
        maxMs: samplesMs.length ? Math.max(...samplesMs) : null,
        sampleErrors,
      };
      if (sampleErrors.length) errors.push({ key, count: sampleErrors.length });
    }
  }
  return {
    status: 'recorded',
    qualification:
      'directional-only; extraction-plus-listener-probe approximation, not a production or planned page-model benchmark',
    requestedUrl: url.href,
    sampleCount,
    minimumSamplesEnforced: requested < 20,
    measured: measurements,
    frameSessionScope,
    methodology: {
      mainSessionIncluded: true,
      attachedIframeSessionsIncluded: true,
      sameProcessFrameCoverage:
        'Included in the main-session DOMSnapshot capture; no separate flattened session is used for same-process frames.',
      oopifCoverage:
        'Only iframe targets present in ctx.newView().sessions at the time each sample starts are included; this probe does not wait for a page-specific expected frame count.',
      limitations: [
        'Cold samples reload the external synthetic page but do not clear Chromium process, disk, network, or operating-system caches.',
        'Warm mode performs one untimed priming model build on the same page and then records repeated builds.',
        'This is an extraction-plus-listener-probe approximation, not a production page-model benchmark: reported duration covers parallel CDP DOM, snapshot, AX, and optional listener-detection requests plus response handling, with no final host row/locator assembly, filtering, pagination, or cache-hit behavior.',
        'Listener detection is deliberately bounded differently from the planned whole-model scan: it visits only a selector-based candidate set, stops after 1,000 candidates or 100 listener hits, and skips documents above 10,000 elements. Its timing is directional only and does not qualify the planned algorithm.',
        'Session coverage may vary between cold reload samples while OOPIF targets attach or detach.',
      ],
    },
    errors,
    evidence: views.map(({ key, view }) => ({
      key,
      evidence: view.evidence(),
    })),
  };
}

async function writeUploadFile(workDir) {
  if (!workDir || typeof workDir !== 'string')
    throw new Error('ctx.config.workDir is missing');
  const root = await realpath(workDir);
  const filePath = path.join(root, 'can1570-s3-oopif-upload.txt');
  if (path.dirname(filePath) !== root)
    throw new Error('Upload fixture escaped the disposable workDir');
  const bytes = Buffer.from(
    'CAN-1570 synthetic OOPIF upload fixture\n',
    'utf8',
  );
  await writeFile(filePath, bytes, { flag: 'w' });
  return {
    filePath,
    name: path.basename(filePath),
    sizeBytes: bytes.byteLength,
  };
}

async function runS3(ctx) {
  const result = {
    status: 'recorded',
    findings: {},
    windowsVerification: {
      status:
        process.platform === 'win32' ? 'observed-in-this-run' : 'unverified',
      platform: process.platform,
      reason:
        process.platform === 'win32'
          ? 'The probe is running on Windows.'
          : 'No Windows execution was performed in this run.',
    },
    evidence: EMPTY_EVIDENCE,
    errors: [],
  };
  let view = null;
  let childSession = null;
  let mainInput = null;
  let childInput = null;
  let mainIntercept = false;
  let childIntercept = false;
  try {
    const childUrl = registerS3Fixtures(ctx.server);
    view = await ctx.newView(`${ctx.server.mainOrigin}/can1570/s3-main`);
    await waitForDocument(ctx, view, "document.readyState === 'complete'");
    const [sessionId, info] = await waitForSession(
      ctx,
      view,
      '/can1570/s3-oopif-child',
    );
    childSession = sessionId;
    result.oopifTarget = {
      sessionId,
      type: info.type,
      url: info.url,
      expectedUrl: childUrl,
    };
  } catch (error) {
    result.errors.push(`S3 fixture/view setup: ${errorMessage(error)}`);
  }

  if (view) {
    await recordFinding(
      result.findings,
      'mainFileChooserInterception',
      async () => {
        const main = await view.send('Page.setInterceptFileChooserDialog', {
          enabled: true,
        });
        mainIntercept = true;
        return { enabled: mainIntercept, response: main };
      },
    );

    await recordFinding(
      result.findings,
      'oopifFileChooserInterception',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        const response = await view.send(
          'Page.setInterceptFileChooserDialog',
          { enabled: true },
          childSession,
        );
        childIntercept = true;
        return { enabled: childIntercept, sessionId: childSession, response };
      },
    );

    await recordFinding(
      result.findings,
      'mainChooserEventAndEmptyFileSet',
      async () => {
        mainInput = await findNode(view, '#main-file-input');
        if (mainIntercept) {
          const firstEventIndex = view.events.length;
          let clickPoint = null;
          let clickError = null;
          try {
            clickPoint = await clickNode(view, mainInput);
          } catch (error) {
            clickError = errorMessage(error);
          }
          await ctx.sleep(250);
          const chooser =
            view.events
              .slice(firstEventIndex)
              .find(
                (event) =>
                  event.method === 'Page.fileChooserOpened' &&
                  event.sessionId == null,
              ) ?? null;
          const before = await view.send('Runtime.evaluate', {
            expression: `JSON.stringify({ ...window.can1570ChooserEvents, files: document.querySelector('#main-file-input').files.length })`,
            returnByValue: true,
          });
          const beforeState = decodedProtocolValue(before);
          const emptySet = await view.send('DOM.setFileInputFiles', {
            files: [],
            backendNodeId:
              chooser?.params?.backendNodeId ?? mainInput.backendNodeId,
          });
          await ctx.sleep(80);
          const after = await view.send('Runtime.evaluate', {
            expression: `JSON.stringify({ ...window.can1570ChooserEvents, files: document.querySelector('#main-file-input').files.length })`,
            returnByValue: true,
          });
          return {
            clickPoint,
            clickError,
            chooserEventObserved: Boolean(chooser),
            chooserEvent: chooser,
            inputEventsBeforeEmptySet: beforeState,
            emptySetFileInputResponse: emptySet,
            inputEventsAfterEmptySet: decodedProtocolValue(after),
            cancellationEventObservedBeforeEmptySet:
              (beforeState?.cancel ?? 0) > 0,
            cancellationEventObservedAfterEmptySet:
              (decodedProtocolValue(after)?.cancel ?? 0) > 0,
            nativeDialogOpenedByProbe: false,
            note: 'The empty CDP file set is probed after interception; cancel/change event counts are reported rather than assumed.',
          };
        }
        return {
          chooserEventObserved: false,
          emptySetAttempted: false,
          reason:
            'Page.setInterceptFileChooserDialog did not succeed; no input click or native chooser was attempted.',
        };
      },
    );

    await recordFinding(
      result.findings,
      'oopifChooserAndFileAttachment',
      async () => {
        if (!childSession)
          throw new Error('No flattened OOPIF session was attached');
        childInput = await findNode(view, '#oopif-file-input', childSession);
        const file = await writeUploadFile(ctx.config.workDir);
        let clickPoint = null;
        let chooser = null;
        let chooserClickError = null;
        if (childIntercept) {
          const firstEventIndex = view.events.length;
          try {
            clickPoint = await clickNode(view, childInput, childSession);
          } catch (error) {
            chooserClickError = errorMessage(error);
          }
          await ctx.sleep(250);
          chooser =
            view.events
              .slice(firstEventIndex)
              .find(
                (event) =>
                  event.method === 'Page.fileChooserOpened' &&
                  event.sessionId === childSession,
              ) ?? null;
        }
        const attachment = await view.send(
          'DOM.setFileInputFiles',
          {
            files: [file.filePath],
            backendNodeId:
              chooser?.params?.backendNodeId ?? childInput.backendNodeId,
          },
          childSession,
        );
        await ctx.sleep(80);
        const readback = await view.send(
          'Runtime.evaluate',
          {
            expression: `JSON.stringify({ files: [...document.querySelector('#oopif-file-input').files].map(file => ({ name: file.name, size: file.size, type: file.type })), events: window.can1570ChooserEvents })`,
            returnByValue: true,
          },
          childSession,
        );
        const observed = decodedProtocolValue(readback);
        return {
          interceptionEnabledForChildSession: childIntercept,
          clickPoint,
          chooserClickError,
          chooserEventObserved: Boolean(chooser),
          chooserEvent: chooser,
          fileFixture: {
            name: file.name,
            sizeBytes: file.sizeBytes,
            storedUnderWorkDir: true,
          },
          setFileInputFilesResponse: attachment,
          inputReadback: observed,
          fileAttached:
            observed?.files?.some(
              (entry) =>
                entry.name === file.name && entry.size === file.sizeBytes,
            ) ?? false,
        };
      },
    );

    await recordFinding(
      result.findings,
      'showOpenFilePickerInterceptionSafety',
      async () => {
        const permissionEvidence = { electronHandlers: 'not-installed' };
        const permissionEvents = [];
        try {
          view.wc.session.setPermissionCheckHandler(
            (_contents, permission, requestingOrigin) => {
              permissionEvents.push({
                handler: 'check',
                permission,
                requestingOrigin,
              });
              return false;
            },
          );
          view.wc.session.setPermissionRequestHandler(
            (_contents, permission, callback, details) => {
              permissionEvents.push({
                handler: 'request',
                permission,
                details,
              });
              callback(false);
            },
          );
          permissionEvidence.electronHandlers =
            'installed-deny-all-on-disposable-session';
          permissionEvidence.permissionEvents = permissionEvents;
        } catch (error) {
          permissionEvidence.electronHandlerError = errorMessage(error);
        }

        // A fresh main-document navigation clears the prior input-chooser
        // click's transient activation. Never create activation for this test.
        const freshPageUrl = `${ctx.server.mainOrigin}/can1570/s3-main`;
        await view.wc.loadURL(freshPageUrl);
        await waitForDocument(ctx, view, "document.readyState === 'complete'");
        await ctx.sleep(50);
        let rearmedIntercept = null;
        let rearmError = null;
        try {
          rearmedIntercept = await view.send(
            'Page.setInterceptFileChooserDialog',
            { enabled: true },
          );
        } catch (error) {
          rearmError = errorMessage(error);
        }

        const pageStateResponse = await view.send('Runtime.evaluate', {
          expression: `JSON.stringify({ available: typeof window.showOpenFilePicker === 'function', activationSupported: Boolean(navigator.userActivation), isActive: navigator.userActivation?.isActive ?? null, hasBeenActive: navigator.userActivation?.hasBeenActive ?? null })`,
          returnByValue: true,
          userGesture: false,
        });
        const pageState = decodedProtocolValue(pageStateResponse);
        if (pageState?.available !== true) {
          return {
            status: 'unverified',
            showOpenFilePickerAvailable: false,
            freshNavigation: { url: freshPageUrl, completed: true },
            pageState,
            permissionEvidence,
            fileChooserInterceptionRearmed: Boolean(rearmedIntercept),
            rearmError,
            apiInvoked: false,
            limitation:
              'This Chromium context did not expose showOpenFilePicker; its no-activation rejection was not tested. Trusted-user-gesture bypass behavior also remains unverified.',
          };
        }

        if (pageState?.isActive !== false) {
          return {
            status: 'unverified',
            apiInvoked: false,
            showOpenFilePickerAvailable: true,
            freshNavigation: { url: freshPageUrl, completed: true },
            pageState,
            permissionEvidence,
            fileChooserInterceptionRearmed: Boolean(rearmedIntercept),
            rearmError,
            limitation:
              'The fresh document did not report navigator.userActivation.isActive === false. The API was not invoked to avoid risking native UI. Trusted-user-gesture bypass behavior remains unverified.',
          };
        }

        const counts = () => ({
          fileChooserOpened: view.events.filter(
            (event) => event.method === 'Page.fileChooserOpened',
          ).length,
          debuggerPermissionEvents: view.events.filter((event) =>
            /permission/i.test(event.method),
          ).length,
          electronPermissionCallbacks: permissionEvents.length,
        });
        const eventsFor = () => ({
          fileChooserOpened: view.events.filter(
            (event) => event.method === 'Page.fileChooserOpened',
          ),
          debuggerPermissionEvents: view.events.filter((event) =>
            /permission/i.test(event.method),
          ),
          electronPermissionCallbacks: [...permissionEvents],
        });
        const eventCountsBefore = counts();
        const relevantEventsBefore = eventsFor();
        const commandParams = {
          expression: `(async () => { try { const handles = await window.showOpenFilePicker({ multiple: false }); return { outcome: 'fulfilled', handleCount: handles.length }; } catch (error) { return { outcome: 'rejected', name: error?.name ?? null, message: String(error?.message ?? error) }; } })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        };
        let rawProtocolResponse = null;
        let protocolError = null;
        try {
          rawProtocolResponse = await view.send(
            'Runtime.evaluate',
            commandParams,
          );
        } catch (error) {
          protocolError = errorMessage(error);
        }
        // The Promise is awaited above; a short bounded settle also records
        // any delayed protocol or permission callbacks without interacting
        // with a native dialog.
        await ctx.sleep(100);
        const eventCountsAfter = counts();
        const relevantEventsAfter = eventsFor();
        const pageResult = decodedProtocolValue(rawProtocolResponse);
        const eventDifferences = Object.fromEntries(
          Object.keys(eventCountsBefore).map((key) => [
            key,
            eventCountsAfter[key] - eventCountsBefore[key],
          ]),
        );
        return {
          status: rawProtocolResponse ? 'observed' : 'error',
          showOpenFilePickerAvailable: true,
          apiInvoked: true,
          freshNavigation: { url: freshPageUrl, completed: true },
          pageState,
          permissionEvidence,
          fileChooserInterceptionRearmed: Boolean(rearmedIntercept),
          fileChooserInterceptionRearmResponse: rearmedIntercept,
          fileChooserInterceptionRearmError: rearmError,
          invocation: {
            method: 'Runtime.evaluate',
            params: commandParams,
            rawProtocolResponse,
            protocolError,
            pageResult,
          },
          eventCountsBefore,
          eventCountsAfter,
          eventDifferences: eventDifferences,
          relevantEventsBefore,
          relevantEventsAfter,
          observedSecurityError:
            pageResult?.outcome === 'rejected' &&
            pageResult?.name === 'SecurityError',
          zeroChooserAndPermissionEventDifferences: Object.values(
            eventDifferences,
          ).every((count) => count === 0),
          nativeDialogOpenedByProbe: false,
          trustedUserGestureBypass: {
            status: 'unverified',
            reason:
              'Only an explicit Runtime.evaluate call with userGesture:false on a freshly navigated document was attempted. This does not establish whether a trusted-user-gesture showOpenFilePicker bypasses Page.setInterceptFileChooserDialog.',
          },
        };
      },
    );
  }

  result.evidence = view?.evidence() ?? EMPTY_EVIDENCE;
  return result;
}

export async function runS2S3(ctx) {
  const S2 = await runS2(ctx);
  const S3 = await runS3(ctx);
  return { S2, S3 };
}
