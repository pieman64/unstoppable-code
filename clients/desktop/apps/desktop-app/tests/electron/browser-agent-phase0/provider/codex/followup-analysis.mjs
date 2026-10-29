// Pure classifiers for the Codex follow-up comparison (October 2 plan).
//
// Everything here reads captured request JSON, tool exchanges and scripted
// signals. It never decides from a tool's *name*: a surface entry called
// `exec` is a wrapper declaration, not proof of host execution, and a
// scripted call that the runtime answered with an error is "unobserved"
// execution, not a denial. Statuses use the shared ledger vocabulary.

/** Primitives whose presence inside the wrapper isolate would be an exposure. */
export const ESCAPE_PRIMITIVES = Object.freeze([
  'require',
  'process',
  'fetch',
  'Deno',
  'Bun',
  'XMLHttpRequest',
  'WebSocket',
]);

/** Every key the scripted wrapper probe reports. */
export const WRAPPER_PROBE_KEYS = Object.freeze([
  ...ESCAPE_PRIMITIVES.map((name) => `typeof-${name}`),
  'dynamic-import-fs',
  'host-file-read',
  'env-read',
  'spawn',
  'loopback-fetch',
  'globals',
  'all-tools',
  'browser-call',
  'browser-wait-call',
]);

export const WRAPPER_PAYLOAD_MARKER = 'BAP0_PROBE_JSON:';

const sortStrings = (values) => [...values].sort();

