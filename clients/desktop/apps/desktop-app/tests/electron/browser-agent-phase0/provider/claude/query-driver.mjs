// Runs one SDK query() with every await bounded, then closes it and drains the
// reader. `query` is injected so the driver is unit-testable without a provider.
import { performance } from 'node:perf_hooks';

const MAX_MESSAGES = 400;
const MAX_STDERR = 16 * 1024;

function summarizeContent(content) {
  if (!Array.isArray(content))
    return { text: typeof content === 'string' ? content.length : 0 };
  const toolUses = [];
  const types = {};
  for (const block of content) {
    types[block?.type ?? 'unknown'] =
      (types[block?.type ?? 'unknown'] ?? 0) + 1;
    if (block?.type === 'tool_use') toolUses.push(block.name);
  }
  return { types, toolUses };
}

/**
 * @param {object} input
 * @param {(arg: { prompt: string, options: object }) => AsyncGenerator & { close(): void }} input.query
 * @param {string} input.prompt
 * @param {object} input.options SDK options (abortController and stderr are added here)
 * @param {number} input.timeoutMs hard bound for the whole query
 * @param {number} [input.drainMs] after the result message, time allowed for trailing traffic before close()
 * @param {() => Promise<{ pid: number, command: string }[]>} [input.findProcesses] polled right after spawn
 * @param {() => number} [input.now]
 * @param {{ settleMs: number } | null} [input.stopAfterInit] close the query this long after the init message (init-metadata-only arms)
 * @param {{ afterAssistantMessages: number, detail?: 'summary' | 'full', timeoutMs?: number } | null} [input.contextUsage]
 *   sample `getContextUsage` (window occupancy, NOT billed usage) after the Nth assistant message and at the result
 */
