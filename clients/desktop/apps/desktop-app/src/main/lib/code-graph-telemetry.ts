import type {
  CodeGraphQueryKind,
  CodeGraphQueryOutcome,
} from '@canopy/code-graph/host/read-scheduler';
import type { CodeGraphReadFailure } from '@canopy/desktop-shared/types/code-graph-tools';
import type {
  CodeGraphReadDiagnosticDetail,
  SessionDiagnosticRecord,
} from '../observability/service';

/** Local-only bounded code-graph read diagnostics; nothing is reported remotely. */
const READ_DIAGNOSTIC_LIMIT = 256;
const READ_DIAGNOSTIC_WINDOW_MS = 60_000;
interface ReadDiagnosticBucket {
  projectId: string;
  worktreeId: string;
  detail: CodeGraphReadDiagnosticDetail;
}
const readDiagnosticBuckets = new Map<string, ReadDiagnosticBucket>();
let omittedReadDiagnosticKeys = 0;
let readDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
type ReadDiagnosticRecorder = (record: SessionDiagnosticRecord) => void;
let readDiagnosticRecorder: ReadDiagnosticRecorder | null = null;

function safeDiagnosticDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 86_400_000)) : 0;
}

function emitLocalReadDiagnostic(bucket: ReadDiagnosticBucket): void {
  const record: SessionDiagnosticRecord = {
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'code_graph_read',
    projectId: bucket.projectId,
    worktreeId: bucket.worktreeId,
    chatId: '',
    providerType: 'unknown',
    sessionKey: `${bucket.projectId}/${bucket.worktreeId}/`,
    codeGraphRead: bucket.detail,
  };
  if (readDiagnosticRecorder !== null) {
    try {
      readDiagnosticRecorder(record);
    } catch {
      /* Observability cannot affect reads. */
    }
    return;
  }
  void import('../observability')
    .then(({ peekObservabilityService }) =>
      peekObservabilityService()?.recordSessionDiagnostic(record),
    )
    .catch(() => undefined);
}

function readDiagnosticOwner(
  key: string,
): { projectId: string; worktreeId: string } | null {
  const [projectId, worktreeId = ''] = key.split('/');
  // Canonical workspace/worktree IDs only. Never infer ownership from a path/base hash.
  if (
    projectId === undefined ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectId) ||
    (worktreeId !== '' && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(worktreeId))
  )
    return null;
  return { projectId, worktreeId };
}

export function recordCodeGraphReadDiagnostic(input: {
  key: string;
  kind: CodeGraphQueryKind;
  outcome: CodeGraphQueryOutcome;
  queueDurationMs: number;
  executionDurationMs: number;
  readFailure?: CodeGraphReadFailure;
}): void {
  const owner = readDiagnosticOwner(input.key);
  if (owner === null) return;
  const key = `${owner.projectId}/${owner.worktreeId}/${input.kind}/${input.outcome}`;
  let bucket = readDiagnosticBuckets.get(key);
  if (bucket === undefined) {
    if (readDiagnosticBuckets.size >= READ_DIAGNOSTIC_LIMIT) {
      omittedReadDiagnosticKeys = Math.min(
        Number.MAX_SAFE_INTEGER,
        omittedReadDiagnosticKeys + 1,
      );
      return;
    }
    bucket = {
      ...owner,
      detail: {
        kind: input.kind,
        outcome: input.outcome,
        requestCount: 0,
        queueDurationMsTotal: 0,
        queueDurationMsMax: 0,
        executionDurationMsTotal: 0,
        executionDurationMsMax: 0,
        failureCounts: {},
      },
    };
    readDiagnosticBuckets.set(key, bucket);
  }
  const queueMs = safeDiagnosticDuration(input.queueDurationMs);
  const executionMs = safeDiagnosticDuration(input.executionDurationMs);
  bucket.detail.requestCount = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.requestCount + 1,
  );
  bucket.detail.queueDurationMsTotal = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.queueDurationMsTotal + queueMs,
  );
  bucket.detail.queueDurationMsMax = Math.max(
    bucket.detail.queueDurationMsMax,
    queueMs,
  );
  bucket.detail.executionDurationMsTotal = Math.min(
    Number.MAX_SAFE_INTEGER,
    bucket.detail.executionDurationMsTotal + executionMs,
  );
  bucket.detail.executionDurationMsMax = Math.max(
    bucket.detail.executionDurationMsMax,
    executionMs,
  );
  if (input.readFailure !== undefined)
    bucket.detail.failureCounts[input.readFailure] = Math.min(
      Number.MAX_SAFE_INTEGER,
      (bucket.detail.failureCounts[input.readFailure] ?? 0) + 1,
    );
  if (readDiagnosticTimer === null) {
    readDiagnosticTimer = setTimeout(
      flushCodeGraphReadDiagnostics,
      READ_DIAGNOSTIC_WINDOW_MS,
    );
    readDiagnosticTimer.unref?.();
  }
}

function containsAsciiIdentityControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f) return true;
  }
  return false;
}

export function recordCodeGraphSummaryFanoutDiagnostic(input: {
  projectId: string;
  worktreeId: string;
  outcomes: NonNullable<CodeGraphReadDiagnosticDetail['repositories']>;
}): void {
  const owner = readDiagnosticOwner(`${input.projectId}/${input.worktreeId}`);
  if (owner === null) return;
  const repositories = input.outcomes.slice(0, 64).map((outcome) => ({
    ...outcome,
    repoId:
      outcome.repoId.length <= 1024 &&
      !/[\\/]/.test(outcome.repoId) &&
      !containsAsciiIdentityControl(outcome.repoId)
        ? outcome.repoId
        : '[redacted]',
  }));
  const outcome: CodeGraphQueryOutcome = input.outcomes.some(
    (entry) => entry.state === 'error',
  )
    ? 'error'
    : 'success';
  recordCodeGraphReadDiagnostic({
    key: `${owner.projectId}/${owner.worktreeId}`,
    kind: 'ui-summary',
    outcome,
    queueDurationMs: 0,
    executionDurationMs: 0,
  });
  const bucket = readDiagnosticBuckets.get(
    `${owner.projectId}/${owner.worktreeId}/ui-summary/${outcome}`,
  );
  if (bucket !== undefined) {
    bucket.detail.repositories = repositories;
    bucket.detail.omittedRepositoryCount = Math.max(
      0,
      input.outcomes.length - repositories.length,
    );
  }
}

export function flushCodeGraphReadDiagnostics(): void {
  if (readDiagnosticTimer !== null) {
    clearTimeout(readDiagnosticTimer);
    readDiagnosticTimer = null;
  }
  const buckets = Array.from(readDiagnosticBuckets.values());
  readDiagnosticBuckets.clear();
  const first = buckets[0];
  if (first !== undefined && omittedReadDiagnosticKeys > 0)
    first.detail.omittedKeyCount = omittedReadDiagnosticKeys;
  omittedReadDiagnosticKeys = 0;
  for (const bucket of buckets) emitLocalReadDiagnostic(bucket);
}

export function setCodeGraphReadDiagnosticRecorderForTests(
  recorder: ReadDiagnosticRecorder | null,
): void {
  readDiagnosticRecorder = recorder;
}

export function resetCodeGraphReadDiagnosticsForTests(): void {
  if (readDiagnosticTimer !== null) clearTimeout(readDiagnosticTimer);
  readDiagnosticTimer = null;
  readDiagnosticBuckets.clear();
  readDiagnosticRecorder = null;
  omittedReadDiagnosticKeys = 0;
}
