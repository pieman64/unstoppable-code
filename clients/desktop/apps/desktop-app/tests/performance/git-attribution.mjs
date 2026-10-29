import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const KNOWN_SOURCES = new Set([
  'branch-watcher',
  'renderer-global-poll',
  'renderer-targeted',
  'portal-snapshot',
  'desktop-session-snapshot',
  'runtime-status',
  'cli',
  'user-explicit',
  'untagged',
]);

const KNOWN_COMMAND_FAMILIES = new Set([
  'add',
  'branch',
  'check-ignore',
  'check-ref-format',
  'checkout',
  'commit',
  'config',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'hash-object',
  'log',
  'ls-files',
  'ls-remote',
  'merge-base',
  'merge-tree',
  'mv',
  'remote',
  'reset',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'update-index',
  'version',
  'worktree',
]);

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeSource(value) {
  return KNOWN_SOURCES.has(value) ? value : 'other';
}

function normalizeFamily(value) {
  if (value === '--version') return 'version';
  return KNOWN_COMMAND_FAMILIES.has(value) ? value : 'other';
}

function maxConcurrency(records) {
  const events = records.flatMap((record) => [
    { at: record.startedAt, delta: 1 },
    ...(Number.isFinite(record.completedAt)
      ? [{ at: record.completedAt, delta: -1 }]
      : []),
  ]);
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function summarizeRecords(records) {
  const completed = records.filter((record) =>
    Number.isFinite(record.completedAt),
  );
  const durations = completed.map(
    (record) => (record.completedAt - record.startedAt) * 1_000,
  );
  return {
    commandCount: records.length,
    completedCommandCount: completed.length,
    incompleteCommandCount: records.length - completed.length,
    uniqueTaggedRequestCount: new Set(
      records
        .map((record) => record.requestId)
        .filter((requestId) => requestId !== 'unset'),
    ).size,
    maxConcurrent: maxConcurrency(records),
    durationMs: {
      p50: round(percentile(durations, 0.5) ?? 0),
      p95: round(percentile(durations, 0.95) ?? 0),
      max: round(durations.length > 0 ? Math.max(...durations) : 0),
      total: round(durations.reduce((sum, duration) => sum + duration, 0)),
    },
  };
}

function rankedGroups(records, keyName, keyForRecord) {
  const groups = new Map();
  for (const record of records) {
    const key = keyForRecord(record);
    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .map(([key, entries]) => ({
      [keyName]: key,
      ...summarizeRecords(entries),
    }))
    .sort(
      (left, right) =>
        right.commandCount - left.commandCount ||
        String(left[keyName]).localeCompare(String(right[keyName])),
    );
}

function crossSourceOverlaps(records) {
  const completed = records.filter((record) =>
    Number.isFinite(record.completedAt),
  );
  const counts = new Map();
  for (let leftIndex = 0; leftIndex < completed.length; leftIndex += 1) {
    const left = completed[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < completed.length;
      rightIndex += 1
    ) {
      const right = completed[rightIndex];
      if (left.source === right.source) continue;
      if (
        left.startedAt >= right.completedAt ||
        right.startedAt >= left.completedAt
      ) {
        continue;
      }
      const sources = [left.source, right.source].sort();
      const key = sources.join('\0');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, overlapCount]) => ({
      sources: key.split('\0'),
      overlapCount,
    }))
    .sort(
      (left, right) =>
        right.overlapCount - left.overlapCount ||
        left.sources.join().localeCompare(right.sources.join()),
    );
}

export function summarizeGitAttributionLog(text) {
  const starts = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [phase, rawAt, pid, first, second, third] = line.split('\t');
    const at = Number(rawAt);
    if (!Number.isFinite(at) || !pid) continue;
    if (phase === 'start') {
      starts.set(pid, {
        pid,
        startedAt: at,
        source: normalizeSource(first),
        requestId: second || 'unset',
        commandFamily: normalizeFamily(third),
      });
      continue;
    }
    if (phase === 'end') {
      const record = starts.get(pid);
      if (!record || at < record.startedAt) continue;
      record.completedAt = at;
      record.exitCode = Number.isFinite(Number(first)) ? Number(first) : null;
    }
  }

  const records = [...starts.values()];
  return {
    schemaVersion: 1,
    captureKind: 'diagnostic-git-wrapper',
    timingComparable: false,
    ...summarizeRecords(records),
    bySource: rankedGroups(records, 'source', (record) => record.source),
    byCommandFamily: rankedGroups(
      records,
      'commandFamily',
      (record) => record.commandFamily,
    ),
    sourceCommandFamilies: rankedGroups(
      records,
      'sourceCommandFamily',
      (record) => `${record.source}:${record.commandFamily}`,
    ),
    crossSourceOverlaps: crossSourceOverlaps(records),
  };
}

export function prepareGitAttributionCapture(userDataDir) {
  if (process.platform !== 'darwin') {
    throw new Error(
      '--git-attribution currently requires macOS, the supported desktop performance development host',
    );
  }
  const realGitPath = '/usr/bin/git';
  if (!existsSync(realGitPath)) {
    throw new Error(`Git attribution requires ${realGitPath}`);
  }
  const captureDir = path.join(userDataDir, 'performance-git-attribution');
  const logPath = path.join(captureDir, 'commands.tsv');
  const shimPath = path.join(captureDir, 'git-attribution.zsh');
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(logPath, '');
  writeFileSync(
    shimPath,
    `#!/bin/zsh
zmodload zsh/datetime
source_name="\${CANOPY_GIT_REQUEST_SOURCE:-untagged}"
request_id="\${CANOPY_GIT_REQUEST_ID:-unset}"
git_args=("$@")
family="other"
while (( $# > 0 )); do
  case "$1" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix)
      shift
      (( $# > 0 )) && shift
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--config-env=*|--exec-path=*|--list-cmds=*|--attr-source=*)
      shift
      ;;
    --version)
      family="version"
      break
      ;;
    -*)
      shift
      ;;
    *)
      case "$1" in
        add|branch|check-ignore|check-ref-format|checkout|commit|config|diff|diff-tree|fetch|for-each-ref|hash-object|log|ls-files|ls-remote|merge-base|merge-tree|mv|remote|reset|rev-list|rev-parse|show|show-ref|status|symbolic-ref|update-index|worktree) family="$1" ;;
      esac
      break
      ;;
  esac
done
printf 'start\\t%.6f\\t%s\\t%s\\t%s\\t%s\\n' "$EPOCHREALTIME" "$$" "$source_name" "$request_id" "$family" >> "$CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG"
"$CANOPY_PERFORMANCE_REAL_GIT" "\${git_args[@]}"
exit_code=$?
printf 'end\\t%.6f\\t%s\\t%s\\n' "$EPOCHREALTIME" "$$" "$exit_code" >> "$CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG"
exit "$exit_code"
`,
  );
  chmodSync(shimPath, 0o755);
  return {
    env: {
      CANOPY_GIT_EXECUTABLE: shimPath,
      CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG: logPath,
      CANOPY_PERFORMANCE_REAL_GIT: realGitPath,
    },
    summarize: () =>
      summarizeGitAttributionLog(
        existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
      ),
  };
}
