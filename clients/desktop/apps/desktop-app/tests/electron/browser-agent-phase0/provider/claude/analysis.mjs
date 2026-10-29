// Turns recorded variant data into ledger entries, identity and S0.2 figures.
// Pure over its inputs: variants carry captured snapshots, SDK messages and
// recorder deltas; `evaluate` is shared/capture.mjs evaluateCanary.
import {
  advertisedToolNames,
  betweenToolDiff,
  breakdownRequest,
  compareRequestSeries,
  growthSeries,
  harnessAddedText,
  isMessagesRecord,
  modelsSeen,
  recordBody,
} from './anthropic-bytes.mjs';
import {
  aggregateVariants,
  evaluateAllCanaries,
  worstStatus,
} from './canary-eval.mjs';
import {
  evaluateBetweenTool,
  evaluateDisableMds,
  evaluateInit,
  evaluateLaunchFailure,
  evaluateRotation,
  evaluateToolSurface,
  evaluateToolsEmpty,
  findUnavailableToolResult,
} from './evaluators.mjs';
import {
  estimateTokens,
  median,
  observationGrowth,
  recommendGuard,
  REQUEST_TOKEN_BUDGET,
} from './guard-math.mjs';
import { checkModelIdentity } from './probe-env.mjs';
import { PROBE_SYSTEM_PROMPT, probeUserPrompt } from './scripts.mjs';
import { isFixtureLive } from './fixtures.mjs';
import { latencySummary } from './query-driver.mjs';

export const ISOLATED_IDS = Object.freeze(['B', 'C', 'D1', 'D2', 'D3', 'F']);
export const NO_MDS_IDS = Object.freeze(['B', 'D1', 'D2', 'D3', 'F']);
export const PHASES3 = Object.freeze([
  'before-inference',
  'after-tools',
  'completion',
]);
const INSTRUCTION_CANARIES = Object.freeze([
  'userInstructions',
  'ancestorInstructions',
  'projectInstructions',
  'projectOverrideInstructions',
]);

const requestsOf = (variant) =>
  (variant?.snapshot?.records ?? []).filter(isMessagesRecord).map((record) => ({
    seq: record.seq,
    bytes: record.byteLength,
    complete: record.complete,
    body: recordBody(record),
  }));
const bodiesOf = (variant) =>
  requestsOf(variant)
    .map((request) => request.body)
    .filter(Boolean);
const statusOf = (value) => value; // ledger statuses share the evaluator vocabulary

/** Compact per-variant summary for the report identity. */
export function summarizeVariant(variant) {
  if (!variant) return null;
  if (variant.error || variant.skipped)
    return {
      id: variant.id,
      label: variant.label,
      error: variant.error ?? null,
      skipped: variant.skipped ?? null,
    };
  const driven = variant.driven;
  const result = driven?.result;
  return {
    id: variant.id,
    label: variant.label,
    scenarioKey: variant.key,
    cwd: variant.cwd,
    isolatedLaunch: variant.isolated,
    optionsSummary: variant.optionsSummary,
    envDelta: variant.envDelta ?? null,
    sessionId: driven?.init?.session_id ?? null,
    resultSubtype: result?.subtype ?? null,
    resultIsError: result?.is_error ?? null,
    apiErrorStatus: result?.api_error_status ?? null,
    numTurns: result?.num_turns ?? null,
    messageCounts: driven?.messageCounts ?? null,
    timedOut: driven?.timedOut ?? null,
    error: driven?.error ?? null,
    processes: driven?.processes ?? [],
    stderrTail: driven?.stderrTail?.slice(-1_500) ?? '',
    systemMessages: driven?.systemMessages ?? [],
    captureCounts: variant.snapshot?.counts ?? null,
    captureKinds: variant.snapshot?.kinds ?? null,
    modelsSeen: variant.snapshot ? modelsSeen(variant.snapshot.records) : null,
    recorderDelta: variant.recorderDelta,
    keychainAttempts: variant.keychainAttempts,
    denials: variant.denials,
    gatewayToolsExecuted: (variant.gatewayEvents ?? []).map(
      (event) => event.tool,
    ),
    artifact: variant.artifact ?? null,
  };
}

