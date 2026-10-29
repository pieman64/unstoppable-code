// Pure requirement evaluators over recorded facts (init messages, captured
// request bodies, scripted-loop events). No provider or filesystem access.
import { advertisedToolNames, toolResultText } from './anthropic-bytes.mjs';
import { ROTATION_LOOP, browserToolName } from './scripts.mjs';

/** Built-in tools whose presence with `tools: []` the plan asks about (05 L419). */
export const QUESTIONED_BUILTINS = Object.freeze([
  'ToolSearch',
  'Agent',
  'Task',
  'Skill',
]);

const names = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter(Boolean);

/** Compare an advertised tool list with the exact expected set. */
export function compareToolSet(advertised, expected) {
  const have = new Set(advertised);
  const want = new Set(expected);
  const missing = [...want].filter((name) => !have.has(name));
  const extra = [...have].filter((name) => !want.has(name));
  return {
    exact: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    forbiddenPresent: extra.filter((name) =>
      QUESTIONED_BUILTINS.includes(name),
    ),
  };
}

/** launch.claude-init: the init message is minimal and fixture-free. */
export function evaluateInit(init, { expectedTools, cwd }) {
  if (!init)
    return {
      status: 'unobserved',
      problems: ['no init message was received'],
      fields: null,
    };
  const problems = [];
  const tools = compareToolSet(names(init.tools), expectedTools);
  if (!tools.exact)
    problems.push({
      field: 'tools',
      missing: tools.missing,
      extra: tools.extra,
    });
  if (names(init.skills).length > 0)
    problems.push({ field: 'skills', value: names(init.skills) });
  if (names(init.plugins).length > 0)
    problems.push({ field: 'plugins', value: names(init.plugins) });
  const mcp = names(init.mcp_servers);
  if (mcp.length !== 1 || mcp[0] !== 'browser')
    problems.push({ field: 'mcp_servers', value: mcp });
  if (init.output_style !== 'default')
    problems.push({ field: 'output_style', value: init.output_style });
  if (cwd && init.cwd !== cwd)
    problems.push({ field: 'cwd', value: init.cwd, expected: cwd });
  if (JSON.stringify(init).includes('bap0-'))
    problems.push({
      field: 'fixture-derived-name',
      value: 'a bap0- fixture name appears in init',
    });
  const slash = names(init.slash_commands);
  return {
    status: problems.length === 0 ? 'pass' : 'fail',
    problems,
    fields: {
      tools: names(init.tools),
      skills: names(init.skills),
      plugins: init.plugins ?? [],
      mcp_servers: init.mcp_servers ?? [],
      slash_commands: slash,
      slashCommandsNonEmpty: slash.length > 0,
      output_style: init.output_style,
      agents: init.agents ?? null,
      model: init.model,
      cwd: init.cwd,
      apiKeySource: init.apiKeySource,
      permissionMode: init.permissionMode,
      claude_code_version: init.claude_code_version,
      session_id: init.session_id,
      capabilities: init.capabilities ?? null,
      plugin_errors: init.plugin_errors ?? null,
    },
  };
}

/** launch.tool-surface at one phase: every request's `tools` array plus init.tools. */
export function evaluateToolSurface({
  initTools,
  requestBodies,
  expectedTools,
}) {
  const perRequest = requestBodies.map((body, index) => ({
    request: index + 1,
    ...compareToolSet(advertisedToolNames(body), expectedTools),
  }));
  const init = compareToolSet(names(initTools), expectedTools);
  const exact =
    init.exact &&
    perRequest.length > 0 &&
    perRequest.every((entry) => entry.exact);
  return {
    status: requestBodies.length === 0 ? 'unobserved' : exact ? 'pass' : 'fail',
    init,
    perRequest,
  };
}

/** close.claude-tools-empty: ToolSearch / Agent / Task / Skill absent from init and every request. */
export function evaluateToolsEmpty({
  initTools,
  requestBodies,
  expectedTools,
}) {
  const initSet = compareToolSet(names(initTools), expectedTools);
  const requests = requestBodies.map((body, index) => ({
    request: index + 1,
    forbidden: compareToolSet(advertisedToolNames(body), expectedTools)
      .forbiddenPresent,
    extra: compareToolSet(advertisedToolNames(body), expectedTools).extra,
  }));
  const leaked = [
    ...new Set([
      ...initSet.forbiddenPresent,
      ...requests.flatMap((entry) => entry.forbidden),
    ]),
  ];
  return {
    status:
      requestBodies.length === 0 && !initTools
        ? 'unobserved'
        : leaked.length === 0
          ? 'pass'
          : 'fail',
    leaked,
    initExtra: initSet.extra,
    requestExtra: [...new Set(requests.flatMap((entry) => entry.extra))],
    note: 'Other extra tools are judged by launch.tool-surface.',
  };
}

/** The is_error tool_result (if any) answering a scripted unavailable native tool. */
export function findUnavailableToolResult(requestBodies, toolName = 'Bash') {
  for (const body of requestBodies) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const useIds = new Set();
    for (const message of messages) {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks)
        if (block?.type === 'tool_use' && block.name === toolName)
          useIds.add(block.id);
    }
    for (const message of messages) {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_result' && useIds.has(block.tool_use_id))
          return {
            isError: block.is_error === true,
            preview: toolResultText(block).slice(0, 200),
          };
      }
    }
  }
  return null;
}

/**
 * close.claude-between-tool across every consecutive request pair.
 *
 * @param {{ epoch: number, diffs: ReturnType<typeof import('./anthropic-bytes.mjs').betweenToolDiff>[] }[]} loops
 */
