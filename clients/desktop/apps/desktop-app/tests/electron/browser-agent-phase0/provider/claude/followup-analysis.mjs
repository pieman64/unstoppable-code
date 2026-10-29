// Pure analysis for the October 2 follow-up arms. Inputs are recorded facts
// (SDK init/result messages, capture snapshots, gateway events); `evaluate` is
// shared/capture.mjs evaluateCanary, injected so this module stays testable.
// Statuses use the ledger vocabulary: pass / fail / blocked / unobserved.
import {
  advertisedToolNames,
  breakdownRequest,
  isMessagesRecord,
  recordBody,
} from './anthropic-bytes.mjs';
import { CONTEXT_CHECKPOINT_TOKENS } from '../shared/followup-policy.mjs';
import { worstStatus } from './canary-eval.mjs';

const names = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter(Boolean);

/** Canaries a discovered-source exclusion is asserted for (every `absent` one that has a file fixture). */
export const SOURCE_CANARY_IDS = Object.freeze([
  'userInstructions',
  'ancestorInstructions',
  'projectInstructions',
  'projectOverrideInstructions',
  'settings',
  'skillUser',
  'skillAgentsDir',
  'plugin',
  'outputStyle',
  'memory',
  'mcpUserConfig',
  'hook',
  'hostEnvironment',
  'hostFile',
]);

/** Same isolated options, differing only in the production memory-disable flag. */
export function evaluateMemoryFlagPair({ arms, token, evaluate }) {
  const removed = arms['I-removed']?.snapshot;
  const kept = arms['I-prod']?.snapshot;
  if (!removed?.records?.length || !kept?.records?.length)
    return {
      status: 'unobserved',
      reason: 'both launches need outbound requests',
    };
  const removedHits = evaluate(removed, token, 'absent').hits.length;
  const keptHits = evaluate(kept, token, 'absent').hits.length;
  return {
    status: keptHits > 0 ? 'fail' : removedHits > 0 ? 'pass' : 'blocked',
    removedHits,
    keptHits,
    note: 'paired isolated launches only; no claim about unrestricted preset memory discovery',
  };
}

/**
 * What `init` merely inventories. This is NOT the callable set: the SDK lists
 * configured tools/servers before any request, so callability needs the
 * request `tools` arrays and executed gateway events (see callableEvidence).
 */
export function initInventory(init) {
  if (!init) return null;
  const servers = (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).map(
    (server) => ({
      name: typeof server === 'string' ? server : (server?.name ?? null),
      status: typeof server === 'string' ? null : (server?.status ?? null),
    }),
  );
  return {
    tools: names(init.tools),
    mcpServers: servers,
    skills: names(init.skills),
    plugins: names(init.plugins),
    slashCommandCount: names(init.slash_commands).length,
    agents: init.agents ?? null,
    apiKeySource: init.apiKeySource ?? null,
    outputStyle: init.output_style ?? null,
    permissionMode: init.permissionMode ?? null,
    model: init.model ?? null,
    claudeCodeVersion: init.claude_code_version ?? null,
    cwd: init.cwd ?? null,
    label: 'init inventory: configured, not proof of callability',
  };
}

/** Distinct evidence channels for "which tools can the model actually call". */
export function callableEvidence(arm) {
  const requestTools = new Set();
  let requests = 0;
  for (const record of (arm?.snapshot?.records ?? []).filter(
    isMessagesRecord,
  )) {
    const body = recordBody(record);
    if (!body) continue;
    requests += 1;
    for (const name of advertisedToolNames(body)) requestTools.add(name);
  }
  return {
    initTools: names(arm?.driven?.init?.tools),
    requestAdvertisedTools: [...requestTools].sort(),
    requestsParsed: requests,
    executedGatewayTools: (arm?.gatewayEvents ?? [])
      .filter((event) => event.valid)
      .map((event) => event.tool),
    sdkToolUseNames: arm?.driven?.toolUses ?? [],
    deniedNativeAttempts: (arm?.denials ?? []).map((denial) => denial.toolName),
  };
}

