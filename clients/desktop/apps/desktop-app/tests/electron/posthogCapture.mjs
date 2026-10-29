import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCaptureEndpoint(pathname) {
  return (
    /^\/batch\/?$/.test(pathname) ||
    /^\/i\/v\d+\/analytics\/events\/?$/.test(pathname) ||
    /^\/(?:i\/v\d+\/)?(?:e|s)\/?$/.test(pathname)
  );
}

function decodePayload(request, requestUrl, rawBody) {
  let body = rawBody;
  if (
    request.headers['content-type']?.includes(
      'application/x-www-form-urlencoded',
    )
  ) {
    const data = new URLSearchParams(body.toString()).get('data');
    if (data === null) throw new Error('PostHog form envelope has no data');
    body = Buffer.from(data, 'base64');
  }
  if (
    (body[0] === 0x1f && body[1] === 0x8b) ||
    requestUrl.searchParams.get('compression') === 'gzip' ||
    request.headers['content-encoding'] === 'gzip'
  ) {
    body = gunzipSync(body);
  }
  return JSON.parse(body.toString());
}

function normalizeEvents(payload) {
  const candidates = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.batch)
      ? payload.batch
      : [payload];
  if (!candidates.every(isRecord)) {
    throw new Error('PostHog capture payload contains a non-object event');
  }
  return candidates;
}

function responseBody() {
  return JSON.stringify({
    status: 1,
    featureFlags: {},
    sessionRecording: false,
    supportedCompression: ['gzip'],
  });
}

/**
 * Starts a hermetic PostHog collector on the exact configured loopback host
 * and port. Port 0 is accepted by node tests and reflected in `collector.url`.
 */
