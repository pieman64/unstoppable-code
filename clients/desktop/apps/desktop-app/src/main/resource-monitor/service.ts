import { getHeapStatistics } from 'node:v8';
import * as os from 'node:os';
import type * as ChildProcessModule from 'node:child_process';
import type { ProcessMetric } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { CHAT_LABEL } from '@canopy/protocol';
import { loadRequiredNodeModule } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import {
  IPC_CHANNELS,
  type ResourceGroupId,
  type ResourceMetadata,
  type ResourceMonitorSnapshot,
  type ResourcePressureLevel,
  type ResourceProcessKind,
  type ResourceProcessSnapshot,
} from '@canopy/desktop-shared/types';
import {
  createDesktopInstrumentationOperationKey,
  type DesktopInstrumentationContext,
} from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { getObservabilityService } from '../observability';
import { getActivePipelineExecutionCount } from '../pipelines/pipeline-execution-registry';
import {
  getPerformanceLimits,
  getPerformanceLimitsVersion,
} from '../lib/performance-limits';
import { isRecord } from '../lib/type-guards';
import {
  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
} from '@canopy/desktop-shared/constants/preferences';
import { sendToWebContents } from '../lib/web-contents-send';

const GIB = 1024 * 1024 * 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 2_000;
/**
 * Sampling runs at the base interval only while the app window is focused.
 * An unfocused/hidden window still gets fresh snapshots (guards and pressure
 * handling keep working) but at this multiple of the base interval, so a
 * backgrounded app is not forking `ps` and waking the renderer every 2s.
 */
const UNFOCUSED_SAMPLE_INTERVAL_MULTIPLIER = 5;
/**
 * Node clamps `setTimeout` delays above 2^31-1 to **1ms**. The unfocused
 * multiplier can push a large `CANOPY_RESOURCE_MONITOR_INTERVAL_MS` override
 * (the Electron specs use 2147483647 to mean "never tick") past that limit,
 * which turned the intended slow cadence into a 1ms real-sample storm that
 * overwrote injected test snapshots (resource-monitor.spec failures on
 * unfocused CI windows). Cap every computed delay at the Node maximum.
 */
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;
/**
 * Minimum spacing between idle codex pool suspension sweeps while pressure
 * stays critical. Sweeps are cheap (idle checks decline fast) but each
 * suspended process re-registers observability diagnostics, so once a minute
 * is plenty.
 */
const CODEX_POOL_SUSPEND_ATTEMPT_MIN_INTERVAL_MS = 60_000;
/**
 * Broadcasts are skipped while consecutive snapshots are materially
 * unchanged, but never suppressed longer than this, so renderer consumers
 * that surface `sampledAt` freshness cannot go arbitrarily stale.
 */
