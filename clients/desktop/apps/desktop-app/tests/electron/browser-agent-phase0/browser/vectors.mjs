// S0.3 per-tab enforcement probe: the vector matrix and its evidence rules.
//
// Planning-only (docs/planning/2026-09-24-managed-browser-delegation/
// 08-tab-enforcement-spike.md). Pure data and pure functions: the Electron
// probe app collects raw evidence per case, and this module decides what that
// evidence proves. A case never passes because a policy "would" refuse it; it
// passes only when the attempt was exercised, an attributed mechanism acted,
// and the destination listener's ground truth agrees.

/** Binding kinds the probe qualifies. */
export const BINDINGS = Object.freeze(['shared', 'task']);

/** Per-case and per-vector statuses. */
export const STATUS = Object.freeze({
  pass: 'pass', // exercised, attributed mechanism observed, ground truth agrees
  fail: 'fail', // exercised and the policy leaked or caused collateral impact
  unobserved: 'unobserved', // not exercised, timed out, or no mechanism evidence
  unsupported: 'unsupported', // the platform/binary lacks the API under test
});

/**
 * Required vectors. `kind` selects the evidence rule. `network` vectors use
 * destination listener hits as ground truth. `resolvedAddress` vectors only
 * pass on a gateway decision against the actual resolved address: a URL-layer
 * hostname cancel or a webContentsId never qualifies them.
 */
export const VECTORS = Object.freeze([
  v(
    'url.top-level',
    'network',
    'Top-level navigation to loopback literal and recorder/control origin',
  ),
  v(
    'url.encoded-local',
    'network',
    'Encoded loopback forms (hex, integer, short, mapped IPv6)',
  ),
  v(
    'address.resolved-name',
    'network',
    'Synthetic names resolving to loopback / metadata',
    { resolvedAddress: true },
  ),
  v(
    'address.dns-rebinding',
    'network',
    'Name that resolves public first, loopback second',
    { resolvedAddress: true },
  ),
  v(
    'address.public-allowed',
    'network',
    'Positive control: a synthetic public destination stays reachable',
  ),
  v(
    'recorder.control-origin',
    'network',
    'Probe recorder/control origin is denied to the leased tab',
  ),
  v(
    'frame.subframe',
    'network',
    'Subframe load, subframe re-navigation and framed form POST',
  ),
  v('fetch.page', 'network', 'fetch and POST from the page'),
  v(
    'redirect.top-level',
    'network',
    'Top-level redirect from exception and public origins to local targets',
  ),
  v(
    'redirect.subresource',
    'network',
    'fetch through a public redirector to local targets',
  ),
  v(
    'websocket.page',
    'network',
    'WebSocket from the page to literal and named local targets',
  ),
  v('worker.dedicated', 'network', 'Dedicated worker fetch and WebSocket'),
  v('worker.shared', 'network', 'Shared worker fetch'),
  v(
    'worker.service',
    'network',
    'Service worker fetch and fetch-event re-issue',
  ),
  v(
    'chooser.file',
    'handler',
    'File chooser intercepted with Page.setInterceptFileChooserDialog',
  ),
  v('chooser.device', 'handler', 'WebUSB device chooser'),
  v(
    'download.cancel',
    'handler',
    'Downloads started by the leased tab are cancelled',
  ),
  v(
    'popup.deny',
    'handler',
    'window.open and target=_blank from the leased tab are denied',
  ),
  v(
    'external-protocol.deny',
    'handler',
    'Unregistered external scheme is never launched',
  ),
  v(
    'permission.deny',
    'handler',
    'Notifications, geolocation, clipboard-read and media are denied',
  ),
]);

function v(id, kind, summary, extra = {}) {
  return Object.freeze({ id, kind, summary, resolvedAddress: false, ...extra });
}

export const VECTOR_IDS = Object.freeze(VECTORS.map((entry) => entry.id));

/**
 * Builds the finite case list for one binding. Target URLs are templates that
 * the app fills in with live ports and a per-case nonce.
 *
 * Template tokens: {local} = local canary port, {user} = user-service port,
 * {recorder} = recorder port, {vector} = vector fixture origin, {n} = nonce.
 * `destination` names the canary whose hits are ground truth for the case.
 *
 * @param {'shared'|'task'} binding
 */