/** Tool headings (### `name`) the wrapper's description declares as nested. */
export function parseExecNestedTools(description) {
  if (typeof description !== 'string') return [];
  const names = [];
  for (const match of description.matchAll(/^### `([^`\n]+)`\s*$/gm))
    names.push(match[1]);
  return names;
}

function declarationsOf(json) {
  const declarations = [];
  if (Array.isArray(json?.tools)) declarations.push(...json.tools);
  if (Array.isArray(json?.input))
    for (const item of json.input)
      if (item?.type === 'additional_tools' && Array.isArray(item.tools))
        declarations.push(...item.tools);
  return declarations;
}

/**
 * Advertised surface of one Responses request: every top-level declaration
 * (namespace members are qualified `namespace.name`) and the tools nested in
 * a code-mode wrapper's description.
 */
export function extractSurface(json) {
  const topLevel = [];
  for (const declaration of declarationsOf(json)) {
    if (Array.isArray(declaration?.tools)) {
      const namespace = declaration.name ?? declaration.type ?? null;
      for (const inner of declaration.tools)
        topLevel.push({
          namespace,
          name: inner?.name ?? inner?.type ?? 'unknown',
          type: inner?.type ?? 'unknown',
          qualified: `${namespace}.${inner?.name ?? inner?.type ?? 'unknown'}`,
          description:
            typeof inner?.description === 'string' ? inner.description : '',
        });
    } else {
      const name = declaration?.name ?? declaration?.type ?? 'unknown';
      topLevel.push({
        namespace: null,
        name,
        type: declaration?.type ?? 'unknown',
        qualified: name,
        description:
          typeof declaration?.description === 'string'
            ? declaration.description
            : '',
      });
    }
  }
  const wrapperEntry = topLevel.find(
    (entry) => entry.type === 'custom' && entry.name === 'exec',
  );
  const wrapper = wrapperEntry
    ? {
        present: true,
        name: wrapperEntry.qualified,
        nested: parseExecNestedTools(wrapperEntry.description),
      }
    : { present: false, name: null, nested: [] };
  return {
    topLevel: topLevel.map(({ description: _description, ...rest }) => rest),
    wrapper,
  };
}

/**
 * Compare a surface with the expected browser tool set.
 *
 * `direct`: expected tools declared top-level in the expected namespace (flat
 * dynamic tools land in `functions`). `wrapped`: expected tools only reachable
 * through the wrapper. A name that is both wrapper-nested and top-level is a
 * collision, as is a repeated qualified name or one bare name in two
 * namespaces without an explicit browser namespace. Explicit browser namespaces
 * disambiguate executor helpers. Whether the runtime routes a call correctly is a behavioural
 * question answered by `classifyWaitResolution`, not by this table.
 */
export function classifySurface(
  surface,
  expectedNames,
  { namespace = null } = {},
) {
  const expected = new Set(expectedNames);
  const nested = new Set(
    surface.wrapper.nested.map((name) =>
      namespace && name.startsWith(`${namespace}__`)
        ? name.slice(namespace.length + 2)
        : name,
    ),
  );
  const directNamespaces = new Set(
    namespace === null ? [null, 'functions'] : [namespace],
  );
  const direct = new Set();
  const wrapped = new Set();
  const extraTopLevel = new Set();
  for (const entry of surface.topLevel) {
    const isBrowser =
      expected.has(entry.name) &&
      directNamespaces.has(entry.namespace) &&
      !(surface.wrapper.present && nested.has(entry.name));
    if (isBrowser) direct.add(entry.name);
    else extraTopLevel.add(entry.qualified);
  }
  for (const name of nested) if (expected.has(name)) wrapped.add(name);

  const collisions = [];
  const originsByName = new Map();
  for (const entry of surface.topLevel) {
    if (
      namespace !== null &&
      expected.has(entry.name) &&
      !directNamespaces.has(entry.namespace)
    )
      continue;
    const origins = originsByName.get(entry.name) ?? [];
    origins.push(entry.qualified);
    originsByName.set(entry.name, origins);
  }
  for (const [name, origins] of originsByName) {
    if (!expected.has(name) && !nested.has(name)) continue;
    const distinct = new Set(origins);
    const wrapperCollides = surface.wrapper.present && nested.has(name);
    if (distinct.size < origins.length)
      collisions.push({
        name,
        kind: 'duplicate-qualified',
        origins: sortStrings(origins),
      });
    else if (wrapperCollides)
      collisions.push({
        name,
        kind: 'cross-layer',
        origins: sortStrings([...origins, `${surface.wrapper.name}:${name}`]),
      });
    else if (distinct.size > 1)
      collisions.push({
        name,
        kind: 'cross-namespace',
        origins: sortStrings(distinct),
      });
  }
  collisions.sort((a, b) => a.name.localeCompare(b.name));

  const reachable = new Set([...direct, ...wrapped]);
  const missing = sortStrings(
    [...expected].filter((name) => !reachable.has(name)),
  );
  const reachability =
    direct.size > 0 && wrapped.size > 0
      ? 'mixed'
      : direct.size > 0
        ? 'direct'
        : wrapped.size > 0
          ? 'wrapped-only'
          : 'none';
  const extra = sortStrings(extraTopLevel);
  return {
    reachability,
    direct: sortStrings(direct),
    wrapped: sortStrings(wrapped),
    missing,
    extraTopLevel: extra,
    extraWrapped: sortStrings(
      [...nested].filter((name) => !expected.has(name)),
    ),
    collisions,
    wrapperPresent: surface.wrapper.present,
    closed:
      reachability === 'direct' &&
      missing.length === 0 &&
      extra.length === 0 &&
      !surface.wrapper.present &&
      collisions.length === 0,
  };
}

function textOfOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output))
    return output
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part?.text === 'string'
            ? part.text
            : JSON.stringify(part),
      )
      .join('\n');
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

/** Calls in a request's input history paired with their outputs, in order. */
export function findToolExchanges(json) {
  const items = Array.isArray(json?.input) ? json.input : [];
  const exchanges = [];
  const byCallId = new Map();
  for (const item of items) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const namespace =
        typeof item.namespace === 'string'
          ? item.namespace.replace(/\.$/, '')
          : null;
      const raw =
        item.type === 'custom_tool_call' ? item.input : item.arguments;
      const exchange = {
        callId: item.call_id,
        callType: item.type,
        name: item.name,
        namespace,
        qualified: namespace ? `${namespace}.${item.name}` : item.name,
        inputBytes: Buffer.byteLength(
          typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
        ),
        answered: false,
        outputText: undefined,
      };
      exchanges.push(exchange);
      byCallId.set(item.call_id, exchange);
    } else if (
      typeof item?.type === 'string' &&
      item.type.endsWith('_output') &&
      byCallId.has(item.call_id)
    ) {
      const exchange = byCallId.get(item.call_id);
      exchange.answered = true;
      exchange.outputText = textOfOutput(item.output);
    }
  }
  return exchanges;
}