export function evaluateBetweenTool(loops) {
  const all = loops.flatMap((loop) =>
    loop.diffs.map((diff, index) => ({
      epoch: loop.epoch,
      pair: index + 1,
      diff,
    })),
  );
  if (all.length === 0)
    return {
      status: 'unobserved',
      reason: 'no consecutive request pair was captured',
      pairs: 0,
    };
  const bad = all.filter(
    (entry) =>
      !entry.diff.shapeOk ||
      !entry.diff.prefixStable ||
      entry.diff.systemChanged ||
      entry.diff.toolsChanged,
  );
  return {
    status: bad.length === 0 ? 'pass' : 'fail',
    pairs: all.length,
    offending: bad.map(({ epoch, pair, diff }) => ({
      epoch,
      pair,
      addedMessageCount: diff.addedMessageCount,
      prefixStable: diff.prefixStable,
      systemChanged: diff.systemChanged,
      toolsChanged: diff.toolsChanged,
      extras: diff.extras,
      extraBytes: diff.extraBytes,
      extraCanaries: diff.extraCanaries,
    })),
    extraBytesTotal: all.reduce((sum, entry) => sum + entry.diff.extraBytes, 0),
  };
}

/** close.claude-disable-mds: B (without) versus C (with) and instruction canaries in C. */
export function evaluateDisableMds({ comparison, instructionHitsWithFlag }) {
  if (!comparison || comparison.compared === 0)
    return { status: 'unobserved', reason: 'no comparable request pair' };
  if (instructionHitsWithFlag > 0)
    return {
      status: 'fail',
      reason:
        'an instruction canary reached a request even with CLAUDE_CODE_DISABLE_CLAUDE_MDS=1',
      comparison,
    };
  const first = comparison.perRequest[0];
  const effect = comparison.identical
    ? 'no observable difference in model-visible content between the launches'
    : `model-visible content differs (first request: system delta ${first?.systemByteDelta} B, messages delta ${first?.messageByteDelta} B; C minus B)`;
  return {
    status: 'measured',
    effect,
    identical: comparison.identical,
    comparison,
  };
}

/**
 * Rotation requirements from per-epoch facts.
 *
 * @param {{ epoch: number, sessionId: string|null, sentinel: string, firstRequestMessageCount: number|null, oldCanary: Record<string,string>, sentinelInToolResults: boolean, toolsExecuted: string[], resultOk: boolean }[]} epochs
 */
export function evaluateRotation(epochs, { resumeOptionUsed = false } = {}) {
  const later = epochs.filter((entry) => entry.epoch > 1);
  const oldStatuses = later.flatMap((entry) => Object.values(entry.oldCanary));
  let oldStatus;
  if (
    later.length === 0 ||
    epochs.some((entry) => !entry.sentinelInToolResults)
  )
    oldStatus = epochs.length === 0 ? 'unobserved' : 'blocked';
  else if (oldStatuses.includes('fail')) oldStatus = 'fail';
  else if (oldStatuses.includes('blocked')) oldStatus = 'blocked';
  else
    oldStatus = oldStatuses.every((status) => status === 'pass')
      ? 'pass'
      : 'unobserved';
  const ids = epochs.map((entry) => entry.sessionId);
  const distinct = ids.every(Boolean) && new Set(ids).size === ids.length;
  const fresh = epochs.every((entry) => entry.firstRequestMessageCount === 1);
  const resumeStatus =
    epochs.length === 0
      ? 'unobserved'
      : distinct && fresh && !resumeOptionUsed
        ? 'pass'
        : 'fail';
  const expected = ROTATION_LOOP.map(browserToolName);
  const loopOk =
    epochs.length > 0 &&
    epochs.every(
      (entry) =>
        entry.resultOk &&
        JSON.stringify(
          entry.toolsExecuted.map((name) => browserToolName(name)),
        ) === JSON.stringify(expected),
    );
  return {
    oldCanaryAbsent: {
      status: oldStatus,
      detail: {
        perEpoch: epochs.map(({ epoch, oldCanary, sentinelInToolResults }) => ({
          epoch,
          oldCanary,
          sentinelInToolResults,
        })),
      },
    },
    noResume: {
      status: resumeStatus,
      detail: {
        sessionIds: ids,
        distinct,
        freshFirstRequest: fresh,
        resumeOptionUsed,
      },
    },
    repeatedTools: {
      status: epochs.length === 0 ? 'unobserved' : loopOk ? 'pass' : 'fail',
      detail: {
        expected: ROTATION_LOOP,
        perEpoch: epochs.map(({ epoch, toolsExecuted, resultOk }) => ({
          epoch,
          toolsExecuted,
          resultOk,
        })),
      },
    },
  };
}

/** The induced launch failure must actually fail before canary results mean anything. */
export function evaluateLaunchFailure({
  result,
  error,
  requestCount,
  statuses,
}) {
  const failed =
    Boolean(error) ||
    result?.is_error === true ||
    (result && result.subtype !== 'success');
  const worst = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('blocked')
      ? 'blocked'
      : statuses.every((status) => status === 'unobserved')
        ? 'unobserved'
        : 'pass';
  return {
    induced: failed,
    status: !failed ? 'blocked' : worst,
    detail: {
      resultSubtype: result?.subtype ?? null,
      isError: result?.is_error ?? null,
      apiErrorStatus: result?.api_error_status ?? null,
      error: error ?? null,
      modelRequests: requestCount,
    },
  };
}