export function buildCases(binding) {
  /** @type {Array<Record<string, unknown>>} */
  const cases = [];
  const add = (vector, id, spec) =>
    cases.push({
      caseId: `${binding}:${vector}:${id}`,
      binding,
      vector,
      tab: 'leased',
      expect: 'deny',
      ...spec,
    });

  const lit = 'http://127.0.0.1:{local}/hit/{n}';
  const name = 'http://local.s03.test:{local}/hit/{n}';
  const wsLit = 'ws://127.0.0.1:{local}/ws/{n}';
  const wsName = 'ws://local.s03.test:{local}/ws/{n}';
  const local = { destination: 'local' };

  add('url.top-level', 'literal', {
    action: 'navigate',
    target: lit,
    ...local,
  });
  add('url.top-level', 'recorder', {
    action: 'navigate',
    target: 'http://127.0.0.1:{recorder}/__probe/hits?n={n}',
    destination: 'recorder',
  });
  add('url.top-level', 'credentials', {
    action: 'navigate',
    target: 'http://user:pw@public.s03.test/hit/{n}',
    destination: 'public',
  });
  for (const [id, host] of [
    ['hex', '0x7f000001'],
    ['integer', '2130706433'],
    ['short', '127.1'],
    ['octal', '0177.0.0.1'],
    ['percent', '%31%32%37.0.0.1'],
    ['mapped-ipv6', '[::ffff:127.0.0.1]'],
  ]) {
    add('url.encoded-local', id, {
      action: 'navigate',
      target: `http://${host}:{local}/hit/{n}`,
      ...local,
    });
  }
  add('address.resolved-name', 'navigate', {
    action: 'navigate',
    target: name,
    ...local,
  });
  add('address.resolved-name', 'fetch', {
    action: 'vector',
    page: 'fetch',
    target: name,
    ...local,
  });
  add('address.resolved-name', 'metadata', {
    action: 'vector',
    page: 'fetch',
    target: 'http://metadata.s03.test/hit/{n}',
    destination: 'none',
    requireGatewayDeny: true,
  });
  add('address.dns-rebinding', 'first-public', {
    action: 'vector',
    page: 'fetch',
    target: 'http://rebind.s03.test:{local}/hit/{n}',
    destination: 'public',
    expect: 'allow',
    rebindStep: 0,
  });
  add('address.dns-rebinding', 'second-loopback', {
    action: 'vector',
    page: 'fetch',
    target: 'http://rebind.s03.test:{local}/hit/{n}',
    ...local,
    rebindStep: 1,
  });
  add('address.public-allowed', 'fetch', {
    action: 'vector',
    page: 'fetch',
    target: 'http://public.s03.test/hit/{n}',
    destination: 'public',
    expect: 'allow',
  });
  add('address.public-allowed', 'frame', {
    action: 'vector',
    page: 'frame',
    target: 'http://public.s03.test/hit/{n}',
    destination: 'public',
    expect: 'allow',
  });
  add('recorder.control-origin', 'fetch', {
    action: 'vector',
    page: 'fetch',
    target: 'http://127.0.0.1:{recorder}/__probe/hits?n={n}',
    destination: 'recorder',
  });
  add('frame.subframe', 'literal', {
    action: 'vector',
    page: 'frame',
    target: lit,
    ...local,
  });
  add('frame.subframe', 'name', {
    action: 'vector',
    page: 'frame',
    target: name,
    ...local,
    resolvedAddress: true,
  });
  add('frame.subframe', 'renavigate', {
    action: 'vector',
    page: 'frame-navigate',
    target: lit,
    ...local,
  });
  add('frame.subframe', 'form-post', {
    action: 'vector',
    page: 'form-post-frame',
    target: lit,
    ...local,
  });
  add('fetch.page', 'literal', {
    action: 'vector',
    page: 'fetch',
    target: lit,
    ...local,
  });
  add('fetch.page', 'post', {
    action: 'vector',
    page: 'xhr-post',
    target: lit,
    ...local,
  });
  add('fetch.page', 'name-post', {
    action: 'vector',
    page: 'xhr-post',
    target: name,
    ...local,
    resolvedAddress: true,
  });
  add('redirect.top-level', 'exception-to-literal', {
    action: 'navigate',
    target: '{vector}/s03/redirect?code=302&to=' + enc(lit),
    ...local,
  });
  add('redirect.top-level', 'public-to-name', {
    action: 'navigate',
    target: 'http://public.s03.test/redirect?code=302&to=' + enc(name),
    ...local,
    resolvedAddress: true,
  });
  add('redirect.subresource', 'public-to-literal', {
    action: 'vector',
    page: 'fetch',
    target: 'http://public.s03.test/redirect?code=307&to=' + enc(lit),
    ...local,
  });
  add('redirect.subresource', 'public-to-name', {
    action: 'vector',
    page: 'fetch',
    target: 'http://public.s03.test/redirect?code=302&to=' + enc(name),
    ...local,
    resolvedAddress: true,
  });
  add('websocket.page', 'literal', {
    action: 'vector',
    page: 'websocket',
    target: wsLit,
    ...local,
  });
  add('websocket.page', 'name', {
    action: 'vector',
    page: 'websocket',
    target: wsName,
    ...local,
    resolvedAddress: true,
  });
  add('worker.dedicated', 'fetch-literal', {
    action: 'vector',
    page: 'dedicated-worker',
    target: lit,
    ...local,
  });
  add('worker.dedicated', 'fetch-name', {
    action: 'vector',
    page: 'dedicated-worker',
    target: name,
    ...local,
    resolvedAddress: true,
  });
  add('worker.dedicated', 'ws-literal', {
    action: 'vector',
    page: 'dedicated-worker-ws',
    target: wsLit,
    ...local,
  });
  add('worker.shared', 'fetch-literal', {
    action: 'vector',
    page: 'shared-worker',
    target: lit,
    ...local,
  });
  add('worker.shared', 'fetch-name', {
    action: 'vector',
    page: 'shared-worker',
    target: name,
    ...local,
    resolvedAddress: true,
  });
  add('worker.service', 'fetch-literal', {
    action: 'vector',
    page: 'service-worker',
    target: lit,
    ...local,
  });
  add('worker.service', 'fetch-name', {
    action: 'vector',
    page: 'service-worker',
    target: name,
    ...local,
    resolvedAddress: true,
  });
  add('worker.service', 'intercept-literal', {
    action: 'vector',
    page: 'service-worker-intercept',
    target: lit,
    ...local,
  });
  add('chooser.file', 'input-click', {
    action: 'vector',
    page: 'file-chooser',
    manual: true,
    target: '{vector}/s03/blank',
    destination: 'none',
    handler: 'file-chooser',
  });
  add('chooser.device', 'usb', {
    action: 'vector',
    page: 'device-chooser',
    manual: true,
    target: '{vector}/s03/blank',
    destination: 'none',
    handler: 'device',
  });
  add('download.cancel', 'anchor', {
    action: 'vector',
    page: 'download-anchor',
    manual: true,
    target: '{vector}/s03/download/{n}.bin',
    destination: 'none',
    handler: 'download',
  });
  add('download.cancel', 'navigation', {
    action: 'navigate',
    target: '{vector}/s03/download/{n}.bin',
    destination: 'none',
    handler: 'download',
  });
  add('popup.deny', 'window-open', {
    action: 'vector',
    page: 'popup-window-open',
    manual: true,
    target: '{vector}/s03/nav-result?n={n}',
    destination: 'none',
    handler: 'popup',
  });
  add('popup.deny', 'anchor', {
    action: 'vector',
    page: 'popup-anchor',
    manual: true,
    target: '{vector}/s03/nav-result?n={n}',
    destination: 'none',
    handler: 'popup',
  });
  add('external-protocol.deny', 'iframe', {
    action: 'vector',
    page: 'external-protocol',
    manual: true,
    target: 's03-probe-unregistered://launch/{n}',
    destination: 'none',
    handler: 'external',
  });
  add('external-protocol.deny', 'top-level', {
    action: 'navigate',
    target: 's03-probe-unregistered://top/{n}',
    destination: 'none',
    handler: 'external',
  });
  add('permission.deny', 'all', {
    action: 'vector',
    page: 'permissions',
    manual: true,
    query: 'deadline=9000',
    target: '{vector}/s03/blank',
    destination: 'none',
    handler: 'permission',
  });

  if (binding === 'shared') {
    // The user's own tab in the same named profile must keep working: its
    // loopback "user service", worker traffic, pop-ups, downloads, and
    // permission grants are unchanged by the neighbouring lease.
    const control = (vector, id, spec) =>
      cases.push({
        caseId: `${binding}:${vector}:control-${id}`,
        binding,
        vector,
        tab: 'control',
        expect: 'allow',
        ...spec,
      });
    const user = 'http://127.0.0.1:{user}/hit/{n}';
    const userName = 'http://dev.s03.test:{user}/hit/{n}';
    const userService = { destination: 'user' };
    control('fetch.page', 'user-service', {
      action: 'vector',
      page: 'fetch',
      target: user,
      ...userService,
    });
    control('address.resolved-name', 'user-service-name', {
      action: 'vector',
      page: 'fetch',
      target: userName,
      ...userService,
    });
    control('url.top-level', 'user-service', {
      action: 'navigate',
      target: user,
      ...userService,
    });
    control('frame.subframe', 'user-service', {
      action: 'vector',
      page: 'frame',
      target: user,
      ...userService,
    });
    control('websocket.page', 'user-service', {
      action: 'vector',
      page: 'websocket',
      target: 'ws://127.0.0.1:{user}/ws/{n}',
      ...userService,
    });
    control('worker.dedicated', 'user-service', {
      action: 'vector',
      page: 'dedicated-worker',
      target: user,
      ...userService,
    });
    control('worker.shared', 'user-service', {
      action: 'vector',
      page: 'shared-worker',
      target: user,
      ...userService,
    });
    control('worker.service', 'user-service', {
      action: 'vector',
      page: 'service-worker',
      target: user,
      ...userService,
    });
    control('download.cancel', 'anchor', {
      action: 'vector',
      page: 'download-anchor',
      manual: true,
      target: '{vector}/s03/download/{n}.bin',
      destination: 'none',
      handler: 'download',
    });
    control('popup.deny', 'window-open', {
      action: 'vector',
      page: 'popup-window-open',
      manual: true,
      target: '{vector}/s03/nav-result?n={n}',
      destination: 'none',
      handler: 'popup',
    });
    control('permission.deny', 'notifications', {
      action: 'vector',
      page: 'permissions',
      manual: true,
      query: 'only=notifications',
      target: '{vector}/s03/blank',
      destination: 'none',
      handler: 'permission',
    });
  }
  return cases.map((entry) => Object.freeze(entry));
}