const MAX_BROADCAST_SILENCE_MS = 30_000;
/** RSS quantization for the material-change signature (32 MiB buckets). */
const RSS_SIGNATURE_BUCKET_BYTES = 32 * 1024 * 1024;
const MANAGED_PROCESS_OPERATION_NAME = 'canopy.managed_process';
const DEFAULT_WARNING_FREE_RATIO = 0.12;
const DEFAULT_CRITICAL_FREE_RATIO = 0.08;
const PROCESS_TABLE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const WINDOWS_PROCESS_TABLE_TIMEOUT_MS = 15_000;
const WINDOWS_CPU_TIME_UNITS_PER_SECOND = 10_000_000;
const WINDOWS_PROCESS_TABLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$processes = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { [int]$_.ProcessId -ne $PID } | ForEach-Object {
  [pscustomobject]@{
    ProcessId = [int]$_.ProcessId
    ParentProcessId = [int]$_.ParentProcessId
    CpuTime100ns = ([UInt64]$_.KernelModeTime + [UInt64]$_.UserModeTime)
    WorkingSetSize = [UInt64]$_.WorkingSetSize
    Name = [string]$_.Name
    CommandLine = [string]$_.CommandLine
  }
}
@($processes) | ConvertTo-Json -Compress
`;
const GROUP_LABELS: Record<ResourceGroupId, string> = {
  app: BRAND.displayName,
  browser: 'Browser',
  codex: 'Codex',
  claude: 'Claude',
  chat: CHAT_LABEL,
  pipelines: 'Pipelines',
  terminal: 'Terminals',
  scripts: 'Script',
  other: 'Other',
};

interface ResourceMonitorWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, snapshot: ResourceMonitorSnapshot): void;
  };
}
const PRESSURE_RANK: Record<ResourcePressureLevel, number> = {
  unknown: 0,
  ok: 1,
  warning: 2,
  critical: 3,
};
const rejectedOverrideWarnings = new Set<string>();
let cachedThresholds: {
  version: number;
  thresholds: ResourceMonitorThresholds;
} | null = null;

export interface ResourceRegistrationHandle {
  update(update: Partial<ResourceProcessRegistration>): void;
  unregister(): void;
}

export interface ResourceGuardReservation {
  release(): void;
}

export interface ResourceProcessRegistration {
  id: string;
  groupId: ResourceGroupId;
  kind: ResourceProcessKind;
  label: string;
  pid?: number;
  processGroupId?: number;
  startedAt?: string;
  metadata?: ResourceMetadata;
}

interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  cpuPercent: number;
  memoryRssBytes: number;
  command: string;
}

interface WindowsProcessCpuSample {
  cpuTime100ns: number;
  sampledAtMs: number;
}

interface WindowsProcessTableParseResult {
  rows: Map<number, ProcessTableRow>;
  cpuSamples: Map<number, WindowsProcessCpuSample>;
}

interface ResourceMonitorThresholds {
  warningMemoryBytes: number;
  criticalMemoryBytes: number;
  warningFreeRatio: number;
  criticalFreeRatio: number;
}

interface SamplingData {
  processRows: Map<number, ProcessTableRow>;
  appRows: Map<number, ResourceProcessSnapshot>;
  childrenByParent: Map<number, ProcessTableRow[]>;
  error?: string;
  processTableAvailable: boolean;
}

type ResourceRegistrationType = 'process' | 'work_item';

interface AggregatedProcess {
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  children: ResourceProcessSnapshot[];
  ppid?: number;
}

interface ChatTurnConcurrencySnapshot {
  activeTurns: number;
  pendingMessages: number;
}

interface CodexPoolResourceSnapshotSummary {
  clientCount: number;
  activeTurnCount: number;
  pid?: number;
}

interface ActiveManagedProcessOperation {
  operationKey: string;
  registrationType: ResourceRegistrationType;
  registeredAtMs: number;
  initialRegistration: ResourceProcessRegistration;
}

function buildManagedProcessTelemetryContext(
  registration: ResourceProcessRegistration,
  registrationType: ResourceRegistrationType,
  status: 'started' | 'completed' | 'abandoned',
  durationMs?: number,
): DesktopInstrumentationContext {
  const metadata = registration.metadata;
  const pipelineMeta = metadata?.type === 'pipeline' ? metadata.pipeline : null;
  const codexMeta = metadata?.type === 'codex-pool' ? metadata.codexPool : null;
  return {
    registration_type: registrationType,
    kind: registration.kind,
    group_id: registration.groupId,
    metadata_type: metadata?.type,
    has_pid: typeof registration.pid === 'number',
    has_process_group_id: typeof registration.processGroupId === 'number',
    has_pipeline_id: pipelineMeta
      ? Boolean(pipelineMeta.pipelineId)
      : undefined,
    has_pipeline_job: pipelineMeta ? Boolean(pipelineMeta.jobId) : undefined,
    has_pipeline_step: pipelineMeta ? Boolean(pipelineMeta.stepId) : undefined,
    pipeline_attempt: pipelineMeta?.attempt,
    pipeline_iteration: pipelineMeta?.iteration,
    codex_pool_pooled: codexMeta?.pooled,
    codex_pool_client_count: codexMeta?.clientCount,
    codex_pool_active_turn_count: codexMeta?.activeTurnCount,
    codex_pool_initialized: codexMeta?.initialized,
    duration_ms: durationMs,
    status,
  };
}

function safelyEmitManagedProcessTelemetry(callback: () => void): void {
  try {
    callback();
  } catch {
    // Telemetry must never affect resource tracking.
  }
}

interface ElectronAppMetricsProvider {
  getAppMetrics: () => unknown;
}

function isElectronAppMetricsProvider(
  value: unknown,
): value is ElectronAppMetricsProvider {
  return isRecord(value) && typeof value.getAppMetrics === 'function';
}

function isCodexPoolResourceSnapshotSummary(
  value: unknown,
): value is CodexPoolResourceSnapshotSummary {
  if (!isRecord(value)) {
    return false;
  }
  const { clientCount, activeTurnCount, pid } = value;
  return (
    typeof clientCount === 'number' &&
    typeof activeTurnCount === 'number' &&
    (pid === undefined || typeof pid === 'number')
  );
}

function isChildProcessModule(
  value: unknown,
): value is typeof ChildProcessModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execFile' in value &&
    typeof value.execFile === 'function'
  );
}

async function readMacProcessTable(): Promise<string> {
  const childProcess = loadRequiredNodeModule<typeof ChildProcessModule>({
    moduleId: 'node:child_process',
    requireFrom: __filename,
    validate: isChildProcessModule,
  });
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,pcpu=,rss=,command='],
      {
        encoding: 'utf8',
        maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('execFile failed'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function readWindowsProcessTable(): Promise<string> {
  const childProcess = loadRequiredNodeModule<typeof ChildProcessModule>({
    moduleId: 'node:child_process',
    requireFrom: __filename,
    validate: isChildProcessModule,
  });
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_PROCESS_TABLE_SCRIPT,
      ],
      {
        encoding: 'utf8',
        maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
        timeout: WINDOWS_PROCESS_TABLE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error('execFile failed'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class ResourceGuardError extends Error {
  readonly code = 'resource-guard-blocked';

  constructor(message: string) {
    super(message);
    this.name = 'ResourceGuardError';
  }
}

/**
 * Material-change signature for renderer broadcasts. CPU is rounded to whole
 * percent and RSS quantized to 32 MiB buckets so measurement jitter on an
 * otherwise-quiet system does not defeat the skip; everything the renderer
 * renders structurally (pressure, guards, group/process rows) participates.
 * `sampledAt` is deliberately excluded — it changes every sample.
 */
function buildBroadcastSignature(snapshot: ResourceMonitorSnapshot): string {
  const signatureOfProcess = (process: ResourceProcessSnapshot): unknown[] => [
    process.id,
    process.kind,
    process.pid ?? null,
    process.status,
    Math.round(process.cpuPercent),
    Math.round(process.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
    process.processCount,
    (process.children ?? []).map(signatureOfProcess),
  ];
  return JSON.stringify([
    snapshot.pressure.level,
    snapshot.pressure.reasons,
    snapshot.processCount,
    Math.round(snapshot.cpuPercent),
    Math.round(snapshot.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
    snapshot.guards,
    snapshot.error ?? null,
    snapshot.groups.map((group) => [
      group.id,
      group.processCount,
      Math.round(group.cpuPercent),
      Math.round(group.memoryRssBytes / RSS_SIGNATURE_BUCKET_BYTES),
      group.items.map(signatureOfProcess),
    ]),
  ]);
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function readRatioEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    return undefined;
  }
  return value;
}

function sanitizeCommand(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  const basename =
    firstToken.split(/[\\/]/).filter(Boolean).pop() ?? firstToken;
  return basename || 'process';
}

function getLogicalCpuCount(): number {
  const count = os.cpus().length;
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function clampCpuPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }
  return Math.min(100, percent);
}

function normalizeCpuPercent(percentOfSingleCore: number): number {
  return clampCpuPercent(percentOfSingleCore / getLogicalCpuCount());
}

function normalizeElectronCpuPercent(percent: number): number {
  if (percent > 100) {
    return normalizeCpuPercent(percent);
  }
  return clampCpuPercent(percent);
}

export function parseMacProcessTable(
  output: string,
): Map<number, ProcessTableRow> {
  const rows = new Map<number, ProcessTableRow>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s*(.*)$/.exec(
      trimmed,
    );
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const cpuPercent = Number(match[4]);
    const rssKib = Number(match[5]);
    if (
      !Number.isFinite(pid) ||
      !Number.isFinite(ppid) ||
      !Number.isFinite(pgid) ||
      !Number.isFinite(cpuPercent) ||
      !Number.isFinite(rssKib)
    ) {
      continue;
    }
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      cpuPercent: normalizeCpuPercent(cpuPercent),
      memoryRssBytes: rssKib * 1024,
      command: sanitizeCommand(match[6] ?? ''),
    });
  }
  return rows;
}

function readNumberField(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value[fieldName];
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStringField(value: unknown, fieldName: string): string {
  if (!isRecord(value)) {
    return '';
  }
  const raw = value[fieldName];
  return typeof raw === 'string' ? raw : '';
}

function parseWindowsProcessJson(output: string): unknown[] {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('Windows process table output was empty');
  }
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function computeWindowsCpuPercent(
  current: WindowsProcessCpuSample,
  previous: WindowsProcessCpuSample | undefined,
): number {
  if (!previous) {
    return 0;
  }
  const elapsedMs = current.sampledAtMs - previous.sampledAtMs;
  const cpuTimeDelta100ns = current.cpuTime100ns - previous.cpuTime100ns;
  if (elapsedMs <= 0 || cpuTimeDelta100ns <= 0) {
    return 0;
  }
  const cpuSeconds = cpuTimeDelta100ns / WINDOWS_CPU_TIME_UNITS_PER_SECOND;
  const elapsedSeconds = elapsedMs / 1_000;
  return clampCpuPercent(
    (cpuSeconds / elapsedSeconds / getLogicalCpuCount()) * 100,
  );
}

export function parseWindowsProcessTable(
  output: string,
  previousCpuSamples: Map<number, WindowsProcessCpuSample>,
  sampledAtMs: number,
): WindowsProcessTableParseResult {
  const rows = new Map<number, ProcessTableRow>();
  const cpuSamples = new Map<number, WindowsProcessCpuSample>();
  for (const entry of parseWindowsProcessJson(output)) {
    const pid = readNumberField(entry, 'ProcessId');
    const ppid = readNumberField(entry, 'ParentProcessId');
    const cpuTime100ns = readNumberField(entry, 'CpuTime100ns');
    const workingSetSize = readNumberField(entry, 'WorkingSetSize');
    if (
      pid === undefined ||
      ppid === undefined ||
      cpuTime100ns === undefined ||
      workingSetSize === undefined
    ) {
      continue;
    }
    const currentCpuSample = { cpuTime100ns, sampledAtMs };
    cpuSamples.set(pid, currentCpuSample);
    const name = readStringField(entry, 'Name');
    const commandLine = readStringField(entry, 'CommandLine');
    rows.set(pid, {
      pid,
      ppid,
      // Windows does not expose POSIX process groups. Treat the process itself
      // as the group anchor so registrations can still attach the root PID.
      pgid: pid,
      cpuPercent: computeWindowsCpuPercent(
        currentCpuSample,
        previousCpuSamples.get(pid),
      ),
      memoryRssBytes: Math.max(0, workingSetSize),
      command: sanitizeCommand(name || commandLine),
    });
  }
  return { rows, cpuSamples };
}

function buildChildrenByParent(
  rows: Map<number, ProcessTableRow>,
): Map<number, ProcessTableRow[]> {
  const children = new Map<number, ProcessTableRow[]>();
  for (const row of Array.from(rows.values())) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  return children;
}

function metricGroupId(metricType: string): ResourceGroupId {
  return metricType === 'Browser' ? 'app' : 'app';
}

function metricKind(metricType: string): ResourceProcessKind {
  if (metricType === 'Browser') {
    return 'electron-main';
  }
  if (metricType === 'GPU') {
    return 'electron-gpu';
  }
  if (metricType === 'Utility') {
    return 'electron-utility';
  }
  return 'electron-renderer';
}

function metricLabel(metricType: string): string {
  if (metricType === 'Browser') {
    return 'Electron main';
  }
  if (metricType === 'GPU') {
    return 'Electron GPU';
  }
  if (metricType === 'Utility') {
    return 'Electron utility';
  }
  return 'Electron renderer';
}

function isProcessMetric(value: unknown): value is ProcessMetric {
  if (!isRecord(value)) {
    return false;
  }
  const { pid, type, cpu, memory } = value;
  return (
    typeof pid === 'number' &&
    typeof type === 'string' &&
    isRecord(cpu) &&
    typeof cpu.percentCPUUsage === 'number' &&
    isRecord(memory) &&
    typeof memory.workingSetSize === 'number'
  );
}

function getElectronAppMetrics(): ProcessMetric[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronModule: unknown = require('electron');
    if (!isRecord(electronModule)) {
      return [];
    }
    const { app } = electronModule;
    if (!isElectronAppMetricsProvider(app)) {
      return [];
    }
    const metrics: unknown = app.getAppMetrics();
    return Array.isArray(metrics) ? metrics.filter(isProcessMetric) : [];
  } catch {
    return [];
  }
}

function appMetricToSnapshot(metric: ProcessMetric): ResourceProcessSnapshot {
  return {
    id: `electron:${metric.pid}`,
    kind: metricKind(metric.type),
    groupId: metricGroupId(metric.type),
    label: metricLabel(metric.type),
    pid: metric.pid,
    cpuPercent: normalizeElectronCpuPercent(metric.cpu.percentCPUUsage),
    memoryRssBytes: metric.memory.workingSetSize * 1024,
    processCount: 1,
    status: 'running',
  };
}

function processTableUnavailableError(
  appRows: Map<number, ResourceProcessSnapshot>,
): string | undefined {
  return appRows.size === 0 ? 'process-table sampling unavailable' : undefined;
}

function processRowClassification(row: ProcessTableRow): {
  groupId: ResourceGroupId;
  kind: ResourceProcessKind;
} {
  const command = row.command.toLowerCase().replace(/\.exe$/, '');
  if (command === 'codex') {
    return {
      groupId: 'codex',
      kind: 'chat-provider',
    };
  }
  if (command === 'claude') {
    return {
      groupId: 'claude',
      kind: 'chat-provider',
    };
  }
  return {
    groupId: 'other',
    kind: 'other',
  };
}

function recordRejectedOverrideWarning(reason: string): void {
  if (rejectedOverrideWarnings.has(reason)) {
    return;
  }
  rejectedOverrideWarnings.add(reason);
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'resource_monitor_config_warning',
    reason,
    memoryRssBytes: 0,
  });
}

function emptyGroup(id: ResourceGroupId): ResourceGroupSnapshotBuilder {
  return {
    id,
    label: GROUP_LABELS[id],
    cpuPercent: 0,
    memoryRssBytes: 0,
    processCount: 0,
    items: [],
  };
}

interface ResourceGroupSnapshotBuilder {
  id: ResourceGroupId;
  label: string;
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  items: ResourceProcessSnapshot[];
}

function shouldCountItemInGroup(item: ResourceProcessSnapshot): boolean {
  return !(item.groupId === 'pipelines' && item.kind === 'pipeline-execution');
}

function shouldShowItemInGroup(item: ResourceProcessSnapshot): boolean {
  return !(
    item.kind === 'codex-app-server-pool' && typeof item.pid !== 'number'
  );
}

function addToGroup(
  groups: Map<ResourceGroupId, ResourceGroupSnapshotBuilder>,
  item: ResourceProcessSnapshot,
): void {
  if (!shouldShowItemInGroup(item)) {
    return;
  }
  const group = groups.get(item.groupId) ?? emptyGroup(item.groupId);
  group.items.push(item);
  if (shouldCountItemInGroup(item)) {
    group.cpuPercent = clampCpuPercent(group.cpuPercent + item.cpuPercent);
    group.memoryRssBytes += item.memoryRssBytes;
    group.processCount += item.processCount;
  }
  groups.set(item.groupId, group);
}

function computeThresholds(): ResourceMonitorThresholds {
  const totalMemory = os.totalmem();
  const defaultWarningMemoryBytes = Math.min(
    2 * GIB,
    Math.floor(totalMemory * 0.5),
  );
  const defaultCriticalMemoryBytes = Math.min(
    4 * GIB,
    Math.floor(totalMemory * 0.7),
  );

  let warningMemoryBytes =
    getPerformanceLimits().memoryPressureWarningThresholdBytes;
  let criticalMemoryBytes =
    getPerformanceLimits().memoryPressureCriticalThresholdBytes;

  if (criticalMemoryBytes <= warningMemoryBytes) {
    warningMemoryBytes = Math.min(
      DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
      defaultWarningMemoryBytes,
    );
    criticalMemoryBytes = Math.min(
      DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
      defaultCriticalMemoryBytes,
    );
    recordRejectedOverrideWarning(
      'Invalid resource monitor memory threshold override',
    );
  }

  let warningFreeRatio =
    readRatioEnv('CANOPY_RESOURCE_WARNING_FREE_RATIO') ??
    DEFAULT_WARNING_FREE_RATIO;
  let criticalFreeRatio =
    readRatioEnv('CANOPY_RESOURCE_CRITICAL_FREE_RATIO') ??
    DEFAULT_CRITICAL_FREE_RATIO;
  if (criticalFreeRatio >= warningFreeRatio) {
    warningFreeRatio = DEFAULT_WARNING_FREE_RATIO;
    criticalFreeRatio = DEFAULT_CRITICAL_FREE_RATIO;
    recordRejectedOverrideWarning(
      'Invalid resource monitor free-memory ratio override',
    );
  }

  return {
    warningMemoryBytes,
    criticalMemoryBytes,
    warningFreeRatio,
    criticalFreeRatio,
  };
}

function buildThresholds(): ResourceMonitorThresholds {
  const version = getPerformanceLimitsVersion();
  if (cachedThresholds?.version !== version) {
    cachedThresholds = {
      version,
      thresholds: computeThresholds(),
    };
  }
  return cachedThresholds.thresholds;
}

function readMaxConcurrentChatTurns(): number | null {
  return getPerformanceLimits().maxActiveChatTurns;
}

function readMaxConcurrentPipelineExecutions(): number | null {
  return getPerformanceLimits().maxActivePipelineExecutions;
}

function isMemoryPressureGuardEnabled(): boolean {
  return getPerformanceLimits().memoryPressureGuardEnabled;
}

function isCanopyMemoryCritical(
  memoryRssBytes: number,
  criticalMemoryBytes: number,
): boolean {
  return memoryRssBytes >= criticalMemoryBytes;
}

function shouldBlockNewWorkForMemory(
  snapshot: ResourceMonitorSnapshot,
): boolean {
  if (!isMemoryPressureGuardEnabled()) {
    return false;
  }
  return isCanopyMemoryCritical(
    snapshot.memoryRssBytes,
    snapshot.pressure.criticalMemoryBytes,
  );
}

export class ResourceMonitorService {
  private readonly registrations = new Map<
    string,
    ResourceProcessRegistration
  >();
  private readonly activeOperations = new Map<
    string,
    ActiveManagedProcessOperation
  >();
  private timer: NodeJS.Timeout | null = null;
  private getWindow: (() => ResourceMonitorWindow | null) | null = null;
  private sampling = false;
  private snapshot: ResourceMonitorSnapshot = this.createEmptySnapshot();
  private windowsCpuSamples = new Map<number, WindowsProcessCpuSample>();
  private lastPersistedPressureLevel: ResourcePressureLevel = 'ok';
  private lastCodexPoolSuspendAttemptAtMs = 0;
  private monitoringActive = false;
  private lastBroadcastSignature: string | null = null;
  private lastBroadcastAtMs = 0;
  private pendingChatTurnStartCount = 0;
  private pendingPipelineExecutionStartCount = 0;

  start(getWindow: () => ResourceMonitorWindow | null): void {
    this.getWindow = getWindow;
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (this.timer !== null || this.monitoringActive) {
      return;
    }
    this.monitoringActive = true;
    const baseInterval =
      readPositiveIntegerEnv('CANOPY_RESOURCE_MONITOR_INTERVAL_MS') ??
      DEFAULT_SAMPLE_INTERVAL_MS;
    const scheduleNext = (): void => {
      if (!this.monitoringActive) {
        return;
      }
      // Focused window → base cadence; unfocused/hidden/destroyed window →
      // slowed cadence. Delay is re-evaluated every tick, so refocusing
      // recovers the fast cadence within one slow interval.
      const delay = Math.min(
        this.isWindowFocused()
          ? baseInterval
          : baseInterval * UNFOCUSED_SAMPLE_INTERVAL_MULTIPLIER,
        MAX_TIMEOUT_DELAY_MS,
      );
      this.timer = setTimeout((): void => {
        this.timer = null;
        void this.sampleNow()
          .catch(() => {})
          .finally((): void => {
            scheduleNext();
          });
      }, delay);
      this.timer.unref?.();
    };
    void this.sampleNow()
      .catch(() => {})
      .finally((): void => {
        scheduleNext();
      });
  }

  private isWindowFocused(): boolean {
    const window = this.getWindow?.() ?? null;
    if (
      !window ||
      typeof window.isDestroyed !== 'function' ||
      window.isDestroyed() ||
      typeof window.isFocused !== 'function'
    ) {
      return false;
    }
    return window.isFocused();
  }

  dispose(): void {
    this.monitoringActive = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.getWindow = null;
    this.lastBroadcastSignature = null;
    this.lastBroadcastAtMs = 0;
    this.activeOperations.forEach(
      (operation: ActiveManagedProcessOperation, id: string) => {
        const current =
          this.registrations.get(id) ?? operation.initialRegistration;
        const durationMs = Math.max(0, Date.now() - operation.registeredAtMs);
        safelyEmitManagedProcessTelemetry(() => {
          failDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, 'abandoned', {
            operationKey: operation.operationKey,
            context: buildManagedProcessTelemetryContext(
              current,
              operation.registrationType,
              'abandoned',
              durationMs,
            ),
          });
        });
      },
    );
    this.activeOperations.clear();
    this.registrations.clear();
    this.windowsCpuSamples.clear();
    this.pendingChatTurnStartCount = 0;
    this.pendingPipelineExecutionStartCount = 0;
  }

  getSnapshot(): ResourceMonitorSnapshot {
    return this.snapshot;
  }

  registerProcess(
    registration: ResourceProcessRegistration,
  ): ResourceRegistrationHandle {
    return this.register(registration, 'process');
  }

  registerWorkItem(
    registration: ResourceProcessRegistration,
  ): ResourceRegistrationHandle {
    return this.register(registration, 'work_item');
  }

  async assertCanStartChatTurn(): Promise<void> {
    const reservation = await this.reserveChatTurnStart();
    reservation.release();
  }

  async reserveChatTurnStart(): Promise<ResourceGuardReservation> {
    const chatTurns = await this.readChatTurnConcurrencySnapshot();
    const snapshot = this.getSnapshot();
    const maxConcurrentTurns = readMaxConcurrentChatTurns();
    const activeOrQueuedTurns =
      chatTurns.activeTurns +
      chatTurns.pendingMessages +
      this.pendingChatTurnStartCount;
    if (
      maxConcurrentTurns !== null &&
      activeOrQueuedTurns >= maxConcurrentTurns
    ) {
      this.recordGuardBlocked('resource_guard_blocked_chat');
      throw new ResourceGuardError(
        `${BRAND.displayName} is already running ${String(maxConcurrentTurns)} chat turns. Wait for one to finish before starting another.`,
      );
    }
    if (shouldBlockNewWorkForMemory(snapshot)) {
      this.recordGuardBlocked('resource_guard_blocked_chat');
      throw new ResourceGuardError(
        `${BRAND.displayName} is under high memory pressure. Wait for active work to finish before starting another chat.`,
      );
    }
    this.pendingChatTurnStartCount += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.pendingChatTurnStartCount = Math.max(
          0,
          this.pendingChatTurnStartCount - 1,
        );
      },
    };
  }

  assertCanStartPipelineExecution(): void {
    const reservation = this.reservePipelineExecutionStart();
    reservation.release();
  }

  reservePipelineExecutionStart(): ResourceGuardReservation {
    const snapshot = this.getSnapshot();
    const maxConcurrentExecutions = readMaxConcurrentPipelineExecutions();
    const activeOrPendingExecutions =
      this.readActivePipelineExecutionCount() +
      this.pendingPipelineExecutionStartCount;
    if (
      maxConcurrentExecutions !== null &&
      activeOrPendingExecutions >= maxConcurrentExecutions
    ) {
      this.recordGuardBlocked('resource_guard_blocked_pipeline');
      throw new ResourceGuardError(
        `${BRAND.displayName} is already running ${String(maxConcurrentExecutions)} pipeline executions. Wait for one to finish before starting another pipeline.`,
      );
    }
    if (shouldBlockNewWorkForMemory(snapshot)) {
      this.recordGuardBlocked('resource_guard_blocked_pipeline');
      throw new ResourceGuardError(
        `${BRAND.displayName} is under high memory pressure. Stop an active chat or pipeline execution before starting another pipeline.`,
      );
    }
    this.pendingPipelineExecutionStartCount += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.pendingPipelineExecutionStartCount = Math.max(
          0,
          this.pendingPipelineExecutionStartCount - 1,
        );
      },
    };
  }

  async sampleNow(): Promise<ResourceMonitorSnapshot> {
    if (this.sampling) {
      return this.snapshot;
    }
    this.sampling = true;
    try {
      const samplingData = await this.collectSamplingData();
      const snapshot = await this.buildSnapshot(samplingData);
      this.snapshot = snapshot;
      this.broadcast(snapshot);
      await this.handlePressureTransition(snapshot);
      return snapshot;
    } finally {
      this.sampling = false;
    }
  }

  private register(
    registration: ResourceProcessRegistration,
    registrationType: ResourceRegistrationType,
  ): ResourceRegistrationHandle {
    const registeredAtMs = Date.now();
    const operationKey = createDesktopInstrumentationOperationKey(
      `managed-process:${registration.id}:${registeredAtMs}`,
    );
    const initialRegistration = {
      ...registration,
      // Default startedAt to registration time so snapshot consumers always see
      // a value, matching the telemetry duration anchor.
      startedAt:
        registration.startedAt ?? new Date(registeredAtMs).toISOString(),
    };
    this.registrations.set(registration.id, initialRegistration);
    this.activeOperations.set(registration.id, {
      operationKey,
      registrationType,
      registeredAtMs,
      initialRegistration,
    });
    safelyEmitManagedProcessTelemetry(() => {
      startDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, {
        operationKey,
        context: buildManagedProcessTelemetryContext(
          initialRegistration,
          registrationType,
          'started',
        ),
      });
    });
    return {
      update: (update): void => {
        if (!this.activeOperations.has(registration.id)) {
          return;
        }
        const current = this.registrations.get(registration.id);
        if (!current) {
          return;
        }
        this.registrations.set(registration.id, {
          ...current,
          ...update,
          id: current.id,
        });
      },
      unregister: (): void => {
        const operation = this.activeOperations.get(registration.id);
        if (!operation) {
          return;
        }
        const current =
          this.registrations.get(registration.id) ??
          operation.initialRegistration;
        const durationMs = Math.max(0, Date.now() - operation.registeredAtMs);
        safelyEmitManagedProcessTelemetry(() => {
          succeedDesktopOperation(MANAGED_PROCESS_OPERATION_NAME, {
            operationKey: operation.operationKey,
            context: buildManagedProcessTelemetryContext(
              current,
              operation.registrationType,
              'completed',
              durationMs,
            ),
          });
        });
        this.activeOperations.delete(registration.id);
        this.registrations.delete(registration.id);
      },
    };
  }

  private createEmptySnapshot(): ResourceMonitorSnapshot {
    const thresholds = buildThresholds();
    const maxConcurrentTurns = readMaxConcurrentChatTurns();
    const maxConcurrentExecutions = readMaxConcurrentPipelineExecutions();
    return {
      version: 1,
      sampledAt: new Date().toISOString(),
      appPid: process.pid,
      cpuPercent: 0,
      memoryRssBytes: 0,
      processCount: 0,
      pressure: {
        level: 'unknown',
        reasons: ['resource monitor has not sampled yet'],
        warningMemoryBytes: thresholds.warningMemoryBytes,
        criticalMemoryBytes: thresholds.criticalMemoryBytes,
      },
      groups: [],
      guards: {
        chatTurns: {
          activeTurns: 0,
          pendingMessages: 0,
          maxConcurrentTurns,
          blocked: false,
        },
        pipelines: {
          activeExecutions: 0,
          maxConcurrentExecutions,
          blocked: false,
        },
        codexPools: {
          activeConnections: 0,
          liveProcesses: 0,
          activeTurns: 0,
        },
      },
    };
  }

  private async collectSamplingData(): Promise<SamplingData> {
    const appRows = new Map<number, ResourceProcessSnapshot>();
    for (const metric of getElectronAppMetrics()) {
      appRows.set(metric.pid, appMetricToSnapshot(metric));
    }

    if (process.platform === 'win32') {
      try {
        const stdout = await readWindowsProcessTable();
        const { rows: processRows, cpuSamples } = parseWindowsProcessTable(
          stdout,
          this.windowsCpuSamples,
          Date.now(),
        );
        this.windowsCpuSamples = cpuSamples;
        return {
          processRows,
          appRows,
          childrenByParent: buildChildrenByParent(processRows),
          processTableAvailable: true,
        };
      } catch {
        return {
          processRows: new Map<number, ProcessTableRow>(),
          appRows,
          childrenByParent: new Map<number, ProcessTableRow[]>(),
          processTableAvailable: false,
          error: processTableUnavailableError(appRows),
        };
      }
    }

    if (process.platform !== 'darwin') {
      return {
        processRows: new Map<number, ProcessTableRow>(),
        appRows,
        childrenByParent: new Map<number, ProcessTableRow[]>(),
        processTableAvailable: false,
        error: processTableUnavailableError(appRows),
      };
    }

    try {
      const stdout = await readMacProcessTable();
      const processRows = parseMacProcessTable(stdout);
      return {
        processRows,
        appRows,
        childrenByParent: buildChildrenByParent(processRows),
        processTableAvailable: true,
      };
    } catch {
      return {
        processRows: new Map<number, ProcessTableRow>(),
        appRows,
        childrenByParent: new Map<number, ProcessTableRow[]>(),
        processTableAvailable: false,
        error: processTableUnavailableError(appRows),
      };
    }
  }

  private async buildSnapshot(
    samplingData: SamplingData,
  ): Promise<ResourceMonitorSnapshot> {
    const groups = new Map<ResourceGroupId, ResourceGroupSnapshotBuilder>();
    const claimedPids = new Set<number>();
    const pipelineSteps: ResourceProcessSnapshot[] = [];
    const pipelineExecutions: ResourceProcessSnapshot[] = [];

    const registeredPids = new Set<number>();
    for (const registration of Array.from(this.registrations.values())) {
      if (typeof registration.pid === 'number') {
        registeredPids.add(registration.pid);
      }
    }

    for (const appRow of Array.from(samplingData.appRows.values())) {
      if (typeof appRow.pid === 'number') {
        claimedPids.add(appRow.pid);
      }
      if (typeof appRow.pid === 'number' && registeredPids.has(appRow.pid)) {
        continue;
      }
      addToGroup(groups, appRow);
    }

    for (const registration of Array.from(this.registrations.values())) {
      const item = this.buildRegistrationSnapshot(registration, samplingData);
      if (typeof registration.pid === 'number') {
        claimedPids.add(registration.pid);
        for (const child of item.children ?? []) {
          if (typeof child.pid === 'number') {
            claimedPids.add(child.pid);
          }
        }
      }
      if (item.kind === 'pipeline-step') {
        pipelineSteps.push(item);
        continue;
      }
      if (item.kind === 'pipeline-execution') {
        pipelineExecutions.push(item);
        continue;
      }
      addToGroup(groups, item);
    }

    const pipelineExecutionItems = this.buildPipelineRollups(
      pipelineExecutions,
      pipelineSteps,
    );
    const rolledUpStepIds = new Set<string>();
    for (const execution of pipelineExecutionItems) {
      for (const child of execution.children ?? []) {
        rolledUpStepIds.add(child.id);
      }
      addToGroup(groups, execution);
    }
    for (const step of pipelineSteps) {
      if (!rolledUpStepIds.has(step.id)) {
        addToGroup(groups, step);
      } else {
        const group = groups.get('pipelines') ?? emptyGroup('pipelines');
        group.cpuPercent = clampCpuPercent(group.cpuPercent + step.cpuPercent);
        group.memoryRssBytes += step.memoryRssBytes;
        group.processCount += step.processCount;
        groups.set('pipelines', group);
      }
    }

    if (samplingData.processTableAvailable) {
      for (const row of this.findUnregisteredDescendants(
        process.pid,
        samplingData,
        claimedPids,
      )) {
        const classification = processRowClassification(row);
        addToGroup(groups, {
          id: `${classification.groupId}:${row.pid}`,
          kind: classification.kind,
          groupId: classification.groupId,
          label: row.command,
          pid: row.pid,
          ppid: row.ppid,
          processGroupId: row.pgid,
          cpuPercent: row.cpuPercent,
          memoryRssBytes: row.memoryRssBytes,
          processCount: 1,
          status: 'running',
          metadata: { type: 'generic' },
        });
      }
    }

    const groupSnapshots = Array.from(groups.values()).map((group) => ({
      id: group.id,
      label: group.label,
      cpuPercent: clampCpuPercent(group.cpuPercent),
      memoryRssBytes: group.memoryRssBytes,
      processCount: group.processCount,
      items: group.items,
    }));
    const cpuPercent = clampCpuPercent(
      groupSnapshots.reduce((total, group) => total + group.cpuPercent, 0),
    );
    const memoryRssBytes = groupSnapshots.reduce(
      (total, group) => total + group.memoryRssBytes,
      0,
    );
    const processCount = groupSnapshots.reduce(
      (total, group) => total + group.processCount,
      0,
    );
    const pressure = this.computePressure(
      memoryRssBytes,
      samplingData.processTableAvailable,
    );
    const chatTurns = await this.readChatTurnConcurrencySnapshot();
    const maxConcurrentTurns = readMaxConcurrentChatTurns();
    const maxConcurrentPipelineExecutions =
      readMaxConcurrentPipelineExecutions();
    const codexPoolSummary = await this.readCodexPoolSummary();
    const activePipelineExecutionCount =
      this.readActivePipelineExecutionCount();
    const memoryGuardBlocked =
      isMemoryPressureGuardEnabled() &&
      isCanopyMemoryCritical(memoryRssBytes, pressure.criticalMemoryBytes);

    return {
      version: 1,
      sampledAt: new Date().toISOString(),
      appPid: process.pid,
      cpuPercent,
      memoryRssBytes,
      processCount,
      pressure,
      groups: groupSnapshots,
      guards: {
        chatTurns: {
          activeTurns: chatTurns.activeTurns,
          pendingMessages: chatTurns.pendingMessages,
          maxConcurrentTurns,
          blocked:
            (maxConcurrentTurns !== null &&
              chatTurns.activeTurns +
                chatTurns.pendingMessages +
                this.pendingChatTurnStartCount >=
                maxConcurrentTurns) ||
            memoryGuardBlocked,
        },
        pipelines: {
          activeExecutions: activePipelineExecutionCount,
          maxConcurrentExecutions: maxConcurrentPipelineExecutions,
          blocked:
            (maxConcurrentPipelineExecutions !== null &&
              activePipelineExecutionCount +
                this.pendingPipelineExecutionStartCount >=
                maxConcurrentPipelineExecutions) ||
            memoryGuardBlocked,
        },
        codexPools: codexPoolSummary,
      },
      ...(samplingData.error ? { error: samplingData.error } : {}),
    };
  }

  private buildRegistrationSnapshot(
    registration: ResourceProcessRegistration,
    samplingData: SamplingData,
  ): ResourceProcessSnapshot {
    if (typeof registration.pid !== 'number') {
      return {
        id: registration.id,
        kind: registration.kind,
        groupId: registration.groupId,
        label: registration.label,
        cpuPercent: 0,
        memoryRssBytes: 0,
        processCount: 0,
        startedAt: registration.startedAt,
        status: 'idle',
        metadata: registration.metadata,
      };
    }

    const aggregated = this.aggregatePid(
      registration.pid,
      samplingData,
      registration.processGroupId,
    );
    return {
      id: registration.id,
      kind: registration.kind,
      groupId: registration.groupId,
      label: registration.label,
      pid: registration.pid,
      processGroupId: registration.processGroupId,
      ppid: aggregated.ppid,
      cpuPercent: aggregated.cpuPercent,
      memoryRssBytes: aggregated.memoryRssBytes,
      processCount: aggregated.processCount,
      startedAt: registration.startedAt,
      status: aggregated.processCount > 0 ? 'running' : 'unknown',
      metadata: registration.metadata,
      ...(aggregated.children.length > 0
        ? { children: aggregated.children }
        : {}),
    };
  }

  private aggregatePid(
    pid: number,
    samplingData: SamplingData,
    processGroupId?: number,
  ): AggregatedProcess {
    const rootAppRow = samplingData.appRows.get(pid);
    const rootPsRow = samplingData.processRows.get(pid);
    let cpuPercent = rootAppRow?.cpuPercent ?? rootPsRow?.cpuPercent ?? 0;
    let memoryRssBytes =
      rootAppRow?.memoryRssBytes ?? rootPsRow?.memoryRssBytes ?? 0;
    let processCount = rootAppRow || rootPsRow ? 1 : 0;
    const children: ResourceProcessSnapshot[] = [];
    const visited = new Set<number>([pid]);

    const addRow = (row: ProcessTableRow): void => {
      if (visited.has(row.pid)) {
        return;
      }
      visited.add(row.pid);
      const appRow = samplingData.appRows.get(row.pid);
      const childCpu = appRow?.cpuPercent ?? row.cpuPercent;
      const childMemory = appRow?.memoryRssBytes ?? row.memoryRssBytes;
      const classification = processRowClassification(row);
      cpuPercent += childCpu;
      memoryRssBytes += childMemory;
      processCount += 1;
      children.push({
        id: `process:${row.pid}`,
        kind: classification.kind,
        groupId: classification.groupId,
        label: appRow?.label ?? row.command,
        pid: row.pid,
        ppid: row.ppid,
        processGroupId: row.pgid,
        cpuPercent: childCpu,
        memoryRssBytes: childMemory,
        processCount: 1,
        status: 'running',
        metadata: { type: 'generic' },
      });
      walk(row.pid);
    };

    const walk = (parentPid: number): void => {
      for (const row of samplingData.childrenByParent.get(parentPid) ?? []) {
        addRow(row);
      }
    };
    walk(pid);

    if (typeof processGroupId === 'number') {
      samplingData.processRows.forEach((row) => {
        if (row.pgid === processGroupId && row.pid !== pid) {
          addRow(row);
        }
      });
    }

    return {
      cpuPercent: clampCpuPercent(cpuPercent),
      memoryRssBytes,
      processCount,
      children,
      ppid: rootPsRow?.ppid,
    };
  }

  private buildPipelineRollups(
    executions: ResourceProcessSnapshot[],
    steps: ResourceProcessSnapshot[],
  ): ResourceProcessSnapshot[] {
    return executions.map((execution) => {
      const executionId =
        execution.metadata?.type === 'pipeline'
          ? execution.metadata.pipeline.executionId
          : undefined;
      const children = steps.filter(
        (step) =>
          step.metadata?.type === 'pipeline' &&
          step.metadata.pipeline.executionId === executionId,
      );
      if (children.length === 0) {
        return {
          ...execution,
          cpuPercent: 0,
          memoryRssBytes: 0,
          processCount: 0,
          status: 'idle',
        };
      }
      return {
        ...execution,
        cpuPercent: clampCpuPercent(
          children.reduce((total, item) => total + item.cpuPercent, 0),
        ),
        memoryRssBytes: children.reduce(
          (total, item) => total + item.memoryRssBytes,
          0,
        ),
        processCount: children.reduce(
          (total, item) => total + item.processCount,
          0,
        ),
        status: 'running',
        children,
      };
    });
  }

  private findUnregisteredDescendants(
    rootPid: number,
    samplingData: SamplingData,
    claimedPids: Set<number>,
  ): ProcessTableRow[] {
    const rows: ProcessTableRow[] = [];
    const visited = new Set<number>([rootPid]);
    const walk = (parentPid: number): void => {
      for (const row of samplingData.childrenByParent.get(parentPid) ?? []) {
        if (visited.has(row.pid)) {
          continue;
        }
        visited.add(row.pid);
        if (!claimedPids.has(row.pid)) {
          rows.push(row);
        }
        walk(row.pid);
      }
    };
    walk(rootPid);
    return rows;
  }

  private computePressure(
    memoryRssBytes: number,
    processTableAvailable: boolean,
  ): ResourceMonitorSnapshot['pressure'] {
    const thresholds = buildThresholds();
    if (!processTableAvailable) {
      return {
        level: 'unknown',
        reasons: ['process-table sampling unavailable'],
        warningMemoryBytes: thresholds.warningMemoryBytes,
        criticalMemoryBytes: thresholds.criticalMemoryBytes,
      };
    }
    const reasons: string[] = [];
    let level: ResourcePressureLevel = 'ok';
    const canopyCritical = isCanopyMemoryCritical(
      memoryRssBytes,
      thresholds.criticalMemoryBytes,
    );
    const canopyWarning = memoryRssBytes >= thresholds.warningMemoryBytes;
    if (canopyCritical) {
      level = 'critical';
      reasons.push(`${BRAND.displayName} memory usage critical`);
    } else if (canopyWarning) {
      level = 'warning';
      reasons.push(`${BRAND.displayName} memory usage elevated`);
    }
    return {
      level,
      reasons,
      warningMemoryBytes: thresholds.warningMemoryBytes,
      criticalMemoryBytes: thresholds.criticalMemoryBytes,
    };
  }

  private async readCodexPoolSummary(): Promise<{
    activeConnections: number;
    liveProcesses: number;
    activeTurns: number;
  }> {
    let snapshots: CodexPoolResourceSnapshotSummary[] = [];
    try {
      const { getCodexRuntimeService } =
        await import('../codex/runtime-service');
      snapshots = getCodexRuntimeService()
        .admin()
        .getResourceSnapshots()
        .filter(isCodexPoolResourceSnapshotSummary);
    } catch {
      snapshots = [];
    }
    return {
      activeConnections: snapshots.reduce(
        (total, snapshot) => total + snapshot.clientCount,
        0,
      ),
      liveProcesses: snapshots.filter(
        (snapshot) => typeof snapshot.pid === 'number',
      ).length,
      activeTurns: snapshots.reduce(
        (total, snapshot) => total + snapshot.activeTurnCount,
        0,
      ),
    };
  }

  private async readChatTurnConcurrencySnapshot(): Promise<ChatTurnConcurrencySnapshot> {
    try {
      const sessionManager = await import('../agents/session-manager');
      if (typeof sessionManager.getChatTurnConcurrencySnapshot === 'function') {
        return sessionManager.getChatTurnConcurrencySnapshot();
      }
    } catch {
      // Test mocks and early shutdown paths may omit session-manager helpers.
    }
    return { activeTurns: 0, pendingMessages: 0 };
  }

  private readActivePipelineExecutionCount(): number {
    return getActivePipelineExecutionCount();
  }

  private broadcast(snapshot: ResourceMonitorSnapshot): void {
    const window = this.getWindow?.() ?? null;
    if (
      !window ||
      typeof window.isDestroyed !== 'function' ||
      window.isDestroyed() ||
      typeof window.webContents.isDestroyed !== 'function' ||
      window.webContents.isDestroyed() ||
      typeof window.webContents.send !== 'function'
    ) {
      return;
    }
    // Skip renderer wakeups while the snapshot is materially unchanged (a
    // quiet system produces identical signatures sample after sample), with a
    // bounded staleness window so freshness displays keep moving.
    const signature = buildBroadcastSignature(snapshot);
    const now = Date.now();
    if (
      signature === this.lastBroadcastSignature &&
      now - this.lastBroadcastAtMs < MAX_BROADCAST_SILENCE_MS
    ) {
      return;
    }
    this.lastBroadcastSignature = signature;
    this.lastBroadcastAtMs = now;
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.resourceMonitorSnapshot,
      snapshot,
    );
  }

  private async handlePressureTransition(
    snapshot: ResourceMonitorSnapshot,
  ): Promise<void> {
    const previous = this.lastPersistedPressureLevel;
    const current = snapshot.pressure.level;
    this.lastPersistedPressureLevel = current;
    // Reclaim idle Codex app-server processes whenever pressure is critical
    // and the dedicated timeout-bypass preference is enabled. Sustained
    // critical pressure is included, but throttled so a stuck-critical system
    // does not sweep the pool on every 2s sample. This remains independent of
    // `isMemoryPressureGuardEnabled()`, which gates blocking new work.
    let suspendedCodexPoolCount = 0;
    if (
      current === 'critical' &&
      getPerformanceLimits()
        .bypassCodexAppServerIdleTimeoutUnderCriticalPressure &&
      Date.now() - this.lastCodexPoolSuspendAttemptAtMs >=
        CODEX_POOL_SUSPEND_ATTEMPT_MIN_INTERVAL_MS
    ) {
      this.lastCodexPoolSuspendAttemptAtMs = Date.now();
      try {
        const { getCodexRuntimeService } =
          await import('../codex/runtime-service');
        suspendedCodexPoolCount = getCodexRuntimeService()
          .admin()
          .suspendIdleWorkersForMemoryPressure();
      } catch {
        suspendedCodexPoolCount = 0;
      }
    }
    if (PRESSURE_RANK[current] <= PRESSURE_RANK[previous]) {
      return;
    }
    if (current === 'warning') {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: snapshot.sampledAt,
        kind: 'resource_pressure_warning',
        memoryRssBytes: snapshot.memoryRssBytes,
        cpuPercent: snapshot.cpuPercent,
        pressureLevel: snapshot.pressure.level,
        processCount: snapshot.processCount,
      });
      return;
    }
    if (current === 'critical') {
      const memory = process.memoryUsage();
      const heap = getHeapStatistics();
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: snapshot.sampledAt,
        kind: 'resource_pressure_critical',
        mainHeapUsedBytes: memory.heapUsed,
        mainHeapTotalBytes: memory.heapTotal,
        mainHeapLimitBytes: heap.heap_size_limit,
        mainRssBytes: memory.rss,
        mainExternalBytes: memory.external,
        mainArrayBufferBytes: memory.arrayBuffers,
        memoryRssBytes: snapshot.memoryRssBytes,
        cpuPercent: snapshot.cpuPercent,
        pressureLevel: snapshot.pressure.level,
        processCount: snapshot.processCount,
        suspendedCodexPoolCount,
      });
    }
  }

  private recordGuardBlocked(
    kind: 'resource_guard_blocked_chat' | 'resource_guard_blocked_pipeline',
  ): void {
    const snapshot = this.getSnapshot();
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind,
      memoryRssBytes: snapshot.memoryRssBytes,
      cpuPercent: snapshot.cpuPercent,
      pressureLevel: snapshot.pressure.level,
      processCount: snapshot.processCount,
      activeChatTurnCount: snapshot.guards.chatTurns.activeTurns,
      activePipelineExecutionCount: snapshot.guards.pipelines.activeExecutions,
    });
  }
}