function mainAndHelperRequests(variant) {
  const marker = variant.key;
  const main = [];
  const helpers = [];
  for (const record of (variant.snapshot?.records ?? []).filter(
    isMessagesRecord,
  )) {
    const item = {
      seq: record.seq,
      model: recordBody(record)?.model ?? null,
      bytes: record.byteLength,
      toolCount: advertisedToolNames(recordBody(record)).length,
    };
    (record.marker === marker ||
    JSON.stringify(recordBody(record) ?? {}).includes(marker)
      ? main
      : helpers
    ).push(item);
  }
  return { main, helpers };
}

/**
 * @param {object} input
 * @returns {{ identity: object, s02: object, notes: string[] }}
 */
export function analyze({
  ledger,
  STATUS,
  evaluate,
  catalog,
  tokens,
  fixtures,
  expectedToolNames,
  variants,
  managedPolicy,
  requestedModel,
  hookEvents,
  extra = {},
}) {
  const notes = [];
  const identity = {
    variants: {},
    controlLiveness: {},
    sessionIds: {},
    inits: {},
    models: {},
    hookEventsAvailable: hookEvents,
  };
  for (const [id, variant] of Object.entries(variants))
    identity.variants[id] = summarizeVariant(variant);

  // ── Positive control: which fixtures are live? ─────────────────────────────
  const control = variants.A?.snapshot ? variants.A : null;
  const liveness = {};
  for (const fixture of fixtures) {
    if (!control) {
      liveness[fixture.id] = fixture.live?.notRequired
        ? { live: true, basis: 'not a discovered file' }
        : { live: false, basis: 'the positive control did not run' };
      continue;
    }
    const probe = evaluate(control.snapshot, tokens[fixture.id], 'absent');
    liveness[fixture.id] = isFixtureLive(fixture, {
      requestHit: probe.hits.length > 0,
      recorderDelta: control.recorderDelta,
      init: control.driven?.init ?? null,
    });
    liveness[fixture.id].controlHitRecords = probe.hits.map((hit) => hit.seq);
  }
  identity.controlLiveness = liveness;
  for (const entry of catalog) {
    const live = liveness[entry.id] ?? { live: false, basis: 'no fixture' };
    if (entry.id === 'hostEnvironment' || entry.id === 'hostFile') {
      const result = control
        ? evaluate(control.snapshot, tokens[entry.id], 'absent')
        : null;
      ledger.record(
        `canary.${entry.id}`,
        'before-inference',
        result ? statusOf(result.status) : STATUS.unobserved,
        {
          variant: 'A-control (labelled: not an isolated launch)',
          detail: result?.detail ?? 'control did not run',
        },
      );
    } else {
      ledger.record(`canary.${entry.id}`, 'before-inference', STATUS.measured, {
        variant: 'A-control (positive control, not an isolated launch)',
        role: 'liveness',
        ...live,
      });
    }
  }
  if (!control)
    notes.push(
      'Positive control (A) did not produce a capture: every isolated-absence result that depends on fixture liveness is blocked.',
    );

  // ── Per-variant canary evaluation ──────────────────────────────────────────
  const evaluated = {};
  for (const id of ISOLATED_IDS) {
    const variant = variants[id];
    if (!variant?.snapshot) continue;
    evaluated[id] = evaluateAllCanaries({
      snapshot: variant.snapshot,
      catalog,
      tokens,
      phaseNames: PHASES3,
      evaluate,
      liveness,
      resultSeq: variant.resultSeq ?? null,
    }).results;
  }
  const failureVariant = variants.E?.snapshot ? variants.E : null;
  const failureEvaluated = failureVariant
    ? evaluateAllCanaries({
        snapshot: failureVariant.snapshot,
        catalog,
        tokens,
        phaseNames: ['launch-failure'],
        evaluate,
        liveness,
        forcePhase: 'launch-failure',
      }).results
    : null;

  // Recorder invocations (hooks, MCP servers) in any isolated launch are failures
  // on their own, independent of the canary token text.
  const invocations = (entryId) => {
    const prefix =
      entryId === 'hook'
        ? 'hook-'
        : entryId === 'mcpUserConfig'
          ? 'mcp-'
          : null;
    if (!prefix) return null;
    const out = {};
    for (const id of [...ISOLATED_IDS, 'E']) {
      const delta = variants[id]?.recorderDelta;
      if (!delta) continue;
      out[id] = Object.entries(delta)
        .filter(([name]) => name.startsWith(prefix))
        .reduce((sum, [, count]) => sum + count, 0);
    }
    return out;
  };

  const aggregated = {}; // id -> phase -> { status, evidence }
  for (const entry of catalog) {
    aggregated[entry.id] = {};
    const invoked = invocations(entry.id);
    const invokedAnywhere = invoked
      ? Object.values(invoked).some((count) => count > 0)
      : false;
    for (const phase of PHASES3) {
      const base =
        Object.keys(evaluated).length > 0
          ? aggregateVariants(evaluated, entry.id, phase)
          : {
              status: 'unobserved',
              evidence: { reason: 'no isolated variant produced a capture' },
            };
      const agg = invokedAnywhere
        ? {
            status: 'fail',
            evidence: {
              ...base.evidence,
              recorderInvocationsInIsolatedVariants: invoked,
            },
          }
        : invoked
          ? {
              ...base,
              evidence: {
                ...base.evidence,
                recorderInvocationsInIsolatedVariants: invoked,
              },
            }
          : base;
      aggregated[entry.id][phase] = agg;
      ledger.record(`canary.${entry.id}`, phase, statusOf(agg.status), {
        variants: agg.evidence,
        liveness: liveness[entry.id] ?? null,
        expected: entry.expected,
      });
    }
    const failureResult = failureEvaluated?.[entry.id]?.['launch-failure'];
    aggregated[entry.id]['launch-failure'] = failureResult
      ? {
          status: invoked && invoked.E > 0 ? 'fail' : failureResult.status,
          evidence: {
            E: failureResult,
            recorderInvocations: invoked?.E ?? null,
          },
        }
      : {
          status: 'unobserved',
          evidence: { reason: 'launch-failure variant produced no capture' },
        };
    ledger.record(
      `canary.${entry.id}`,
      'launch-failure',
      statusOf(aggregated[entry.id]['launch-failure'].status),
      {
        variants: { E: failureResult ?? null },
        liveness: liveness[entry.id] ?? null,
        expected: entry.expected,
      },
    );
  }

  // close.only-accepted-source: Claude has no accepted exception.
  const harness = variants.B?.snapshot
    ? (() => {
        const first = bodiesOf(variants.B)[0];
        return first
          ? harnessAddedText(first, {
              probeSystemPrompt: PROBE_SYSTEM_PROMPT,
              probePrompt: probeUserPrompt(variants.B.key),
            })
          : null;
      })()
    : null;
  for (const phase of [
    ...PHASES3.filter((p) => p !== 'completion'),
    'completion',
    'launch-failure',
  ]) {
    const perCanary = Object.fromEntries(
      catalog.map((entry) => [entry.id, aggregated[entry.id][phase].status]),
    );
    const decided = Object.values(perCanary).filter(
      (status) => status !== 'unobserved',
    );
    const status = decided.length > 0 ? worstStatus(decided) : 'unobserved';
    ledger.record('close.only-accepted-source', phase, statusOf(status), {
      acceptedExceptions: 'none for Claude',
      perCanary,
      caveat:
        'Only planted canaries are searched; harness-added text is inventoried, not classified as a source.',
      harnessAddedFirstRequest:
        phase === 'before-inference' ? harness : undefined,
    });
  }

  // ── close.claude-md-* ──────────────────────────────────────────────────────
  {
    const userAgg = aggregateVariants(
      Object.fromEntries(
        NO_MDS_IDS.filter((id) => evaluated[id]).map((id) => [
          id,
          evaluated[id],
        ]),
      ),
      'userInstructions',
      'before-inference',
    );
    ledger.record(
      'close.claude-md-user',
      'before-inference',
      statusOf(userAgg.status),
      {
        variantsWithoutDisableMds: userAgg.evidence,
        liveness: liveness.userInstructions ?? null,
        note: 'settingSources: [] in every variant listed',
      },
    );
    const existing = (managedPolicy ?? []).filter((entry) => entry.exists);
    const bc = compareB(variants);
    ledger.record(
      'close.claude-md-managed',
      'before-inference',
      STATUS.blocked,
      {
        reason:
          'unobserved: requires host edit. Proving a managed CLAUDE.md is excluded needs writing the system managed path, which the probe must not do.',
        managedPathsChecked: managedPolicy ?? [],
        managedFileExistsOnHost: existing.length > 0,
        hostDataWarning:
          existing.length > 0
            ? 'A managed policy path exists on this host; if the CLI loads it, host data reaches the capture recorder and report artifacts.'
            : null,
        indirectEvidence: bc
          ? {
              bWithoutVsCWithDisableMds: {
                identical: bc.identical,
                firstRequest: bc.perRequest[0] ?? null,
              },
            }
          : 'B/C comparison unavailable',
        staticReading:
          'Managed CLAUDE.md is loaded outside the settingSources gate (see staticFindings); CLAUDE_CODE_DISABLE_CLAUDE_MDS is the candidate control.',
      },
    );
    ledger.record('close.org-managed', 'launch', STATUS.blocked, {
      reason:
        'unobserved: requires host edit. Excluding organization-managed instructions/hooks/MCP cannot be tested without creating managed policy files; existence was checked only.',
      managedPaths: managedPolicy ?? [],
      remoteManagedSettings:
        'not exercised: the placeholder API key has no organization',
    });
  }

  // close.claude-disable-mds
  {
    const comparison = compareB(variants);
    const hits = INSTRUCTION_CANARIES.reduce(
      (sum, id) =>
        sum +
        (variants.C?.snapshot
          ? evaluate(variants.C.snapshot, tokens[id], 'absent').hits.length
          : 0),
      0,
    );
    const result = evaluateDisableMds({
      comparison,
      instructionHitsWithFlag: hits,
    });
    ledger.record(
      'close.claude-disable-mds',
      'before-inference',
      result.status === 'measured' ? STATUS.measured : statusOf(result.status),
      result,
    );
  }

  // close.claude-tools-empty + launch.tool-surface + launch.claude-init
  {
    const b = variants.B;
    const toolsEmpty = b?.snapshot
      ? evaluateToolsEmpty({
          initTools: b.driven?.init?.tools,
          requestBodies: bodiesOf(b),
          expectedTools: expectedToolNames,
        })
      : null;
    const unavailable = b?.snapshot
      ? findUnavailableToolResult(bodiesOf(b), 'Bash')
      : null;
    ledger.record(
      'close.claude-tools-empty',
      'before-inference',
      toolsEmpty ? statusOf(toolsEmpty.status) : STATUS.unobserved,
      toolsEmpty
        ? { ...toolsEmpty, scriptedBashAttemptResult: unavailable }
        : { reason: 'variant B produced no capture' },
    );
    for (const [phase, slice] of [
      ['before-inference', (list) => list.slice(0, 1)],
      ['after-tools', (list) => list.slice(1)],
    ]) {
      const bodies = ['B', 'D1', 'D2', 'D3'].flatMap((id) =>
        slice(bodiesOf(variants[id])),
      );
      const surface = evaluateToolSurface({
        initTools: b?.driven?.init?.tools ?? [],
        requestBodies: bodies,
        expectedTools: expectedToolNames,
      });
      ledger.record('launch.tool-surface', phase, statusOf(surface.status), {
        requestsChecked: bodies.length,
        init: surface.init,
        firstFailures: surface.perRequest
          .filter((entry) => !entry.exact)
          .slice(0, 3),
      });
    }
    const inits = ISOLATED_IDS.filter((id) => variants[id]?.driven?.init).map(
      (id) => [
        id,
        evaluateInit(variants[id].driven.init, {
          expectedTools: expectedToolNames,
          cwd: variants[id].cwd,
        }),
      ],
    );
    for (const [id, evaluation] of inits)
      identity.inits[id] = evaluation.fields;
    if (variants.A?.driven?.init)
      identity.inits.A = {
        ...pickInit(variants.A.driven.init),
        note: 'positive control, not an isolated launch',
      };
    ledger.record(
      'launch.claude-init',
      'launch',
      inits.length
        ? statusOf(
            worstStatus(inits.map(([, evaluation]) => evaluation.status)),
          )
        : STATUS.unobserved,
      inits.length
        ? {
            perVariant: Object.fromEntries(
              inits.map(([id, evaluation]) => [
                id,
                { status: evaluation.status, problems: evaluation.problems },
              ]),
            ),
            B: inits.find(([id]) => id === 'B')?.[1].fields ?? null,
          }
        : { reason: 'no isolated init message was received' },
    );
  }

  // launch.empty-cwd
  {
    const isolated = ISOLATED_IDS.concat(['E'])
      .map((id) => variants[id])
      .filter((variant) => variant && !variant.error && !variant.skipped);
    if (isolated.length === 0) {
      ledger.record('launch.empty-cwd', 'launch', STATUS.unobserved, {
        reason: 'no isolated variant ran',
      });
      ledger.record('launch.empty-cwd', 'completion', STATUS.unobserved, {
        reason: 'no isolated variant ran',
      });
    } else {
      const dirty = isolated.filter(
        (variant) => (variant.cwdBefore ?? []).length > 0,
      );
      ledger.record(
        'launch.empty-cwd',
        'launch',
        dirty.length === 0 ? STATUS.pass : STATUS.fail,
        {
          variants: isolated.map((variant) => ({
            id: variant.id,
            cwd: variant.cwd,
            filesBefore: (variant.cwdBefore ?? []).length,
          })),
          note: 'created fresh and empty, outside every repository (assertOutsideRepository)',
        },
      );
      const after = isolated.filter(
        (variant) => (variant.cwdAfter ?? []).length > 0,
      );
      ledger.record(
        'launch.empty-cwd',
        'completion',
        after.length === 0 ? STATUS.pass : STATUS.fail,
        {
          variants: isolated.map((variant) => ({
            id: variant.id,
            filesAfter: variant.cwdAfter ?? null,
          })),
          note: 'epoch directories are removed by run.mjs after this check; the synthetic root is removed by the orchestrator',
        },
      );
    }
  }

  // canonical.no-model-fallback
  {
    const perVariant = {};
    for (const [id, variant] of Object.entries(variants)) {
      if (!variant?.snapshot) continue;
      const { main, helpers } = mainAndHelperRequests(variant);
      const identityCheck = checkModelIdentity({
        requested: requestedModel,
        initModel: variant.driven?.init?.model ?? null,
        requestModels: [...new Set(main.map((item) => item.model))],
      });
      perVariant[id] = {
        ...identityCheck,
        reportedByResult: Object.keys(variant.driven?.result?.modelUsage ?? {}),
        helperRequests: helpers,
      };
      identity.models[id] = {
        requested: requestedModel,
        init: variant.driven?.init?.model ?? null,
        requestBodies: [...new Set(main.map((item) => item.model))],
        helperRequestModels: helpers,
      };
    }
    const all = Object.values(perVariant);
    ledger.record(
      'canonical.no-model-fallback',
      'launch',
      all.length === 0
        ? STATUS.unobserved
        : all.every((entry) => entry.ok)
          ? STATUS.pass
          : STATUS.fail,
      {
        requested: requestedModel,
        perVariant,
        note: 'fallbackModel was never set; any difference between requested and reported/requested-in-body is a failure',
      },
    );
  }

  // ── Between-tool attachment pass, rotation ─────────────────────────────────
  const loops = ['B', 'D1', 'D2', 'D3', 'F']
    .filter((id) => variants[id]?.snapshot)
    .map((id, index) => {
      const bodies = bodiesOf(variants[id]);
      const diffs = [];
      for (let i = 1; i < bodies.length; i += 1)
        diffs.push(betweenToolDiff(bodies[i - 1], bodies[i], tokens));
      return { epoch: id, diffs };
    });
  {
    const result = evaluateBetweenTool(loops);
    ledger.record(
      'close.claude-between-tool',
      'after-tools',
      statusOf(result.status),
      result,
    );
  }

  const epochs = ['D1', 'D2', 'D3']
    .map((id, index) => ({ id, epoch: index + 1, variant: variants[id] }))
    .filter((entry) => entry.variant?.snapshot);
  {
    const facts = epochs.map(({ epoch, variant }) => {
      const oldCanary = {};
      for (const prior of epochs.filter((other) => other.epoch < epoch))
        oldCanary[`epoch${prior.epoch}`] = evaluate(
          variant.snapshot,
          prior.variant.sentinel,
          'absent',
        ).status;
      return {
        epoch,
        sessionId: variant.driven?.init?.session_id ?? null,
        sentinel: variant.sentinel,
        firstRequestMessageCount:
          bodiesOf(variant)[0]?.messages?.length ?? null,
        oldCanary,
        sentinelInToolResults:
          evaluate(variant.snapshot, variant.sentinel, 'accepted').status ===
          'pass',
        toolsExecuted: (variant.gatewayEvents ?? []).map((event) => event.tool),
        resultOk:
          variant.driven?.result?.subtype === 'success' &&
          variant.driven?.result?.is_error === false,
      };
    });
    for (const fact of facts)
      identity.sessionIds[`epoch${fact.epoch}`] = fact.sessionId;
    const rotation = evaluateRotation(facts, { resumeOptionUsed: false });
    ledger.record(
      'rotation.old-canary-absent',
      'run',
      statusOf(rotation.oldCanaryAbsent.status),
      rotation.oldCanaryAbsent.detail,
    );
    ledger.record(
      'rotation.no-resume',
      'run',
      statusOf(rotation.noResume.status),
      rotation.noResume.detail,
    );
    ledger.record(
      'rotation.repeated-tools',
      'after-tools',
      statusOf(rotation.repeatedTools.status),
      rotation.repeatedTools.detail,
    );
  }
  for (const id of ['A', 'B', 'C', 'E', 'F'])
    if (variants[id]?.driven?.init)
      identity.sessionIds[id] = variants[id].driven.init.session_id;

  // ── Launch failure ─────────────────────────────────────────────────────────
  {
    const e = variants.E;
    if (!e?.snapshot) {
      ledger.record(
        'phase.launch-failure',
        'launch-failure',
        STATUS.unobserved,
        {
          reason:
            e?.skipped ?? e?.error ?? 'launch-failure variant did not run',
        },
      );
    } else {
      const statuses = catalog.map(
        (entry) => failureEvaluated[entry.id]['launch-failure'].status,
      );
      const result = evaluateLaunchFailure({
        result: e.driven.result,
        error: e.driven.error,
        requestCount: requestsOf(e).length,
        statuses,
      });
      ledger.record(
        'phase.launch-failure',
        'launch-failure',
        statusOf(result.status),
        result.detail,
      );
    }
  }

  // ── Budget pre-request ─────────────────────────────────────────────────────
  {
    const f = variants.F;
    const hookLog = f?.hookLog ?? [];
    const stoppedAt = f?.stoppedAtBatch ?? null;
    const requests = f ? requestsOf(f).length : null;
    ledger.record('budget.pre-request', 'run', STATUS.unresolved, {
      hookEventsAvailable: hookEvents,
      preInferenceHook:
        'none: no hook event fires before a model request; UserPromptSubmit/SessionStart precede only the first request',
      candidate:
        'PostToolBatch fires once after a tool batch resolves and before the next model request; a host callback can return continue:false',
      experimentF: f?.snapshot
        ? {
            hookCalls: hookLog.length,
            stopIssuedAtBatch: stoppedAt,
            modelRequestsTotal: requests,
            stopEnforcedBeforeNextRequest:
              stoppedAt !== null && requests === stoppedAt,
            resultSubtype: f.driven?.result?.subtype ?? null,
          }
        : 'variant F did not run',
      neededForConservativeBound:
        'Host-side cumulative accounting per request: measured fixed overhead (system + 22 tool definitions + harness text) + the exact bytes of every tool result and assistant block already in history, ' +
        'compared with bytes/3 of the 16,000-token budget with headroom, enforced in PostToolBatch (stop or rotate before the next request). The first request has no hook, so the fixed overhead must fit by construction. ' +
        'Post-hoc usage cannot enforce the bound and mock usage is synthetic.',
    });
  }

  // ── S0.2 ───────────────────────────────────────────────────────────────────
  const s02 = buildS02({ epochs, variants, ledger, STATUS, extra });
  return { identity, s02, notes, liveness, aggregated };
}