/** Tool loop: explicit browser MCP survives the arm's options and is actually called. */
export function evaluateToolLoop(arm, { expected }) {
  if (!arm || arm.skipped || arm.error)
    return {
      status: 'unobserved',
      reason: arm?.skipped ?? arm?.error ?? 'arm did not run',
    };
  const evidence = callableEvidence(arm);
  const server = initInventory(arm.driven?.init)?.mcpServers.find(
    (entry) => entry.name === 'browser',
  );
  const executed = evidence.executedGatewayTools;
  const problems = [];
  if (!server) problems.push('init did not list the browser MCP server');
  else if (server.status && server.status !== 'connected')
    problems.push(`browser MCP status is ${server.status}`);
  let cursor = 0;
  for (const name of expected) {
    const found = executed.indexOf(name, cursor);
    if (found < 0) problems.push(`gateway never executed ${name} in order`);
    else cursor = found + 1;
  }
  const outsiders = evidence.requestAdvertisedTools.filter(
    (name) => !name.startsWith('mcp__browser__'),
  );
  if (outsiders.length) problems.push('non-browser tools advertised');
  return {
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
    outsideBrowserAdvertised: outsiders,
    evidence,
    note: 'init inventory, request-advertised tools and executed gateway calls are separate channels',
  };
}

/** Liveness of each planted fixture, judged from the unrestricted positive control. */
export function controlLiveness({
  fixtures,
  control,
  tokens,
  evaluate,
  isLive,
}) {
  const out = {};
  for (const fixture of fixtures) {
    if (!control?.snapshot) {
      out[fixture.id] = fixture.live?.notRequired
        ? { live: true, basis: 'not a discovered file' }
        : { live: false, basis: 'the positive control did not run' };
      continue;
    }
    const probe = evaluate(control.snapshot, tokens[fixture.id], 'absent');
    out[fixture.id] = isLive(fixture, {
      requestHit: probe.hits.length > 0,
      recorderDelta: control.recorderDelta ?? {},
      init: control.driven?.init ?? null,
    });
  }
  return out;
}

/**
 * Absence of each source canary over every request of an arm. `pass` needs the
 * fixture live in the control; absence of a dead fixture is `blocked`.
 */
export function evaluateSourceCanaries({
  arm,
  tokens,
  evaluate,
  liveness,
  ids = SOURCE_CANARY_IDS,
}) {
  if (!arm?.snapshot?.records?.length)
    return Object.fromEntries(
      ids.map((id) => [id, { status: 'unobserved', detail: 'no capture' }]),
    );
  const out = {};
  for (const id of ids) {
    const result = evaluate(arm.snapshot, tokens[id], 'absent');
    let { status, detail } = result;
    const live = liveness?.[id];
    if (status === 'pass' && live && live.live === false) {
      status = 'blocked';
      detail = `absent, but fixture not live in the positive control (${live.basis})`;
    }
    out[id] = { status, detail, hits: result.hits.length };
  }
  return out;
}

/** Hook invocation counts (recorders) must be zero in an isolated arm. */
export function hookRecorderStatus(arm) {
  const names = Object.keys(arm?.recorderDelta ?? {}).filter((name) =>
    name.startsWith('hook-'),
  );
  const invoked = names.filter((name) => arm.recorderDelta[name] > 0);
  return {
    status: invoked.length === 0 ? 'pass' : 'fail',
    invoked,
  };
}

/**
 * Memory flag matrix. The two controls are only meaningful if the positive
 * control shows memory live; otherwise every absence is blocked.
 *
 *  U-mem   unrestricted, flag removed   -> memory present (liveness)
 *  U-flag  unrestricted, flag kept      -> memory absent  (flag alone suffices?)
 *  I-removed isolated, flag removed     -> memory absent  (options alone suffice?)
 *  I-prod  isolated, flag kept          -> memory absent  (production-equivalent)
 */
export function evaluateMemoryMatrix({ arms, token, evaluate }) {
  const hitsIn = (arm) =>
    arm?.snapshot ? evaluate(arm.snapshot, token, 'absent') : null;
  const control = hitsIn(arms['U-mem']);
  const live = Boolean(control && control.hits.length > 0);
  const rows = {};
  for (const [id, role] of [
    ['U-mem', 'positive-control (must be live)'],
    ['U-flag', 'flag effect alone'],
    ['I-removed', 'options effect alone'],
    ['I-prod', 'production-equivalent'],
  ]) {
    const result = hitsIn(arms[id]);
    if (!result) {
      rows[id] = { role, status: 'unobserved', detail: 'no capture' };
    } else if (id === 'U-mem') {
      rows[id] = {
        role,
        status: live ? 'pass' : 'blocked',
        detail: live
          ? 'memory canary reached a request: the fixture is live'
          : 'memory canary not observed: the positive control is inert, so every absence below is not evidence',
      };
    } else {
      const absent = result.hits.length === 0;
      rows[id] = {
        role,
        status: !absent ? 'fail' : live ? 'pass' : 'blocked',
        detail: absent
          ? live
            ? 'memory canary absent while the control proved it reachable'
            : 'absent, but the control was inert'
          : `memory canary present in ${result.hits.length} record(s)`,
        hits: result.hits.length,
      };
    }
  }
  return {
    controlLive: live,
    rows,
    status: worstStatus(Object.values(rows).map((row) => row.status)),
    interpretation:
      'U-flag and I-removed each isolate one factor; neither arm removes both controls, so a pass in I-prod is attributable to the flag, the options, or both as the two rows show.',
  };
}