function enc(value) {
  return encodeURIComponent(value);
}

/**
 * Classifies one executed case from its raw evidence.
 *
 * @param {{
 *   binding: 'shared'|'task', tab: 'leased'|'control', expect: 'deny'|'allow',
 *   vector: string, handler?: string, destination: string,
 *   resolvedAddress?: boolean, requireGatewayDeny?: boolean,
 * }} spec
 * @param {{
 *   exercised: boolean, unsupported?: string|null, error?: string|null,
 *   destinationHits: number,
 *   listenerDenies: Array<{ attributed: boolean }>,
 *   gatewayDenies: Array<{ attributed: boolean, addressClass: string }>,
 *   handlerEvents: Array<{ kind: string, decision: string, attributed: boolean }>,
 *   pageOutcome?: string|null,
 *   handlerSatisfied?: boolean,
 * }} evidence
 * @returns {{ status: string, mechanisms: string[], reason: string }}
 */
export function classifyCase(spec, evidence) {
  if (evidence.unsupported) {
    return {
      status: STATUS.unsupported,
      mechanisms: [],
      reason: evidence.unsupported,
    };
  }
  if (!evidence.exercised) {
    return {
      status: STATUS.unobserved,
      mechanisms: [],
      reason: evidence.error ?? 'not exercised',
    };
  }
  const sessionScoped = spec.binding === 'task';
  // In the task profile every request in the Session belongs to the task, so
  // an unattributed decision is still scoped to it. In the shared profile only
  // decisions attributed to the leased tab count.
  const counts = (event) =>
    event.attributed || (sessionScoped && spec.tab === 'leased');
  const mechanisms = [];
  if (evidence.listenerDenies.some(counts)) mechanisms.push('webRequest-url');
  if (evidence.gatewayDenies.some(counts))
    mechanisms.push('gateway-resolved-address');
  const handlerDenies = evidence.handlerEvents.filter(
    (event) => event.decision === 'deny' && counts(event),
  );
  for (const event of handlerDenies) {
    const name = `handler:${event.kind}`;
    if (!mechanisms.includes(name)) mechanisms.push(name);
  }

  if (spec.expect === 'allow') {
    const blockedByLease =
      evidence.listenerDenies.length > 0 ||
      evidence.gatewayDenies.length > 0 ||
      handlerDenies.length > 0;
    if (blockedByLease) {
      return {
        status: STATUS.fail,
        mechanisms,
        reason: 'collateral: an allowed request was denied',
      };
    }
    if (spec.destination !== 'none') {
      return evidence.destinationHits > 0
        ? {
            status: STATUS.pass,
            mechanisms: ['reached-destination'],
            reason: 'allowed destination reached',
          }
        : {
            status: STATUS.unobserved,
            mechanisms: [],
            reason: 'allowed destination was not reached',
          };
    }
    return evidence.handlerSatisfied
      ? {
          status: STATUS.pass,
          mechanisms: ['handler-allowed'],
          reason: 'control behaviour unchanged',
        }
      : {
          status: STATUS.unobserved,
          mechanisms: [],
          reason: 'control behaviour not observed',
        };
  }

  if (evidence.destinationHits > 0) {
    return {
      status: STATUS.fail,
      mechanisms,
      reason: `leak: destination received ${evidence.destinationHits} request(s)`,
    };
  }
  if (spec.handler) {
    if (handlerDenies.length === 0) {
      return {
        status: STATUS.unobserved,
        mechanisms,
        reason: `no attributed ${spec.handler} denial observed`,
      };
    }
    if (evidence.handlerSatisfied === false) {
      return {
        status: STATUS.fail,
        mechanisms,
        reason: 'handler denied but the page observed the capability',
      };
    }
    return {
      status: STATUS.pass,
      mechanisms,
      reason: 'attributed handler denial, no side effect observed',
    };
  }
  const vectorNeedsAddress = VECTORS.some(
    (entry) => entry.id === spec.vector && entry.resolvedAddress,
  );
  if (spec.requireGatewayDeny || spec.resolvedAddress || vectorNeedsAddress) {
    return mechanisms.includes('gateway-resolved-address')
      ? {
          status: STATUS.pass,
          mechanisms,
          reason: 'denied on the actual resolved address',
        }
      : {
          status: STATUS.unobserved,
          mechanisms,
          reason:
            'no resolved-address denial observed; a hostname cancel or webContentsId does not qualify',
        };
  }
  return mechanisms.length > 0
    ? {
        status: STATUS.pass,
        mechanisms,
        reason: 'attributed denial, destination not reached',
      }
    : {
        status: STATUS.unobserved,
        mechanisms,
        reason: 'no attributed denial observed and no destination hit',
      };
}

