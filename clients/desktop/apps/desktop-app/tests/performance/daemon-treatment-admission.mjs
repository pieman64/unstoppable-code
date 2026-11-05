// Fail-closed trial admission for daemon Files treatment measurements. Inputs
// are the read-only production observers (CAN-4604). Build identity and
// route/renderer evidence decide admission; no Labs state is read.

// Off/on labels describe historical artifact arms, not a product toggle.
export const TREATMENT_ARMS = Object.freeze(['off', 'on']);

const MAIN_SOURCE = 'desktop-main-files-singleton-v1';
const RENDERER_SOURCE = 'desktop-renderer-file-list-store-v1';
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function verdict(reasons, extra = {}) {
  return { admitted: reasons.length === 0, reasons, ...extra };
}

function counterDeltas(before, after) {
  const delta = {};
  for (const key of new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]))
    delta[key] = (after?.[key] ?? 0) - (before?.[key] ?? 0);
  return delta;
}

/**
 * Main-process Files evidence over one measured interval. `before` is the
 * observer snapshot taken at the interval start; when its route is `null`
 * (first use: the lazy route did not exist), `after` must have been read with
 * cursor `{ observerId, sequence: 0 }` so the whole journal is covered.
 * `operations` lists the Files operations the workload may issue, and
 * `platform` is the host's `process.platform`.
 */
export function admitMainInterval({
  before,
  after,
  arm,
  operations,
  platform,
}) {
  if (
    before?.source !== MAIN_SOURCE ||
    after?.source !== MAIN_SOURCE ||
    !before.counters ||
    !after.counters
  )
    return verdict(['main Files observer missing']);
  if (!isRouteSnapshot(after.route))
    return verdict(['Files route evidence missing']);
  if (before.route !== null && !isRouteSnapshot(before.route))
    return verdict(['Files route evidence malformed']);
  const { reasons: readReasons, starts } = pairedReads(
    after.route,
    arm,
    operations,
    platform,
  );
  const reasons = [
    ...journalReasons(before, after, arm),
    ...readReasons,
    ...counterReasons(before.counters, after.counters, arm, platform, starts),
  ];
  return verdict(reasons, { starts });
}

function isRouteSnapshot(route) {
  return (
    typeof route?.cursor?.observerId === 'string' &&
    isCount(route.cursor.sequence) &&
    isCount(route.generation) &&
    Array.isArray(route.entries)
  );
}

function journalReasons(before, after, arm) {
  const reasons = [];
  const route = after.route;
  const start = before.route?.cursor ?? null;
  if (start && start.observerId !== route.cursor.observerId)
    reasons.push('route observer changed');
  if (!route.complete) reasons.push('route journal interval incomplete');
  if (route.disposed) reasons.push('route disposed');
  if (route.enabled !== (arm === 'on'))
    reasons.push('route treatment is not the arm');
  if (before.route && before.route.generation !== route.generation)
    reasons.push('route generation changed');
  const first = start?.sequence ?? 0;
  if (
    route.entries.some(
      (entry, index) => entry.sequence !== first + index + 1,
    ) ||
    first + route.entries.length !== route.cursor.sequence
  )
    reasons.push('route journal sequence gap');
  if (
    !isCount(before.counters.generation) ||
    before.counters.generation !== after.counters.generation
  )
    reasons.push('counter generation changed');
  if (before.counters.overflow !== 0 || after.counters.overflow !== 0)
    reasons.push('counter overflow');
  if (new Set(route.entries.map((entry) => entry.senderId)).size > 1)
    reasons.push('ambiguous sender attribution');
  return reasons;
}

// Every Files read the route journals. Production selects all of them since
// CAN-5556; the read-route table (daemon-read-route-guard.ts) keeps `file`,
// `search` and `link` direct on Windows until CAN-4732.
const MEASURED_OPERATIONS = Object.freeze([
  'roots',
  'directory',
  'file',
  'search',
  'link',
]);
const HOST_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const DIRECT_ON_PLATFORMS = Object.freeze({
  file: ['win32'],
  search: ['win32'],
  link: ['win32'],
});

/**
 * The backend the arm's reads of `operation` must use on `platform`, or
 * `null` when that depends on a host platform the trial did not name.
 */
export function armBackend(operation, arm, platform) {
  if (arm !== 'on') return 'direct';
  const direct = DIRECT_ON_PLATFORMS[operation];
  if (!direct) return 'daemon';
  if (!HOST_PLATFORMS.has(platform)) return null;
  return direct.includes(platform) ? 'direct' : 'daemon';
}

/**
 * Every start has one successful finish on the arm's backend. The journal
 * carries no caller or scope, so an on-arm read the guard keeps direct for
 * those (an excluded workspace, a host-base link) rejects like a misrouted
 * one: neither is treatment evidence.
 */
function pairedReads(route, arm, operations, platform) {
  const reasons = [];
  const starts = Object.fromEntries(
    MEASURED_OPERATIONS.map((operation) => [operation, 0]),
  );
  const open = new Map();
  const seen = new Set();
  for (const entry of route.entries) {
    if (!MEASURED_OPERATIONS.includes(entry.operation)) continue;
    if (!operations.includes(entry.operation))
      reasons.push(`unexpected ${entry.operation} read`);
    const expected = armBackend(entry.operation, arm, platform);
    if (expected === null)
      reasons.push(`${entry.operation} read without a host platform`);
    else if (entry.backend !== expected)
      reasons.push(`${entry.backend} read in ${arm} arm`);
    if (entry.generation !== route.generation)
      reasons.push('read spans a route generation');
    if (entry.phase === 'started') {
      if (seen.has(entry.request)) reasons.push('duplicate read start');
      seen.add(entry.request);
      open.set(entry.request, entry.operation);
      starts[entry.operation] += 1;
    } else if (open.get(entry.request) !== entry.operation) {
      reasons.push('read finish without its start');
    } else {
      open.delete(entry.request);
      if (entry.phase !== 'success') reasons.push(`read ${entry.phase}`);
    }
  }
  if (open.size) reasons.push('read without a finish');
  return { reasons, starts };
}

