import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const IGNORED_FUNCTIONS = new Set([
  '(idle)',
  '(program)',
  '(garbage collector)',
  '(root)',
]);
const ATTRIBUTED_RUNTIME_FUNCTIONS = new Set([
  // Native child_process implementation.
  'spawn',
  // node:sqlite StatementSync / DatabaseSync native implementations. Their
  // generic names otherwise hide the store or analysis phase that issued the
  // synchronous operation in Code Graph utility workers.
  'all',
  'exec',
  'get',
  'prepare',
  'run',
]);
const MAX_ATTRIBUTED_APPLICATION_DEPTH = 6;

function generatedFilePath(url) {
  try {
    if (url.startsWith('file:')) return fileURLToPath(url.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  return path.isAbsolute(url) ? url : null;
}

function createSourceMapper() {
  const cache = new Map();
  return (frame) => {
    const generatedPath = generatedFilePath(frame.url ?? '');
    if (!generatedPath) return null;
    const directMapPath = `${generatedPath}.map`;
    const mapPath = existsSync(directMapPath)
      ? directMapPath
      : path.join(
          path.dirname(generatedPath),
          `${path.basename(generatedPath).replace(/^_/, '')}.map`,
        );
    if (!cache.has(mapPath)) {
      if (!existsSync(mapPath)) {
        cache.set(mapPath, null);
      } else {
        try {
          cache.set(
            mapPath,
            new TraceMap(JSON.parse(readFileSync(mapPath, 'utf8'))),
          );
        } catch {
          cache.set(mapPath, null);
        }
      }
    }
    const map = cache.get(mapPath);
    if (!map) return null;
    const original = originalPositionFor(map, {
      line: Math.max(1, (frame.lineNumber ?? 0) + 1),
      column: Math.max(0, frame.columnNumber ?? 0),
    });
    if (!original.source) return null;
    return {
      functionName: original.name || frame.functionName || '(anonymous)',
      url: original.source,
      line: original.line,
      column: original.column === null ? null : original.column + 1,
      mapped: true,
    };
  };
}

function normalizeFrame(frame, sourceMapper) {
  const mapped = sourceMapper(frame);
  if (mapped) return mapped;
  return {
    functionName: frame.functionName || '(anonymous)',
    url: frame.url || '(native or anonymous)',
    line: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
    column: Number.isInteger(frame.columnNumber)
      ? frame.columnNumber + 1
      : null,
    mapped: false,
  };
}

function classifyFrame(frame) {
  const location = frame.url.replaceAll('\\', '/');
  if (
    location.includes('/apps/') ||
    location.includes('/packages/') ||
    location.includes('/.cache/brand/')
  ) {
    return 'application';
  }
  if (
    location.includes('/node_modules/') ||
    /\/vendor-[^/]+\.js/.test(location)
  ) {
    return 'dependency';
  }
  if (
    !frame.mapped &&
    location.includes('/out-e2e/') &&
    !/\/vendor-[^/]+\.js/.test(location)
  ) {
    return 'application-unmapped';
  }
  return 'runtime';
}

function hotspotKey(frame) {
  return [
    frame.functionName,
    frame.url,
    frame.line ?? '',
    frame.column ?? '',
  ].join('\u0000');
}

function buildParentIds(profile) {
  const parentIds = new Map();
  for (const node of profile.nodes ?? []) {
    for (const childId of node.children ?? []) {
      if (!parentIds.has(childId)) parentIds.set(childId, node.id);
    }
  }
  return parentIds;
}

function summarizeRuntimeCallerPaths({
  profile,
  normalizedNodes,
  sampledUs,
  limit,
}) {
  const parentIds = buildParentIds(profile);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const runtimeTotals = new Map();
  const byPath = new Map();

  for (let index = 0; index < samples.length; index += 1) {
    const sampledNodeId = samples[index];
    const sampledFrame = normalizedNodes.get(sampledNodeId);
    if (
      !sampledFrame ||
      !ATTRIBUTED_RUNTIME_FUNCTIONS.has(sampledFrame.functionName) ||
      sampledFrame.category !== 'runtime'
    ) {
      continue;
    }

    const selfUs = Math.max(0, deltas[index] ?? 0);
    runtimeTotals.set(
      sampledFrame.functionName,
      (runtimeTotals.get(sampledFrame.functionName) ?? 0) + selfUs,
    );

    const applicationPath = [];
    const seenFrames = new Set();
    let ancestorId = parentIds.get(sampledNodeId);
    while (
      ancestorId !== undefined &&
      applicationPath.length < MAX_ATTRIBUTED_APPLICATION_DEPTH
    ) {
      const ancestor = normalizedNodes.get(ancestorId);
      if (!ancestor) break;
      if (ancestor.category === 'application') {
        const key = hotspotKey(ancestor);
        if (!seenFrames.has(key)) {
          applicationPath.push(ancestor);
          seenFrames.add(key);
        }
      }
      ancestorId = parentIds.get(ancestorId);
    }

    const pathKey = applicationPath.map(hotspotKey).join('\u0001');
    const key = `${sampledFrame.functionName}\u0000${pathKey}`;
    const current = byPath.get(key) ?? {
      runtimeFunction: sampledFrame.functionName,
      applicationPath,
      selfUs: 0,
      sampleCount: 0,
    };
    current.selfUs += selfUs;
    current.sampleCount += 1;
    byPath.set(key, current);
  }

  return [...byPath.values()]
    .sort((left, right) => right.selfUs - left.selfUs)
    .slice(0, limit)
    .map((entry) => {
      const runtimeUs = runtimeTotals.get(entry.runtimeFunction) ?? 0;
      return {
        runtimeFunction: entry.runtimeFunction,
        selfMs: entry.selfUs / 1_000,
        profilePercent: sampledUs === 0 ? 0 : (entry.selfUs / sampledUs) * 100,
        runtimePercent: runtimeUs === 0 ? 0 : (entry.selfUs / runtimeUs) * 100,
        sampleCount: entry.sampleCount,
        applicationPath: entry.applicationPath.map((frame) => ({
          functionName: frame.functionName,
          url: frame.url,
          line: frame.line,
          column: frame.column,
          mapped: frame.mapped,
          category: frame.category,
        })),
      };
    });
}

export function summarizeCpuProfile(
  profile,
  { processName, limit = 20, samplingIntervalUs = null },
) {
  const sourceMapper = createSourceMapper();
  const normalizedNodes = new Map(
    (profile.nodes ?? []).map((node) => {
      const frame = normalizeFrame(node.callFrame, sourceMapper);
      return [node.id, { ...frame, category: classifyFrame(frame) }];
    }),
  );
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const byFrame = new Map();
  let sampledUs = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const frame = normalizedNodes.get(samples[index]);
    if (!frame) continue;
    const selfUs = Math.max(0, deltas[index] ?? 0);
    sampledUs += selfUs;
    const key = hotspotKey(frame);
    const current = byFrame.get(key) ?? {
      ...frame,
      selfUs: 0,
      sampleCount: 0,
    };
    current.selfUs += selfUs;
    current.sampleCount += 1;
    byFrame.set(key, current);
  }

  const toPublic = (entry) => ({
    functionName: entry.functionName,
    url: entry.url,
    line: entry.line,
    column: entry.column,
    mapped: entry.mapped,
    category: entry.category,
    selfMs: entry.selfUs / 1_000,
    selfPercent: sampledUs === 0 ? 0 : (entry.selfUs / sampledUs) * 100,
    sampleCount: entry.sampleCount,
  });
  const ranked = [...byFrame.values()]
    .filter((entry) => !IGNORED_FUNCTIONS.has(entry.functionName))
    .sort((left, right) => right.selfUs - left.selfUs);
  const application = ranked.filter(
    (entry) => entry.category === 'application',
  );
  const generated = ranked.filter(
    (entry) => entry.category === 'application-unmapped',
  );
  const applicationUs = application.reduce(
    (total, entry) => total + entry.selfUs,
    0,
  );

  return {
    process: processName,
    samplingIntervalUs,
    durationMs:
      Number.isFinite(profile.endTime) && Number.isFinite(profile.startTime)
        ? (profile.endTime - profile.startTime) / 1_000
        : null,
    sampledMs: sampledUs / 1_000,
    applicationSelfMs: applicationUs / 1_000,
    applicationSelfPercent:
      sampledUs === 0 ? 0 : (applicationUs / sampledUs) * 100,
    sourceMappedFrames: ranked.filter((entry) => entry.mapped).length,
    topApplication: application.slice(0, limit).map(toPublic),
    topGenerated: generated.slice(0, limit).map(toPublic),
    topOverall: ranked.slice(0, limit).map(toPublic),
    runtimeCallerPaths: summarizeRuntimeCallerPaths({
      profile,
      normalizedNodes,
      sampledUs,
      limit,
    }),
  };
}

function markdownTable(entries) {
  if (entries.length === 0) return '_No sampled frames in this category._';
  return [
    '| Self | Function | Location | Category |',
    '| ---: | --- | --- | --- |',
    ...entries.map((entry) => {
      const location = `${entry.url}${entry.line ? `:${entry.line}` : ''}`;
      return `| ${entry.selfMs.toFixed(1)} ms (${entry.selfPercent.toFixed(1)}%) | \`${entry.functionName.replaceAll('|', '\\|')}\` | \`${location.replaceAll('|', '\\|')}\` | ${entry.category} |`;
    }),
  ].join('\n');
}

function runtimeCallerTable(entries) {
  if (entries.length === 0) {
    return '_No attributed native/runtime caller paths were sampled._';
  }
  return [
    '| Runtime self | Runtime | Nearest application ancestry |',
    '| ---: | --- | --- |',
    ...entries.map((entry) => {
      const ancestry =
        entry.applicationPath.length === 0
          ? '(no mapped application ancestor)'
          : entry.applicationPath
              .map((frame) => {
                const location = `${frame.url}${frame.line ? `:${frame.line}` : ''}`;
                return `\`${frame.functionName.replaceAll('|', '\\|')}\` (\`${location.replaceAll('|', '\\|')}\`)`;
              })
              .join(' ← ');
      return `| ${entry.selfMs.toFixed(1)} ms (${entry.runtimePercent.toFixed(1)}% of \`${entry.runtimeFunction}\`) | \`${entry.runtimeFunction}\` | ${ancestry} |`;
    }),
  ].join('\n');
}

function renderBenchmarkSignal(context) {
  if (!context) return [];
  const violations = context.responsiveness?.violations ?? [];
  const lines = [
    '',
    '## Clean benchmark signal',
    '',
    `Clean-pass verdict: **${context.status ?? 'unknown'}**.`,
  ];
  if (violations.length > 0) {
    lines.push(
      '',
      '| Failed metric | Observed | Ceiling |',
      '| --- | ---: | ---: |',
      ...violations.map((entry) => {
        const unit = entry.unit === 'count' ? '' : ` ${entry.unit ?? 'ms'}`;
        return `| \`${entry.metric}\` | ${entry.value.toFixed(1)}${unit} | ${entry.budgetMs}${unit} |`;
      }),
    );
  } else {
    lines.push(
      '',
      'No absolute responsiveness ceiling failed; this replay was requested explicitly or by a relative comparison.',
    );
  }
  const rendererFailure = violations.some((entry) =>
    entry.metric.startsWith('renderer.'),
  );
  const ipcFailure = violations.some((entry) =>
    entry.metric.startsWith('ipc.'),
  );
  if (rendererFailure || ipcFailure) {
    const direction = [
      rendererFailure ? 'renderer scheduling/rendering' : null,
      ipcFailure ? 'main/IPC scheduling' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    lines.push(
      '',
      `Initial direction from the clean signal: inspect **${direction}** first, then use the simultaneous trace to verify causality.`,
    );
  }
  return lines;
}

export function renderHotspotMarkdown({
  scenarioName,
  summaries,
  benchmarkContext,
}) {
  const sections = [
    `# Performance triage: ${scenarioName}`,
    '',
    'This is a diagnostic replay. Profiler overhead means its timings must not replace the clean benchmark result.',
    ...renderBenchmarkSignal(benchmarkContext),
  ];
  for (const summary of summaries) {
    sections.push(
      '',
      `## ${summary.process}`,
      '',
      `Profiled ${summary.sampledMs.toFixed(1)} ms at ${summary.samplingIntervalUs ?? 'unknown'} µs intervals; application self samples account for ${summary.applicationSelfPercent.toFixed(1)}% of profiled time.`,
      '',
      '### Application hot paths',
      '',
      markdownTable(summary.topApplication.slice(0, 15)),
      '',
      '### Generated or unmapped hot paths',
      '',
      markdownTable((summary.topGenerated ?? []).slice(0, 15)),
      '',
      '### Overall hot paths',
      '',
      markdownTable(summary.topOverall.slice(0, 15)),
      '',
      '### Native/runtime caller paths',
      '',
      runtimeCallerTable((summary.runtimeCallerPaths ?? []).slice(0, 15)),
    );
  }
  sections.push(
    '',
    '## How to use these artifacts',
    '',
    '- Start with application frames consuming a material share of renderer CPU when timer/frame/input latency failed.',
    '- Start with main-process frames when renderer-to-main heartbeat latency failed or background work is active.',
    '- If neither profile has a dominant application frame, inspect `electron-trace.json` around the `canopy-perf:*` workload/task marks for IPC waits, rendering/layout, child/utility work, or OS scheduling. CPU sampling cannot explain blocked I/O by itself.',
    '- Open the `.cpuprofile` files in Chromium DevTools Performance and the trace in Perfetto or a compatible Chromium trace viewer. Keep the adjacent build source maps available.',
    '',
  );
  return sections.join('\n');
}
