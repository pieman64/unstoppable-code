import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  PipelineAdvisorEta,
  PipelineAdvisorHealthStatus,
  PipelineAdvisorInefficiency,
  PipelineAdvisorReport,
  PipelineAdvisorSeverity,
  PipelineAdvisorSnapshot,
  PipelineAdvisorTurnKind,
} from '@canopy/execution-engine/types/pipeline';
import type { ThinkingLevel } from '@canopy/desktop-shared/types';

export const PIPELINE_ADVISOR_FILE_NAME = 'pipeline-advisor.json';

const MAX_REPORTS = 50;

export function getPipelineExecutionDataDir(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(executionsDir, executionId);
}

export function getPipelineAdvisorSnapshotPath(
  executionsDir: string,
  executionId: string,
): string {
  return path.join(
    getPipelineExecutionDataDir(executionsDir, executionId),
    PIPELINE_ADVISOR_FILE_NAME,
  );
}

export async function readPipelineAdvisorSnapshot(
  executionsDir: string,
  executionId: string,
): Promise<PipelineAdvisorSnapshot | null> {
  try {
    const raw = await readFile(
      getPipelineAdvisorSnapshotPath(executionsDir, executionId),
      'utf8',
    );
    return normalizeSnapshot(JSON.parse(raw), executionId);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    return null;
  }
}

export async function writePipelineAdvisorSnapshot(
  executionsDir: string,
  snapshot: PipelineAdvisorSnapshot,
): Promise<void> {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) {
    throw new Error('Cannot write invalid pipeline advisor snapshot.');
  }

  const filePath = getPipelineAdvisorSnapshotPath(
    executionsDir,
    normalized.executionId,
  );
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let shouldCleanup = true;
  try {
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
    await rename(tempPath, filePath);
    shouldCleanup = false;
  } finally {
    if (shouldCleanup) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export async function listPipelineAdvisorSnapshots(
  executionsDir: string,
  executionIds?: string[],
): Promise<PipelineAdvisorSnapshot[]> {
  const ids =
    executionIds ??
    (await readdir(executionsDir, { withFileTypes: true })
      .then((entries) =>
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      )
      .catch(() => []));
  const snapshots: PipelineAdvisorSnapshot[] = [];
  for (const executionId of ids) {
    const snapshot = await readPipelineAdvisorSnapshot(
      executionsDir,
      executionId,
    );
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  snapshots.sort((left, right) =>
    right.lastUpdatedAt.localeCompare(left.lastUpdatedAt),
  );
  return snapshots;
}

function normalizeSnapshot(
  value: unknown,
  expectedExecutionId?: string,
): PipelineAdvisorSnapshot | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const executionId = readNonEmptyString(value.executionId);
  const executionDataDir = readNonEmptyString(value.executionDataDir);
  const stateFilePath = readNonEmptyString(value.stateFilePath);
  const provider = normalizeProvider(value.provider);
  const thinkingLevel = normalizeThinkingLevel(value.thinkingLevel);
  const status = normalizeSnapshotStatus(value.status);
  const model = readNonEmptyString(value.model);
  const lastUpdatedAt = readNonEmptyString(value.lastUpdatedAt);
  const pipelineStartedAt = readNonEmptyString(value.pipelineStartedAt);
  if (
    !executionId ||
    (expectedExecutionId !== undefined &&
      executionId !== expectedExecutionId) ||
    !executionDataDir ||
    !stateFilePath ||
    !provider ||
    !thinkingLevel ||
    !status ||
    !model ||
    !lastUpdatedAt
  ) {
    return null;
  }

  const reports = Array.isArray(value.reports)
    ? value.reports
        .map((report) => normalizeReport(report, executionId))
        .filter((report): report is PipelineAdvisorReport => report !== null)
        .slice(-MAX_REPORTS)
    : [];
  const latestReport =
    normalizeReport(value.latestReport, executionId) ??
    reports[reports.length - 1];

  return {
    version: 1,
    executionId,
    executionDataDir,
    stateFilePath,
    provider,
    model,
    thinkingLevel,
    ...(readNonEmptyString(value.sdkSessionId)
      ? { sdkSessionId: readNonEmptyString(value.sdkSessionId) }
      : {}),
    status,
    turnCount: readNonNegativeInteger(value.turnCount),
    backoffIndex: readNonNegativeInteger(value.backoffIndex),
    lastUpdatedAt,
    ...(pipelineStartedAt ? { pipelineStartedAt } : {}),
    ...(readNonEmptyString(value.nextUpdateAt)
      ? { nextUpdateAt: readNonEmptyString(value.nextUpdateAt) }
      : {}),
    ...(readNonEmptyString(value.finalizedCompletedAt)
      ? { finalizedCompletedAt: readNonEmptyString(value.finalizedCompletedAt) }
      : {}),
    reports,
    ...(latestReport ? { latestReport } : {}),
    ...(normalizeLastError(value.lastError) ?? {}),
  };
}

export function normalizePipelineAdvisorReports(
  reports: PipelineAdvisorReport[],
): PipelineAdvisorReport[] {
  return reports.slice(-MAX_REPORTS);
}

function normalizeReport(
  value: unknown,
  executionId: string,
): PipelineAdvisorReport | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const reportId = readNonEmptyString(value.reportId);
  const kind = normalizeTurnKind(value.kind);
  const generatedAt = readNonEmptyString(value.generatedAt);
  const pipelineStatus = normalizePipelineStatus(value.pipelineStatus);
  const health = normalizeHealth(value.health);
  const eta = normalizeEta(value.eta);
  if (
    !reportId ||
    !kind ||
    !generatedAt ||
    !pipelineStatus ||
    !health ||
    !eta
  ) {
    return null;
  }
  return {
    version: 1,
    reportId,
    executionId,
    kind,
    generatedAt,
    pipelineStatus,
    health,
    eta,
    inefficiencies: Array.isArray(value.inefficiencies)
      ? value.inefficiencies
          .map(normalizeInefficiency)
          .filter((item): item is PipelineAdvisorInefficiency => item !== null)
      : [],
    summary: readString(value.summary),
    recommendations: readStringArray(value.recommendations),
  };
}

