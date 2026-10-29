// Turns one arm's raw observations into a bounded summary and the four
// follow-up ledger rows. Pure: no I/O, no runtime handles.
import { BROWSER_AGENT_TOOL_NAMES } from '../shared/tool-schemas.mjs';
import { armDefinition } from './followup-variants.mjs';
import {
  classifyContextSignals,
  classifyNotify,
  classifySurface,
  classifyWaitResolution,
  classifyWrapperRun,
  extractSurface,
  findToolExchanges,
} from './followup-analysis.mjs';
import { isGenerationRecord } from './request-breakdown.mjs';

const SNIPPET = 300;
const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

const exchangeSummary = (exchange) =>
  exchange
    ? {
        qualified: exchange.qualified,
        callType: exchange.callType,
        answered: exchange.answered,
        inputBytes: exchange.inputBytes,
        outputSnippet: (exchange.outputText ?? '').slice(0, SNIPPET),
      }
    : null;

function surfaceKey(surface) {
  return JSON.stringify([
    surface.topLevel.map((entry) => entry.qualified).sort(),
    [...surface.wrapper.nested].sort(),
  ]);
}

function outboundTextOf(records) {
  let total = 0;
  const parts = [];
  for (const record of records) {
    if (typeof record.rawBase64 !== 'string') continue;
    const text = Buffer.from(record.rawBase64, 'base64').toString('utf8');
    total += text.length;
    if (total > MAX_OUTBOUND_BYTES) break;
    parts.push(text);
  }
  return parts.join('\n');
}

/**
 * @param {{
 *   id: string,
 *   snapshot: { records: object[] },
 *   hostCalls: { tool: string, namespace: string | null, generationsSeen: number }[],
 *   wrapperEvidence: { hostCanary: string, envCanary: string, spawnMarkerExists: boolean, loopbackHits: number },
 *   notifyDelta: number | null,
 *   eventMethods: string[],
 *   tokenUsageEvents: object[],
 *   turn: { status: string, error: string | null },
 *   twin: { model?: string } | null,
 * }} input
 */
export function summarizeArm(input) {
  const definition = armDefinition(input.id);
  const records = input.snapshot?.records ?? [];
  const generation = records
    .filter(
      (record) =>
        isGenerationRecord(record) &&
        record.json &&
        typeof record.json === 'object',
    )
    .sort((a, b) => a.seq - b.seq);
  const eventMethods = [...new Set(input.eventMethods ?? [])];
  const base = {
    id: input.id,
    kind: definition.kind,
    namespace: definition.namespace,
    model: input.twin?.model ?? null,
    requestedModel: definition.model,
    // A different model reported than requested means a silent fallback.
    modelMatches: input.twin ? input.twin.model === definition.model : null,
    turn: input.turn,
    notifyDelta: input.notifyDelta,
    hostCalls: (input.hostCalls ?? []).map(
      ({ tool, namespace, generationsSeen }) => ({
        tool,
        namespace,
        generationsSeen,
      }),
    ),
    tokenUsageEvents: (input.tokenUsageEvents ?? []).slice(-12),
    eventMethods,
    compaction: {
      eventMethods: eventMethods.filter((method) => /compact/i.test(method)),
      requestPaths: records
        .filter(
          (record) =>
            !isGenerationRecord(record) && /compact/i.test(record.path ?? ''),
        )
        .map((record) => record.path),
    },
    requestCount: generation.length,
  };
  if (generation.length === 0)
    return { ...base, surface: null, direct: null, wait: null, wrapper: null };

  const first = extractSurface(generation[0].json);
  const stable = generation.every(
    (record) => surfaceKey(extractSurface(record.json)) === surfaceKey(first),
  );
  const browser = definition.kind === 'browser';
  const verdict = browser
    ? classifySurface(first, BROWSER_AGENT_TOOL_NAMES, {
        namespace: definition.namespace,
      })
    : null;
  const exchanges = findToolExchanges(generation.at(-1).json);
  const find = (name) => exchanges.find((exchange) => exchange.name === name);
  const direct = browser
    ? {
        observe: exchangeSummary(find('observe')),
        wait: exchangeSummary(find('wait')),
        exec: exchangeSummary(find('exec')),
      }
    : null;
  const wait = browser
    ? classifyWaitResolution({
        // Direct wait calls happen after request 2; waits after request 3 come
        // from inside the wrapper and must not stand in for the direct call.
        hostCalls: base.hostCalls.filter(
          (call) => call.tool === 'wait' && call.generationsSeen < 3,
        ),
        exchange: find('wait'),
        expectedNamespace: definition.namespace,
      })
    : null;
  const wrapper = browser
    ? classifyWrapperRun({
        exchange: find('exec'),
        outboundText: outboundTextOf(records),
        wrapperAdvertised: first.wrapper.present,
        evidence: {
          ...input.wrapperEvidence,
          hostToolCallsDuringExec: base.hostCalls.filter(
            (call) => call.tool === 'observe' && call.generationsSeen >= 3,
          ).length,
          hostWaitCallsDuringExec: base.hostCalls.filter(
            (call) => call.tool === 'wait' && call.generationsSeen >= 3,
          ).length,
        },
      })
    : null;
  return {
    ...base,
    surface: {
      topLevel: first.topLevel.map((entry) => entry.qualified),
      wrapper: {
        present: first.wrapper.present,
        name: first.wrapper.name,
        nestedCount: first.wrapper.nested.length,
        nested: first.wrapper.nested,
      },
      stableAcrossRequests: stable,
      verdict,
    },
    direct,
    wait,
    wrapper,
  };
}