/**
 * Who answered a scripted browser `wait` call? Only the host's own record of
 * receiving it (right tool, right namespace) counts as the browser tool; any
 * other answer means the name resolved elsewhere.
 */
export function classifyWaitResolution({
  hostCalls,
  exchange,
  expectedNamespace = null,
}) {
  if (!exchange || exchange.answered !== true)
    return {
      handledBy: 'unobserved',
      reason: 'no answered wait exchange in the next request',
    };
  const hostHit = (hostCalls ?? []).some(
    (call) =>
      call.tool === 'wait' && (call.namespace ?? null) === expectedNamespace,
  );
  return hostHit
    ? {
        handledBy: 'host-dynamic-tool',
        outputSnippet: (exchange.outputText ?? '').slice(0, 200),
      }
    : {
        handledBy: 'other-handler',
        outputSnippet: (exchange.outputText ?? '').slice(0, 200),
      };
}

function parseProbePayload(outputText) {
  const text = typeof outputText === 'string' ? outputText : '';
  const index = text.indexOf(WRAPPER_PAYLOAD_MARKER);
  if (index < 0) return null;
  const rest = text.slice(index + WRAPPER_PAYLOAD_MARKER.length);
  const line = rest.split('\n', 1)[0];
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Classify one scripted wrapper (`exec`) attempt.
 *
 * - `pass`: JS demonstrably ran, no escape primitive was exposed, no probe
 *   reached the host, independent evidence is clean, and the valid browser
 *   control reached the host tool.
 * - `fail`: any observed escape or an exposed escape primitive.
 * - `blocked`: JS ran and was contained but the browser control did not run.
 * - `unavailable`: the wrapper was not advertised and the call produced no JS.
 * - `unobserved`: no answer, or a tool error: execution was never observed.
 *
 * `evidence` is independent of the script (marker file, loopback listener
 * hits, host-tool call count) and always wins over what the script reports.
 */
export function classifyWrapperRun({
  exchange,
  outboundText,
  evidence,
  wrapperAdvertised = true,
}) {
  const escapes = new Set();
  const outbound = typeof outboundText === 'string' ? outboundText : '';
  if (evidence.hostCanary && outbound.includes(evidence.hostCanary))
    escapes.add('host-canary-outbound');
  if (evidence.envCanary && outbound.includes(evidence.envCanary))
    escapes.add('env-canary-outbound');
  if (evidence.spawnMarkerExists) escapes.add('spawn');
  if ((evidence.loopbackHits ?? 0) > 0) escapes.add('loopback-fetch');

  const payload = exchange?.answered
    ? parseProbePayload(exchange.outputText)
    : null;
  const exposed = [];
  if (payload) {
    for (const key of ['host-file-read', 'dynamic-import-fs']) {
      const result = payload[key];
      if (
        result?.ok === true &&
        evidence.hostCanary &&
        String(result.v).includes(evidence.hostCanary)
      )
        escapes.add(key);
    }
    const env = payload['env-read'];
    if (
      env?.ok === true &&
      evidence.envCanary &&
      String(env.v).includes(evidence.envCanary)
    )
      escapes.add('env-read');
    if (payload.spawn?.ok === true) escapes.add('spawn');
    if (
      payload['loopback-fetch']?.ok === true &&
      /^\d{3}$/.test(String(payload['loopback-fetch'].v))
    )
      escapes.add('loopback-fetch');
    for (const name of ESCAPE_PRIMITIVES) {
      const result = payload[`typeof-${name}`];
      if (result?.ok === true && result.v !== 'undefined')
        exposed.push(`typeof-${name}`);
    }
  }
  const escapeList = sortStrings(escapes);
  const positiveControl =
    payload?.['browser-call']?.ok === true &&
    (evidence.hostToolCallsDuringExec ?? 0) >= 1;
  const base = {
    jsExecuted: payload !== null,
    escapes: escapeList,
    exposedPrimitives: exposed,
    positiveControl,
    // Permitted gateway actions invoked from inside the wrapper: the script
    // reported success AND the host independently recorded the call.
    permittedActions: {
      observe: positiveControl,
      wait:
        payload?.['browser-wait-call']?.ok === true &&
        (evidence.hostWaitCallsDuringExec ?? 0) >= 1,
    },
  };
  if (escapeList.length > 0 || exposed.length > 0)
    return { ...base, status: 'fail', reason: 'escape-or-exposure-observed' };
  if (payload) {
    return positiveControl
      ? { ...base, status: 'pass', reason: 'contained-with-positive-control' }
      : { ...base, status: 'blocked', reason: 'browser-control-did-not-run' };
  }
  if (!exchange)
    return { ...base, status: 'unobserved', reason: 'no-exchange' };
  if (!wrapperAdvertised)
    return { ...base, status: 'unavailable', reason: 'wrapper-not-advertised' };
  return {
    ...base,
    status: 'unobserved',
    reason: exchange.answered ? 'tool-error' : 'no-answer',
    outputSnippet: (exchange.outputText ?? '').slice(0, 300),
  };
}

/**
 * Notify suppression: a live control on the pooled process, silence on the
 * thread-scoped override, and the control live again afterwards.
 */
export function classifyNotify({ baseline, suppressed, after }) {
  const known = (value) => Number.isInteger(value);
  if (!known(baseline) || !known(suppressed) || !known(after))
    return { status: 'unobserved', reason: 'a notify count was not collected' };
  if (baseline === 0)
    return {
      status: 'blocked',
      reason: 'notify never fired in the positive control',
    };
  if (suppressed > 0)
    return {
      status: 'fail',
      reason: 'notify still fired with the thread-scoped override',
    };
  if (after === 0)
    return {
      status: 'fail',
      reason:
        'a later thread on the same pooled process lost notify (pool-wide effect)',
    };
  return { status: 'pass', reason: 'suppressed on the override thread only' };
}

const numberOr = (value) => (Number.isFinite(value) ? value : null);

/**
 * Context usage signals from `thread/tokenUsage/updated` events. `last` is
 * the most recent request (context size); `total` is cumulative and billed.
 * Scripted values are synthetic: this proves plumbing, not tokenization.
 */
export function classifyContextSignals(events, { threshold }) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (list.length === 0)
    return {
      status: 'unobserved',
      threshold,
      eventCount: 0,
      synthetic: true,
      note: 'no thread/tokenUsage/updated events were observed',
    };
  let firstContextCrossing = null;
  let firstBilledTotalCrossing = null;
  list.forEach((event, index) => {
    const last = numberOr(event.last?.inputTokens);
    const total = numberOr(event.total?.inputTokens);
    if (firstContextCrossing === null && last !== null && last >= threshold)
      firstContextCrossing = {
        index,
        lastInputTokens: last,
        totalInputTokens: total,
      };
    if (
      firstBilledTotalCrossing === null &&
      total !== null &&
      total >= threshold
    )
      firstBilledTotalCrossing = {
        index,
        lastInputTokens: last,
        totalInputTokens: total,
      };
  });
  return {
    status: 'measured',
    threshold,
    eventCount: list.length,
    modelContextWindow: numberOr(list.at(-1).modelContextWindow),
    maxLastInputTokens: Math.max(
      ...list.map((event) => numberOr(event.last?.inputTokens) ?? 0),
    ),
    firstContextCrossing,
    firstBilledTotalCrossing,
    synthetic: true,
    note: 'scripted mock usage values: usage plumbing only, not tokenizer calibration; cumulative totals are billed usage, last-request input is the context signal',
  };
}