function normalizeHealth(
  value: unknown,
): PipelineAdvisorReport['health'] | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    status: normalizeHealthStatus(value.status),
    score: clampScore(value.score),
    summary: readString(value.summary),
    evidence: readStringArray(value.evidence),
    blockers: readStringArray(value.blockers),
  };
}

function normalizeEta(value: unknown): PipelineAdvisorEta | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    status: normalizeEtaStatus(value.status),
    ...(readNonEmptyString(value.expectedCompletionAt)
      ? { expectedCompletionAt: readNonEmptyString(value.expectedCompletionAt) }
      : {}),
    ...(typeof value.remainingSeconds === 'number' &&
    Number.isFinite(value.remainingSeconds)
      ? { remainingSeconds: Math.max(0, Math.round(value.remainingSeconds)) }
      : {}),
    confidence: normalizeEtaConfidence(value.confidence),
    rationale: readString(value.rationale),
  };
}

function normalizeInefficiency(
  value: unknown,
): PipelineAdvisorInefficiency | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = readNonEmptyString(value.title);
  const evidence = readNonEmptyString(value.evidence);
  if (!title || !evidence) {
    return null;
  }
  return {
    severity: normalizeSeverity(value.severity),
    title,
    evidence,
    ...(readNonEmptyString(value.recommendation)
      ? { recommendation: readNonEmptyString(value.recommendation) }
      : {}),
    ...(readNonEmptyString(value.relatedJobId)
      ? { relatedJobId: readNonEmptyString(value.relatedJobId) }
      : {}),
    ...(readNonEmptyString(value.relatedStepId)
      ? { relatedStepId: readNonEmptyString(value.relatedStepId) }
      : {}),
  };
}

function normalizeLastError(
  value: unknown,
): Pick<PipelineAdvisorSnapshot, 'lastError'> | null {
  if (!isRecord(value)) {
    return null;
  }
  const message = readNonEmptyString(value.message);
  const at = readNonEmptyString(value.at);
  if (!message || !at) {
    return null;
  }
  return {
    lastError: {
      message,
      at,
      retryable: typeof value.retryable === 'boolean' ? value.retryable : true,
      consecutiveFailures: readNonNegativeInteger(value.consecutiveFailures),
    },
  };
}

function normalizeProvider(
  value: unknown,
): PipelineAdvisorSnapshot['provider'] | null {
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  return null;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | null {
  switch (value) {
    case 'off':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return value;
    default:
      return null;
  }
}

function normalizeSnapshotStatus(
  value: unknown,
): PipelineAdvisorSnapshot['status'] | null {
  switch (value) {
    case 'starting':
    case 'running':
    case 'waiting':
    case 'failed':
    case 'completed':
    case 'cancelled':
      return value;
    default:
      return null;
  }
}

function normalizeTurnKind(value: unknown): PipelineAdvisorTurnKind | null {
  switch (value) {
    case 'initial':
    case 'periodic':
    case 'final':
      return value;
    default:
      return null;
  }
}

function normalizePipelineStatus(
  value: unknown,
): PipelineAdvisorReport['pipelineStatus'] | null {
  switch (value) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'success':
    case 'failure':
    case 'cancelled':
      return value;
    default:
      return null;
  }
}

function normalizeHealthStatus(value: unknown): PipelineAdvisorHealthStatus {
  switch (value) {
    case 'healthy':
    case 'watch':
    case 'degraded':
    case 'blocked':
    case 'complete':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeEtaStatus(value: unknown): PipelineAdvisorEta['status'] {
  switch (value) {
    case 'available':
    case 'unknown':
    case 'complete':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeEtaConfidence(
  value: unknown,
): PipelineAdvisorEta['confidence'] {
  switch (value) {
    case 'low':
    case 'medium':
    case 'high':
      return value;
    default:
      return 'low';
  }
}

function normalizeSeverity(value: unknown): PipelineAdvisorSeverity {
  switch (value) {
    case 'info':
    case 'warning':
    case 'critical':
      return value;
    default:
      return 'info';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim() !== '',
      )
    : [];
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function clampScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function isMissingFileError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === 'ENOENT' ||
      (error.code === 'ENOTDIR' && typeof error.path === 'string'))
  );
}