const UNOBSERVED_CONTEXT = Object.freeze([
  'real tokenizer calibration (scripted usage only)',
  'whether and when autocompaction fires near the configured limit',
  'cross-epoch native resume (forbidden by plan; not attempted)',
]);

/**
 * The four follow-up ledger rows (all phase `run`).
 *
 * @param {ReturnType<typeof summarizeArm>[]} summaries
 * @param {{ threshold: number, configObservation: object | null }} options
 */
export function evaluateFollowUp(summaries, { threshold, configObservation }) {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const rows = [];

  const browserArms = summaries.filter(
    (summary) => summary.kind === 'browser' && summary.surface,
  );
  const closedArms = browserArms
    .filter(
      (arm) =>
        arm.surface.verdict.closed &&
        arm.modelMatches === true &&
        arm.wait?.handledBy === 'host-dynamic-tool',
    )
    .map((arm) => arm.id);
  rows.push({
    id: 'followup.codex-surface',
    phase: 'run',
    status:
      browserArms.length === 0
        ? 'unobserved'
        : closedArms.length > 0
          ? 'pass'
          : 'fail',
    evidence: {
      closedArms,
      scope:
        'Candidate configurations observed against the loopback mock only; a pass names a configuration worth qualifying, not a production binding. A closed arm needs the reported model to equal the requested one (no silent fallback); direct-model is a synthetic contrast and says nothing about account availability of that model.',
      matrix: browserArms.map((arm) => ({
        arm: arm.id,
        model: arm.model,
        requestedModel: arm.requestedModel,
        modelMatches: arm.modelMatches,
        reachability: arm.surface.verdict.reachability,
        direct: arm.surface.verdict.direct.length,
        wrapped: arm.surface.verdict.wrapped.length,
        missing: arm.surface.verdict.missing,
        extraTopLevel: arm.surface.verdict.extraTopLevel,
        extraWrapped: arm.surface.verdict.extraWrapped,
        collisions: arm.surface.verdict.collisions,
        wrapperPresent: arm.surface.verdict.wrapperPresent,
        closed: arm.surface.verdict.closed,
        stableAcrossRequests: arm.surface.stableAcrossRequests,
        waitHandledBy: arm.wait?.handledBy ?? null,
        directObserve: arm.direct?.observe?.answered ?? null,
        turn: arm.turn,
      })),
      note: 'Scripted direct calls are routed by the runtime regardless of advertisement; advertised surface and callable surface are reported separately and neither is inferred from a tool name.',
    },
  });

  const wrapperArms = summaries.filter((summary) => summary.wrapper);
  const statuses = wrapperArms.map((arm) => arm.wrapper.status);
  const wrapperStatus =
    wrapperArms.length === 0
      ? 'unobserved'
      : statuses.includes('fail')
        ? 'fail'
        : statuses.includes('pass')
          ? 'pass'
          : statuses.includes('blocked')
            ? 'blocked'
            : statuses.every((status) => status === 'unavailable')
              ? 'n/a'
              : 'unobserved';
  rows.push({
    id: 'followup.codex-wrapper',
    phase: 'run',
    status: wrapperStatus,
    evidence: {
      perArm: wrapperArms.map((arm) => ({
        arm: arm.id,
        status: arm.wrapper.status,
        reason: arm.wrapper.reason,
        jsExecuted: arm.wrapper.jsExecuted,
        positiveControl: arm.wrapper.positiveControl,
        permittedActions: arm.wrapper.permittedActions,
        escapes: arm.wrapper.escapes,
        exposedPrimitives: arm.wrapper.exposedPrimitives,
        execExchange: arm.direct?.exec ?? null,
      })),
      note: 'A pass requires JS output, denial of every escape, clean independent evidence and a host-tool call from inside the wrapper. A tool error is unobserved, not contained; the wrapper name is not evidence of host execution.',
    },
  });

  const notify = classifyNotify({
    baseline: byId.get('baseline')?.notifyDelta,
    suppressed: byId.get('notify-empty')?.notifyDelta,
    after: byId.get('coding-control-after')?.notifyDelta,
  });
  rows.push({
    id: 'followup.codex-notify',
    phase: 'run',
    status: notify.status,
    evidence: {
      ...notify,
      counts: {
        baseline: byId.get('baseline')?.notifyDelta ?? null,
        'notify-empty': byId.get('notify-empty')?.notifyDelta ?? null,
        'coding-control-after':
          byId.get('coding-control-after')?.notifyDelta ?? null,
      },
      note: 'Thread-scoped override on one warm pooled app-server process; process config, home and pool profile are unchanged.',
    },
  });

  const contextArm = byId.get('toggles-context');
  const signals = classifyContextSignals(contextArm?.tokenUsageEvents ?? [], {
    threshold,
  });
  rows.push({
    id: 'followup.context',
    phase: 'run',
    status: contextArm ? signals.status : 'unobserved',
    evidence: {
      signals,
      compaction: contextArm?.compaction ?? null,
      configObservation,
      unobserved: [...UNOBSERVED_CONTEXT],
    },
  });
  return rows;
}