export async function startPostHogCapture({
  stubUrl = process.env.CANOPY_POSTHOG_STUB_URL,
  holdResponse,
} = {}) {
  if (!stubUrl) throw new Error('CANOPY_POSTHOG_STUB_URL is required');
  const configuredUrl = new URL(stubUrl);
  if (
    configuredUrl.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(configuredUrl.hostname)
  ) {
    throw new Error('PostHog capture URL must use an HTTP loopback host');
  }
  const configuredPort = Number(configuredUrl.port || 80);
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 0 ||
    configuredPort > 65_535
  ) {
    throw new Error('PostHog capture URL has an invalid port');
  }

  const requests = [];
  const events = [];
  const parseErrors = [];
  const heldResponses = new Set();
  let shutdownPromise;

  const server = createServer(async (request, response) => {
    response.setHeader(
      'Access-Control-Allow-Origin',
      request.headers.origin ?? 'null',
    );
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Content-Type', 'application/json');

    const requestPath = request.url ?? '/';
    const requestUrl = new URL(requestPath, configuredUrl);
    const recorded = {
      method: request.method ?? 'GET',
      path: requestPath,
      payload: undefined,
    };
    requests.push(recorded);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    let decodedEvents = [];
    if (
      request.method === 'POST' &&
      isCaptureEndpoint(requestUrl.pathname) &&
      rawBody.length > 0
    ) {
      try {
        recorded.payload = decodePayload(request, requestUrl, rawBody);
        decodedEvents = normalizeEvents(recorded.payload);
        events.push(...decodedEvents);
      } catch (error) {
        parseErrors.push(
          `${request.method} ${requestPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      holdResponse?.({
        request: recorded,
        events: decodedEvents,
      })
    ) {
      heldResponses.add(response);
      response.once('close', () => heldResponses.delete(response));
      return;
    }
    response.end(responseBody());
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(
      configuredPort,
      configuredUrl.hostname === '[::1]' ? '::1' : configuredUrl.hostname,
    );
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.closeAllConnections?.();
    throw new Error('PostHog capture server has no TCP address');
  }
  const boundUrl = new URL(configuredUrl);
  boundUrl.port = String(address.port);
  boundUrl.pathname = '';
  boundUrl.search = '';
  boundUrl.hash = '';

  const collector = {
    get url() {
      return boundUrl.toString().replace(/\/$/, '');
    },
    get heldResponseCount() {
      return heldResponses.size;
    },
    releaseHeldResponses({ statusCode = 500, body = '{}' } = {}) {
      for (const response of Array.from(heldResponses)) {
        if (!response.writableEnded) response.writeHead(statusCode).end(body);
      }
      heldResponses.clear();
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      return shutdownPromise;
    },
    requests,
    events,
    parseErrors,
  };
  return collector;
}

export function readPostHogCapture(collector) {
  return {
    requests: [...collector.requests],
    events: [...collector.events],
    parseErrors: [...collector.parseErrors],
  };
}

/**
 * Every rrweb node in the decoded events, flattened with its parent id.
 * rrweb nests children in a full snapshot but records each inserted node as a
 * separate `adds` entry with its `parentId`, so track parents explicitly.
 */
export function replayNodes(decoded) {
  const nodes = [];
  const visit = (node, parentId) => {
    if (!node || typeof node !== 'object') return;
    nodes.push({ ...node, parentId });
    for (const child of node.childNodes ?? []) visit(child, node.id);
  };
  for (const event of decoded) {
    if (event.type === 2) visit(event.data?.node, undefined);
    if (event.type === 3 && Array.isArray(event.data?.adds)) {
      for (const add of event.data.adds) visit(add.node, add.parentId);
    }
  }
  return nodes;
}

/** Nodes rrweb recorded directly under `parent`, from any snapshot or add. */
export function recordedChildren(nodes, parent) {
  return nodes.filter((node) => node.parentId === parent.id);
}

/** Decoded rrweb events the main window uploaded after `fromIndex`. */
export function mainReplaySince(collector, fromIndex) {
  return readPostHogCapture(collector)
    .events.slice(fromIndex)
    .filter(
      (event) =>
        event.event === '$snapshot' && event.properties?.surface === 'main',
    )
    .flatMap(decodePostHogSnapshotData);
}

/**
 * Every string value rrweb recorded for attribute `name`, from serialized
 * nodes (full snapshots and adds) and from later attribute mutations.
 */
export function recordedAttributeValues(decoded, name) {
  const values = [];
  for (const node of replayNodes(decoded)) {
    const value = node.attributes?.[name];
    if (typeof value === 'string') values.push(value);
  }
  for (const event of decoded) {
    if (event.type !== 3 || !Array.isArray(event.data?.attributes)) continue;
    for (const mutation of event.data.attributes) {
      const value = mutation?.attributes?.[name];
      if (typeof value === 'string') values.push(value);
    }
  }
  return values;
}

/**
 * Every text value rrweb recorded, from serialized text nodes (full snapshots
 * and adds) and from later text mutations. Attributes are not included.
 */
export function recordedTextValues(decoded) {
  const values = [];
  for (const node of replayNodes(decoded)) {
    if (node.type === 3 && typeof node.textContent === 'string') {
      values.push(node.textContent);
    }
  }
  for (const event of decoded) {
    if (event.type !== 3 || !Array.isArray(event.data?.texts)) continue;
    for (const mutation of event.data.texts) {
      if (typeof mutation?.value === 'string') values.push(mutation.value);
    }
  }
  return values;
}

/**
 * Every captured event as JSON, with `$snapshot` payloads decoded so a leak
 * check sees the recorded DOM rather than its compressed bytes.
 */
export function decodedCaptureWire(events) {
  return JSON.stringify(
    events.map((event) =>
      event?.event === '$snapshot'
        ? {
            ...event,
            properties: {
              ...event.properties,
              $snapshot_data: decodePostHogSnapshotData(event),
            },
          }
        : event,
    ),
  );
}

/** Decode rrweb's 2024-10 latin1 gzip fields without changing the capture. */
export function decodePostHogSnapshotData(event) {
  if (event?.event !== '$snapshot') return [];
  const snapshots = event.properties?.$snapshot_data;
  if (!Array.isArray(snapshots)) return [];
  const decodeField = (value) =>
    typeof value === 'string'
      ? JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString('utf8'))
      : value;
  return snapshots.map((snapshot) => {
    if (!isRecord(snapshot) || snapshot.cv !== '2024-10') return snapshot;
    if (snapshot.type === 2) {
      return { ...snapshot, data: decodeField(snapshot.data) };
    }
    if (!isRecord(snapshot.data)) return snapshot;
    const data = { ...snapshot.data };
    for (const field of ['texts', 'attributes', 'removes', 'adds']) {
      if (field in data) data[field] = decodeField(data[field]);
    }
    return { ...snapshot, data };
  });
}