/** Bytes and counts of the fixed (pre-conversation) part of the first main request. */
export function fixedOverhead(arm) {
  const record = (arm?.snapshot?.records ?? []).find(
    (candidate) =>
      isMessagesRecord(candidate) &&
      recordBody(candidate) &&
      candidate.marker === arm.key,
  );
  const body = recordBody(record);
  if (!body) return null;
  const breakdown = breakdownRequest(body, record.byteLength);
  return {
    totalBytes: breakdown.totalBytes,
    systemBytes: breakdown.system.bytes,
    toolsBytes: breakdown.tools.bytes,
    toolCount: breakdown.tools.count,
    messageBytes: breakdown.messages.bytes,
    label:
      'observed bytes of the first request, not exact minimal-text matching',
  };
}

/** Billed (cumulative) usage from the SDK result, kept apart from context occupancy. */
export function billedUsage(result) {
  if (!result) return null;
  const usage = result.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    numTurns: result.num_turns ?? null,
    totalCostUsd: result.total_cost_usd ?? null,
    label: 'billed/cumulative across all requests of the query',
  };
}

/**
 * Context signals for the 125,000-token checkpoint. Scripted numbers only
 * exercise plumbing: they say the SDK surfaces usage, not how real sessions grow.
 */
export function evaluateContextSignals(
  arm,
  { checkpoint = CONTEXT_CHECKPOINT_TOKENS } = {},
) {
  if (!arm || arm.skipped || arm.error)
    return {
      status: 'unobserved',
      reason: arm?.skipped ?? arm?.error ?? 'arm did not run',
    };
  const samples = arm.driven?.contextSamples ?? [];
  const ok = samples.filter((sample) => typeof sample.totalTokens === 'number');
  const compaction = (arm.driven?.systemMessages ?? []).filter(
    (message) => message.subtype === 'compact_boundary',
  ).length;
  const scripted = (arm.scriptedInputTokens ?? []).filter(
    (value) => typeof value === 'number',
  );
  const requestedUsage = (arm.snapshot?.records ?? []).filter(
    isMessagesRecord,
  ).length;
  return {
    status: ok.length > 0 ? 'measured' : 'unobserved',
    checkpoint,
    scriptedInputTokens: scripted,
    scriptedCrossesCheckpoint: scripted.some((value) => value >= checkpoint),
    contextSamples: samples,
    contextAtOrAboveCheckpoint: ok.some(
      (sample) => sample.totalTokens >= checkpoint,
    ),
    autoCompactThreshold:
      ok.find((sample) => sample.autoCompactThreshold)?.autoCompactThreshold ??
      null,
    compactBoundaryMessages: compaction,
    billed: billedUsage(arm.driven?.result),
    requestsCaptured: requestedUsage,
    label:
      'context = window occupancy estimate; billed = cumulative usage. Scripted values are plumbing only; real calibration and autocompaction behavior remain unobserved.',
  };
}

/**
 * Auth route evidence. `initOnly` arms never reach a model: only init metadata
 * and refusing-proxy destinations are evidence; inference and tool calls are unobserved.
 */
export function evaluateAuth(arm, { proxy, auth = null }) {
  if (!arm || arm.skipped || arm.error)
    return {
      status: 'unobserved',
      reason: arm?.skipped ?? arm?.error ?? 'arm did not run',
    };
  const init = initInventory(arm.driven?.init);
  const hosts = Object.keys(proxy?.byHost ?? {});
  const external = proxy?.external ?? 0;
  const base = {
    apiKeySource: init?.apiKeySource ?? null,
    initObserved: Boolean(init),
    refusingProxy: { external, hosts: hosts.slice(0, 10) },
    keychainAttempts: arm.keychainAttempts ?? 0,
  };
  if (arm.initOnly)
    return {
      ...base,
      status: init ? 'measured' : 'unobserved',
      inferenceObserved: false,
      toolCallsObserved: false,
      label:
        'production-shaped synthetic OAuth: init metadata and refusing-proxy destinations only; inference and tool calls are unobserved and real OAuth acceptance is not inferred',
    };
  return {
    ...base,
    status: auth ? 'measured' : 'unobserved',
    auth,
    label:
      'NON-production transport delta: production refuses a custom base URL with OAuth; this arm only shows how the placeholder credential is presented to a loopback listener',
  };
}