export async function driveQuery({
  query,
  prompt,
  options,
  timeoutMs,
  drainMs = 2_500,
  findProcesses,
  now = () => performance.now(),
  stopAfterInit = null,
  contextUsage = null,
}) {
  const abortController = new AbortController();
  const stderrChunks = [];
  let stderrBytes = 0;
  const timeline = {
    startedAtMs: now(),
    spawnObservedAtMs: null,
    initAtMs: null,
    firstAssistantAtMs: null,
    resultAtMs: null,
    closedAtMs: null,
  };
  const messages = [];
  const counts = {};
  const toolUses = [];
  const systemMessages = [];
  let init = null;
  let result = null;
  let error = null;
  let timedOut = false;
  let q = null;
  let drainTimer = null;
  const processes = new Map();
  const contextSamples = [];
  const pendingSamples = [];
  let assistantCount = 0;
  const sampleContext = (label) => {
    if (!contextUsage) return;
    const sample = { label, atMs: Math.round(now() - timeline.startedAtMs) };
    contextSamples.push(sample);
    const timeoutMs = contextUsage.timeoutMs ?? 4_000;
    pendingSamples.push(
      (async () => {
        if (typeof q?.getContextUsage !== 'function') {
          sample.error = 'getContextUsage is not available on this query';
          return;
        }
        let timer = null;
        try {
          const response = await Promise.race([
            q.getContextUsage({ detail: contextUsage.detail ?? 'summary' }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('getContextUsage timed out')),
                timeoutMs,
              );
            }),
            deadline,
          ]);
          if (response === expired) throw new Error('query deadline reached');
          Object.assign(sample, summarizeContextUsage(response));
        } catch (caught) {
          sample.error = String(caught?.message ?? caught).slice(0, 200);
        } finally {
          clearTimeout(timer);
        }
      })(),
    );
  };
  let initCloseTimer = null;

  const expired = Symbol('query deadline');
  let resolveDeadline;
  const deadline = new Promise((resolve) => {
    resolveDeadline = resolve;
  });
  const hardTimer = setTimeout(() => {
    timedOut = true;
    resolveDeadline(expired);
    abortController.abort();
    try {
      q?.close();
    } catch {
      /* already closed */
    }
  }, timeoutMs);

  let polling = true;
  const poller = findProcesses
    ? (async () => {
        const deadline = now() + 4_000;
        while (polling && now() < deadline) {
          try {
            const found = await findProcesses();
            if (!polling) break;
            for (const proc of found) {
              if (!processes.has(proc.pid))
                processes.set(proc.pid, {
                  pid: proc.pid,
                  command: proc.command.slice(0, 200),
                });
              timeline.spawnObservedAtMs ??= now();
            }
          } catch {
            /* process listing is best effort */
          }
          if (timeline.spawnObservedAtMs !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      })()
    : Promise.resolve();

  try {
    q = query({
      prompt,
      options: {
        ...options,
        abortController,
        stderr: (chunk) => {
          if (stderrBytes < MAX_STDERR) {
            stderrChunks.push(String(chunk).slice(0, MAX_STDERR - stderrBytes));
            stderrBytes += String(chunk).length;
          }
        },
      },
    });
    const iterator = q[Symbol.asyncIterator]();
    // close()/abort() do not guarantee that a pending SDK next() settles.
    // Do not await iterator.return() on expiry for the same reason.
    while (true) {
      const step = await Promise.race([iterator.next(), deadline]);
      if (step === expired || step.done) break;
      const message = step.value;
      const at = now();
      counts[message.type] = (counts[message.type] ?? 0) + 1;
      const entry = {
        type: message.type,
        subtype: message.subtype ?? null,
        atMs: Math.round(at - timeline.startedAtMs),
      };
      if (message.type === 'system' && message.subtype === 'init') {
        init = message;
        timeline.initAtMs ??= at;
        if (stopAfterInit)
          initCloseTimer = setTimeout(() => {
            try {
              q.close();
            } catch {
              /* already closed */
            }
          }, stopAfterInit.settleMs);
      } else if (message.type === 'system') {
        systemMessages.push({
          subtype: message.subtype,
          atMs: entry.atMs,
          summary: JSON.stringify(message).slice(0, 400),
        });
      } else if (message.type === 'assistant') {
        timeline.firstAssistantAtMs ??= at;
        assistantCount += 1;
        if (
          contextUsage &&
          assistantCount === contextUsage.afterAssistantMessages
        )
          sampleContext(`after-assistant-${assistantCount}`);
        Object.assign(entry, summarizeContent(message.message?.content));
        toolUses.push(...(entry.toolUses ?? []));
      } else if (message.type === 'user') {
        Object.assign(entry, summarizeContent(message.message?.content));
      } else if (message.type === 'result') {
        result = message;
        timeline.resultAtMs = at;
        sampleContext('at-result');
        drainTimer = setTimeout(() => {
          try {
            q.close();
          } catch {
            /* already closed */
          }
        }, drainMs);
      }
      if (messages.length < MAX_MESSAGES) messages.push(entry);
    }
  } catch (caught) {
    error = {
      name: caught?.name ?? 'Error',
      message: String(caught?.message ?? caught).slice(0, 500),
      aborted: abortController.signal.aborted,
    };
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    if (initCloseTimer) clearTimeout(initCloseTimer);
    polling = false;
    // Best-effort observations must also fit inside the query deadline.
    await Promise.race([Promise.all(pendingSamples), deadline]);
    try {
      q?.close();
    } catch {
      /* already closed */
    }
    await Promise.race([poller, deadline]);
    clearTimeout(hardTimer);
    timeline.closedAtMs = now();
  }
  return {
    init,
    result,
    error,
    timedOut,
    timeline,
    messageCounts: counts,
    messages,
    toolUses,
    systemMessages,
    processes: [...processes.values()],
    contextSamples,
    stderrTail: stderrChunks.join('').slice(-4_000),
  };
}

/**
 * Window occupancy summary. `totalTokens` is the CLI's context estimate for the
 * next request; it is not the billed/cumulative usage reported on the result.
 */
export function summarizeContextUsage(response) {
  if (!response || typeof response !== 'object')
    return { error: 'no response' };
  const categories = Array.isArray(response.categories)
    ? response.categories
        .filter((category) => category?.kind === 'used')
        .map((category) => ({ name: category.name, tokens: category.tokens }))
    : [];
  return {
    totalTokens: response.totalTokens ?? null,
    maxTokens: response.maxTokens ?? null,
    rawMaxTokens: response.rawMaxTokens ?? null,
    percentage: response.percentage ?? null,
    autoCompactThreshold: response.autoCompactThreshold ?? null,
    isAutoCompactEnabled: response.isAutoCompactEnabled ?? null,
    usedCategories: categories.slice(0, 20),
    memoryFileCount: Array.isArray(response.memoryFiles)
      ? response.memoryFiles.length
      : null,
    mcpToolCount: Array.isArray(response.mcpTools)
      ? response.mcpTools.length
      : null,
    agentCount: Array.isArray(response.agents) ? response.agents.length : null,
    skillCount: response.skills?.totalSkills ?? null,
  };
}

/** Elapsed milliseconds helpers for the report. */
export function latencySummary(timeline, firstRequestAtMs) {
  const since = (value) =>
    value === null || value === undefined
      ? null
      : Math.round(value - timeline.startedAtMs);
  return {
    spawnObservedMs: since(timeline.spawnObservedAtMs),
    initMs: since(timeline.initAtMs),
    firstRequestMs: since(firstRequestAtMs),
    firstAssistantMs: since(timeline.firstAssistantAtMs),
    resultMs: since(timeline.resultAtMs),
    closedMs: since(timeline.closedAtMs),
    resolutionNote:
      'spawn and first-request times are polled (about 25-60 ms resolution); init and result are SDK message arrival times',
  };
}