/**
 * Whether the invocation delta explains `count` routed reads. Roots and
 * directory invocations all reach the route. `file` and `link` also count
 * calls the route never sees (unscoped and sealed-viewer reads). One
 * `file-index:get` call can search several pages or none, but a page outside
 * every call in the interval belongs to a walk that began before it.
 */
function explainsReads(operation, invocations, count) {
  if (operation === 'search') return count === 0 || invocations > 0;
  if (operation === 'file' || operation === 'link') return invocations >= count;
  return invocations === count;
}

/** Invocation and route counters must account for exactly the observed reads. */
function counterReasons(before, after, arm, platform, starts) {
  const reasons = [];
  const invocations = counterDeltas(before.invocations, after.invocations);
  const routeDelta = counterDeltas(before.route, after.route);
  for (const operation of MEASURED_OPERATIONS) {
    const count = starts[operation] ?? 0;
    if (!explainsReads(operation, invocations[operation] ?? 0, count))
      reasons.push(`unexplained ${operation} invocations`);
    const prefix = `files.${operation}.`;
    const daemon = armBackend(operation, arm, platform) === 'daemon';
    // At most one bounded conflict refresh per read, each sending one more query.
    const observed = routeDelta[`${prefix}daemon.retries`] ?? 0;
    const retries = daemon && observed >= 0 && observed <= count ? observed : 0;
    const wanted = daemon
      ? {
          daemon: count,
          'daemon.served': count,
          'daemon.queries': count + retries,
          'daemon.retries': retries,
        }
      : { direct: count };
    const keys = new Set([
      ...Object.keys(wanted).map((outcome) => prefix + outcome),
      ...Object.keys(routeDelta).filter((key) => key.startsWith(prefix)),
    ]);
    for (const key of keys)
      if (routeDelta[key] !== (wanted[key.slice(prefix.length)] ?? 0))
        reasons.push(`route counter ${key} changed by ${routeDelta[key]}`);
  }
  if (MEASURED_OPERATIONS.every((operation) => !starts[operation]))
    reasons.push('no Files invocation in interval');
  return reasons;
}

/**
 * Renderer completion for one target: a current successful commit with the
 * expected content, rechecked unchanged after two animation frames.
 */
export function admitRendererCompletion({
  first,
  recheck,
  expectedItemCount,
  visibleItemCount,
  animationFrames,
}) {
  const reasons = [];
  if (first?.source !== RENDERER_SOURCE || recheck?.source !== RENDERER_SOURCE)
    return verdict(['renderer Files observer missing']);
  if (!(animationFrames >= 2)) reasons.push('fewer than two animation frames');
  for (const [label, snapshot] of [
    ['first', first],
    ['recheck', recheck],
  ]) {
    if (!snapshot.complete) reasons.push(`${label} interval incomplete`);
    if (!snapshot.currentSuccess)
      reasons.push(`${label} has no current success`);
    if (!snapshot.settled) reasons.push(`${label} not settled`);
    if (snapshot.hasError) reasons.push(`${label} has an error`);
    if (snapshot.itemCount !== expectedItemCount)
      reasons.push(`${label} item count ${snapshot.itemCount}`);
  }
  // Both snapshots use the interval-start cursor; reads of other targets may
  // continue, but the target itself must not change.
  const targetEntries = (snapshot) =>
    JSON.stringify(
      (snapshot.entries ?? []).filter((entry) => entry.matchesTarget),
    );
  if (
    !Array.isArray(first.entries) ||
    !Array.isArray(recheck.entries) ||
    first.cursor?.observerId !== recheck.cursor?.observerId ||
    targetEntries(first) !== targetEntries(recheck) ||
    first.version !== recheck.version
  )
    reasons.push('renderer changed after completion');
  if (visibleItemCount !== expectedItemCount)
    reasons.push(`visible content ${visibleItemCount}`);
  return verdict(reasons);
}

const SHA256 = /^[a-f0-9]{64}$/;

function artifactReasons(artifactSha256, brand) {
  return [
    ...(SHA256.test(artifactSha256 ?? '') ? [] : ['artifact hash missing']),
    ...(typeof brand === 'string' && brand ? [] : ['brand missing']),
  ];
}

/**
 * Whole-trial admission: every component must admit. A `visible` trial also
 * needs renderer completion; `query` completes in main. The treatment record
 * names the artifact and brand, so the comparator can refuse to compare arms
 * of different builds or brands.
 */
export function admitTrial({
  arm,
  workload,
  artifactSha256,
  brand,
  main,
  renderer,
}) {
  const parts = [
    ['artifact', verdict(artifactReasons(artifactSha256, brand))],
    ['arm', verdict(TREATMENT_ARMS.includes(arm) ? [] : ['unknown arm'])],
    ['main', admitMainInterval({ ...main, arm })],
  ];
  if (workload === 'visible')
    parts.push(['renderer', admitRendererCompletion(renderer ?? {})]);
  else if (workload !== 'query')
    parts.push(['workload', verdict([`unknown workload ${workload}`])]);
  const reasons = parts.flatMap(([part, result]) =>
    result.reasons.map((reason) => `${part}: ${reason}`),
  );
  return verdict(reasons, {
    treatment: { routeSelection: 'build-default', arm, artifactSha256, brand },
  });
}