function pickInit(init) {
  return {
    tools: init.tools,
    skills: init.skills,
    plugins: init.plugins,
    mcp_servers: init.mcp_servers,
    slash_commands: init.slash_commands,
    output_style: init.output_style,
    agents: init.agents,
    model: init.model,
    cwd: init.cwd,
    apiKeySource: init.apiKeySource,
    session_id: init.session_id,
  };
}

function compareB(variants) {
  if (!variants.B?.snapshot || !variants.C?.snapshot) return null;
  const series = (variant) =>
    requestsOf(variant)
      .filter((request) => request.body)
      .map((request) => ({
        body: request.body,
        replacements: [
          { from: variant.cwd, to: '<cwd>' },
          { from: variant.sentinel, to: '<sentinel>' },
          { from: variant.key, to: '<marker>' },
        ],
      }));
  return compareRequestSeries(series(variants.B), series(variants.C));
}

function buildS02({ epochs, variants, ledger, STATUS, extra }) {
  const label = 'mock/loopback, not release performance';
  if (epochs.length === 0) {
    for (const id of [
      's02.session-start',
      's02.harness-overhead',
      's02.page-growth',
      's02.token-accounting',
    ])
      ledger.record(id, 'run', STATUS.unobserved, {
        reason: 'no rotation epoch produced a capture',
      });
    ledger.record('s02.guard-recommendation', 'run', STATUS.unresolved, {
      reason: 'no rotation epoch produced a capture',
    });
    return {
      label,
      perEpoch: [],
      guard: { status: 'unresolved', reason: 'no rotation data' },
    };
  }
  const perEpoch = epochs.map(({ epoch, variant }) => {
    const requests = requestsOf(variant).filter((request) => request.body);
    const breakdowns = requests.map((request) =>
      breakdownRequest(request.body, request.bytes),
    );
    const series = growthSeries(breakdowns);
    const firstIndex = variant.snapshot.records.findIndex(isMessagesRecord);
    const firstArrival =
      firstIndex >= 0 ? (variant.arrivals?.[firstIndex]?.atMs ?? null) : null;
    const result = variant.driven?.result;
    const countTokens = variant.snapshot.records.filter(
      (record) => record.surface === 'anthropic-count-tokens',
    ).length;
    return {
      epoch,
      sessionId: variant.driven?.init?.session_id ?? null,
      coldProcess: true,
      latency: latencySummary(variant.driven.timeline, firstArrival),
      sdkReportedTiming: result
        ? {
            time_to_request_ms: result.time_to_request_ms ?? null,
            time_to_request_from_spawn_ms:
              result.time_to_request_from_spawn_ms ?? null,
            duration_ms: result.duration_ms ?? null,
            duration_api_ms: result.duration_api_ms ?? null,
            ttft_ms: result.ttft_ms ?? null,
            warm_spare_claimed: result.warm_spare_claimed ?? null,
          }
        : null,
      requestCount: requests.length,
      requests: breakdowns.map((entry, index) => ({
        request: index + 1,
        totalBytes: entry.totalBytes,
        tokenEstimate: estimateTokens(entry.totalBytes),
        model: entry.model,
        systemBytes: entry.system.bytes,
        systemChars: entry.system.chars,
        toolsBytes: entry.tools.bytes,
        toolCount: entry.tools.count,
        messagesBytes: entry.messages.bytes,
        messageCount: entry.messages.count,
        toolResultBytes: entry.messages.toolResultBytes,
        toolResultCount: entry.messages.toolResultCount,
        framingBytes: entry.framingBytes,
        topLevelBytes: entry.topLevelBytes,
      })),
      growth: series,
      mockUsage: {
        synthetic: true,
        source:
          'mock scripted usage (default 1200 in / 24 out / 800 cache read per step), not provider accounting',
        result: result?.usage ?? null,
        modelUsage: result?.modelUsage ?? null,
      },
      countTokens: {
        calls: countTokens,
        synthetic: true,
        responseValue: 1200,
        source:
          'routes/llm.mjs returns a constant input_tokens: 1200 for every count_tokens call',
      },
    };
  });
  const firsts = perEpoch.map((entry) => entry.requests[0]).filter(Boolean);
  const allSeries = perEpoch.flatMap((entry) => entry.growth);
  const growth = observationGrowth(allSeries);
  const fixedBytes = median(firsts.map((first) => first.totalBytes));
  const coldStartMs = perEpoch
    .map((entry) => entry.latency.firstRequestMs)
    .filter((value) => Number.isFinite(value));
  const guard = recommendGuard({ fixedBytes, growth, coldStartMs });
  const exceeding = perEpoch.map((entry) => ({
    epoch: entry.epoch,
    firstRequestOverBudgetAtDiv3:
      entry.requests.find(
        (request) => request.tokenEstimate.bytesDiv3 > REQUEST_TOKEN_BUDGET,
      )?.request ?? null,
    firstRequestOverBudgetAtDiv4:
      entry.requests.find(
        (request) => request.tokenEstimate.bytesDiv4 > REQUEST_TOKEN_BUDGET,
      )?.request ?? null,
  }));

  ledger.record('s02.session-start', 'run', STATUS.measured, {
    label,
    claudeProcessPool:
      'none: every epoch is a cold process spawn; warm pool comparison not applicable to Claude',
    perEpoch: perEpoch.map((entry) => ({
      epoch: entry.epoch,
      ...entry.latency,
      sdkReportedTiming: entry.sdkReportedTiming,
    })),
    coldVsWarmNote:
      'epochs 2-3 benefit from warm OS file cache of the same binary; no in-process warm state exists',
  });
  ledger.record('s02.harness-overhead', 'run', STATUS.measured, {
    label,
    firstRequestBytes: firsts.map((first) => ({
      totalBytes: first.totalBytes,
      systemBytes: first.systemBytes,
      toolsBytes: first.toolsBytes,
      toolCount: first.toolCount,
      messagesBytes: first.messagesBytes,
      framingBytes: first.framingBytes,
    })),
    definitionBytesFromSchemas: extra.schemaOverhead ?? null,
    tokenEstimates: {
      estimate: true,
      firstRequest: firsts.map((first) => first.tokenEstimate),
    },
  });
  ledger.record('s02.page-growth', 'run', STATUS.measured, {
    label,
    perEpochTotalBytes: perEpoch.map((entry) => ({
      epoch: entry.epoch,
      series: entry.growth.map((step) => ({
        request: step.request,
        totalBytes: step.totalBytes,
        deltaBytes: step.deltaBytes,
      })),
    })),
    observationGrowth: growth,
    overBudgetAt: exceeding,
  });
  ledger.record('s02.token-accounting', 'run', STATUS.measured, {
    label,
    mockUsageSynthetic: {
      synthetic: true,
      perEpoch: perEpoch.map((entry) => ({
        epoch: entry.epoch,
        usage: entry.mockUsage.result,
      })),
    },
    countTokensSynthetic: perEpoch.map((entry) => ({
      epoch: entry.epoch,
      ...entry.countTokens,
    })),
    byteEstimates: {
      estimate: true,
      perEpochLastRequest: perEpoch.map((entry) => ({
        epoch: entry.epoch,
        ...entry.requests.at(-1)?.tokenEstimate,
      })),
    },
    note: 'Provider-reported usage is the mock script, not a tokenizer; bytes/3 and bytes/4 are estimates.',
  });
  ledger.record(
    's02.guard-recommendation',
    'run',
    guard.status === 'provisional' ? STATUS.measured : STATUS.unresolved,
    guard,
  );
  return { label, perEpoch, growth, fixedBytes, coldStartMs, guard };
}