const RANK = {
  [STATUS.fail]: 3,
  [STATUS.unsupported]: 2,
  [STATUS.unobserved]: 1,
  [STATUS.pass]: 0,
};

/**
 * Aggregates classified cases into per-binding vector verdicts, refusals, and
 * the overall qualification. Any vector that is not `pass` for a binding makes
 * that binding unqualified and is listed as a binding that must be refused.
 *
 * @param {Array<{ binding: string, vector: string, status: string, caseId: string, reason: string }>} results
 * @param {{ platform: string, windowsEvidence?: boolean }} context
 */
export function aggregate(results, context) {
  const bindings = {};
  for (const binding of BINDINGS) {
    const vectors = {};
    for (const entry of VECTORS) {
      const cases = results.filter(
        (result) => result.binding === binding && result.vector === entry.id,
      );
      let status = cases.length === 0 ? STATUS.unobserved : STATUS.pass;
      for (const result of cases)
        if (RANK[result.status] > RANK[status]) status = result.status;
      vectors[entry.id] = {
        status,
        cases: cases.map((result) => ({
          caseId: result.caseId,
          status: result.status,
          reason: result.reason,
        })),
      };
    }
    const refused = Object.entries(vectors)
      .filter(([, verdict]) => verdict.status !== STATUS.pass)
      .map(([id, verdict]) => ({ vector: id, status: verdict.status }));
    bindings[binding] = {
      qualified: refused.length === 0,
      vectors,
      mustRefuse: refused,
    };
  }
  const platforms = {
    darwin: context.platform === 'darwin' ? 'observed-this-run' : 'not-run',
    win32: context.windowsEvidence ? 'observed-this-run' : 'outstanding',
  };
  const reasons = [
    'production composition not qualified: BrowserProfileNetworkPolicy has no composition seam and no resolving gateway',
  ];
  for (const binding of BINDINGS) {
    if (!bindings[binding].qualified)
      reasons.push(
        `${binding}: ${bindings[binding].mustRefuse.length} vector(s) unproved`,
      );
  }
  if (platforms.win32 !== 'observed-this-run')
    reasons.push('Windows qualification outstanding');
  if (platforms.darwin !== 'observed-this-run')
    reasons.push('macOS qualification not run');
  const qualified =
    BINDINGS.every((binding) => bindings[binding].qualified) &&
    platforms.darwin === 'observed-this-run' &&
    platforms.win32 === 'observed-this-run';
  return {
    qualified,
    bindings,
    platforms,
    reasons,
    // Separate from probe qualification: the probe's listener and gateway are
    // disposable models. Production BrowserProfileNetworkPolicy has no
    // composition seam and no resolving gateway, so nothing here qualifies it.
    productionCompositionQualified: false,
  };
}
