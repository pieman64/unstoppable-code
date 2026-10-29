/** Portable, human-reviewed terminal actions. Commands must never enter agent inventories. */
export const SCRIPT_ACTION_SOURCE_KINDS = [
  'canopy',
  'local',
  'package-json',
  'makefile',
  'justfile',
  'taskfile',
  'deno',
  'composer',
  'pyproject',
  'cargo',
  'go',
  'shell-script',
  'shell-alias',
] as const;
export type ScriptActionSourceKind =
  (typeof SCRIPT_ACTION_SOURCE_KINDS)[number];
export type ScriptActionStatus = 'approved' | 'pending' | 'dismissed';
export type ScriptActionTarget =
  | { kind: 'repository'; repoId: string }
  | { kind: 'workspace-root' }
  | { kind: 'selected-repository' };
export interface ScriptAction {
  id: string;
  kind: 'tracked' | 'detected' | 'alias';
  name: string;
  command: string;
  multiline: boolean;
  repoId: string | null;
  repoName: string | null;
  packagePath: string | null;
  target: ScriptActionTarget;
  source: {
    kind: ScriptActionSourceKind;
    file: string;
    entry: string;
    line: number | null;
  };
  revision: string;
  status: ScriptActionStatus;
  shortcut: string | null;
  pinned: boolean;
  /** Stored preferences remain visible during review, but cannot execute. */
  unavailableReason?: string;
  shortcutConflict?: string;
}
export interface ScriptActionDiagnostic {
  source: string;
  code:
    | 'unreadable'
    | 'malformed'
    | 'truncated'
    | 'unsupported'
    | 'outside-root';
  message: string;
}
export interface ScriptActionsSnapshot {
  actions: ScriptAction[];
  pendingCount: number;
  shellAliasScanEnabled: boolean;
  scanStatus: 'idle' | 'scanning' | 'complete' | 'incomplete' | 'failed';
  scannedAt: string | null;
  diagnostics: ScriptActionDiagnostic[];
  /** Validation belongs to the executing host, including its current focus chord. */
  shortcutContext?: {
    platform: 'darwin' | 'win32' | 'linux';
    reserved: { accelerator: string; title: string }[];
  };
}
export interface ScriptActionsContext {
  projectId: string;
  worktreeId: string;
}
export interface ScriptActionsListRequest extends ScriptActionsContext {
  includeDismissed?: boolean;
}
export interface ScriptActionsReviewRequest extends ScriptActionsContext {
  entries: { id: string; revision: string }[];
  decision: 'approve' | 'dismiss' | 'reset';
}
export const SCRIPT_ACTIONS_REVIEW_BATCH_LIMIT = 2000;
export interface ScriptActionsShortcutRequest extends ScriptActionsContext {
  id: string;
  accelerator: string | null;
}
export interface ScriptActionsPinRequest extends ScriptActionsContext {
  id: string;
  pinned: boolean;
}
export interface ScriptActionsAddMetadata {
  scriptActionsOperationId?: string;
}
export interface ScriptActionsReceiptRequest {
  projectId: string;
  worktreeId?: string;
  operationId: string;
}
export interface ScriptActionsAddReceipt {
  projectId: string;
  /** Null when repositories were added before the first worktree exists. */
  worktreeId: string | null;
  operationId: string;
  repoIds: string[];
  status: 'scanning' | 'complete' | 'failed';
  pendingCount: number;
  completedAt: string | null;
}
export const SCRIPT_ACTIONS_ERROR_CODES = [
  'invalid_payload',
  'invalid_target',
  'not_found',
  'stale_revision',
  'approval_required',
  'shortcut_conflict',
  'storage_error',
  'mixed_stores',
  'unsupported',
] as const;
export type ScriptActionsErrorCode =
  (typeof SCRIPT_ACTIONS_ERROR_CODES)[number];
export function isScriptActionsErrorCode(
  value: unknown,
): value is ScriptActionsErrorCode {
  return SCRIPT_ACTIONS_ERROR_CODES.some((code) => code === value);
}
export type ScriptActionsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ScriptActionsErrorCode; message: string } };
export interface ScriptActionsClient {
  list(request: ScriptActionsListRequest): Promise<ScriptActionsSnapshot>;
  rescan(request: ScriptActionsContext): Promise<ScriptActionsSnapshot>;
  review(request: ScriptActionsReviewRequest): Promise<ScriptActionsSnapshot>;
  setShortcut(
    request: ScriptActionsShortcutRequest,
  ): Promise<ScriptActionsSnapshot>;
  setPinned(request: ScriptActionsPinRequest): Promise<ScriptActionsSnapshot>;
  enableShellAliasScan(
    request: ScriptActionsContext,
  ): Promise<ScriptActionsSnapshot>;
  receipt(
    request: ScriptActionsReceiptRequest,
  ): Promise<ScriptActionsAddReceipt | null>;
}
export const SCRIPT_ACTIONS_CHANNELS = {
  list: 'script-actions:list',
  rescan: 'script-actions:rescan',
  review: 'script-actions:review',
  setShortcut: 'script-actions:set-shortcut',
  setPinned: 'script-actions:set-pinned',
  enableShellAliasScan: 'script-actions:enable-shell-alias-scan',
  receipt: 'script-actions:receipt',
  changed: 'script-actions:changed',
  found: 'script-actions:found',
} as const;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedString(value: unknown, max = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes('\0')
  );
}
export function isScriptActionsContext(
  value: unknown,
): value is ScriptActionsContext {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(value.projectId) &&
    typeof value.worktreeId === 'string' &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(value.worktreeId)
  );
}
export function isScriptActionsListRequest(
  value: unknown,
): value is ScriptActionsListRequest {
  return (
    isScriptActionsContext(value) &&
    isRecord(value) &&
    (value.includeDismissed === undefined ||
      typeof value.includeDismissed === 'boolean')
  );
}
function isReviewEntry(
  value: unknown,
): value is { id: string; revision: string } {
  return (
    isRecord(value) &&
    boundedString(value.id) &&
    boundedString(value.revision, 256)
  );
}
export function isScriptActionsReviewRequest(
  value: unknown,
): value is ScriptActionsReviewRequest {
  return (
    isScriptActionsContext(value) &&
    isRecord(value) &&
    ['approve', 'dismiss', 'reset'].includes(String(value.decision)) &&
    Array.isArray(value.entries) &&
    value.entries.length > 0 &&
    value.entries.length <= SCRIPT_ACTIONS_REVIEW_BATCH_LIMIT &&
    value.entries.every(isReviewEntry) &&
    new Set(value.entries.map((entry) => entry.id)).size ===
      value.entries.length
  );
}
export function isScriptActionsShortcutRequest(
  value: unknown,
): value is ScriptActionsShortcutRequest {
  return (
    isScriptActionsContext(value) &&
    isRecord(value) &&
    boundedString(value.id) &&
    (value.accelerator === null || boundedString(value.accelerator, 100))
  );
}
export function isScriptActionsPinRequest(
  value: unknown,
): value is ScriptActionsPinRequest {
  return (
    isScriptActionsContext(value) &&
    isRecord(value) &&
    boundedString(value.id) &&
    typeof value.pinned === 'boolean'
  );
}
export function isScriptActionsReceiptRequest(
  value: unknown,
): value is ScriptActionsReceiptRequest {
  return (
    isRecord(value) &&
    (value.worktreeId === undefined || typeof value.worktreeId === 'string') &&
    isScriptActionsContext({
      projectId: value.projectId,
      worktreeId: value.worktreeId ?? 'workspace',
    }) &&
    boundedString(value.operationId, 200)
  );
}
/** Strict POSIX path syntax shared by request guards and execution containment. */
export function isScriptActionRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !/[\\\0:]/.test(value) &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}
export function isScriptAction(value: unknown): value is ScriptAction {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.target))
    return false;
  const target = value.target;
  const source = value.source;
  return (
    boundedString(value.id) &&
    ['tracked', 'detected', 'alias'].includes(String(value.kind)) &&
    boundedString(value.name) &&
    boundedString(value.command, 1024 * 1024) &&
    typeof value.multiline === 'boolean' &&
    value.multiline === /[\r\n]/.test(value.command) &&
    (value.repoId === null || boundedString(value.repoId, 200)) &&
    (value.repoName === null || boundedString(value.repoName)) &&
    (value.packagePath === null ||
      isScriptActionRelativePath(value.packagePath)) &&
    (target.kind === 'workspace-root' ||
      target.kind === 'selected-repository' ||
      (target.kind === 'repository' &&
        boundedString(target.repoId, 200) &&
        target.repoId === value.repoId)) &&
    SCRIPT_ACTION_SOURCE_KINDS.some((kind) => kind === source.kind) &&
    boundedString(source.file) &&
    !source.file.startsWith('/') &&
    !/^[A-Za-z]:/.test(source.file) &&
    boundedString(source.entry) &&
    (source.line === null ||
      (Number.isInteger(source.line) && Number(source.line) > 0)) &&
    boundedString(value.revision, 256) &&
    ['approved', 'pending', 'dismissed'].includes(String(value.status)) &&
    (value.shortcut === null || boundedString(value.shortcut, 100)) &&
    typeof value.pinned === 'boolean' &&
    (value.unavailableReason === undefined ||
      boundedString(value.unavailableReason)) &&
    (value.shortcutConflict === undefined ||
      boundedString(value.shortcutConflict))
  );
}
export function isScriptActionsSnapshot(
  value: unknown,
): value is ScriptActionsSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.actions) &&
    value.actions.length <= 100000 &&
    value.actions.every(isScriptAction) &&
    Number.isInteger(value.pendingCount) &&
    Number(value.pendingCount) >= 0 &&
    typeof value.shellAliasScanEnabled === 'boolean' &&
    (value.shortcutContext === undefined ||
      (isRecord(value.shortcutContext) &&
        ['darwin', 'win32', 'linux'].includes(
          String(value.shortcutContext.platform),
        ) &&
        Array.isArray(value.shortcutContext.reserved) &&
        value.shortcutContext.reserved.length <= 1000 &&
        value.shortcutContext.reserved.every(
          (binding) =>
            isRecord(binding) &&
            boundedString(binding.accelerator, 100) &&
            boundedString(binding.title),
        ))) &&
    ['idle', 'scanning', 'complete', 'incomplete', 'failed'].includes(
      String(value.scanStatus),
    ) &&
    (value.scannedAt === null ||
      (typeof value.scannedAt === 'string' &&
        Number.isFinite(Date.parse(value.scannedAt)))) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length <= 10000 &&
    value.diagnostics.every(
      (d) =>
        isRecord(d) &&
        boundedString(d.source) &&
        [
          'unreadable',
          'malformed',
          'truncated',
          'unsupported',
          'outside-root',
        ].includes(String(d.code)) &&
        boundedString(d.message),
    )
  );
}
export function isScriptActionsAddReceipt(
  value: unknown,
): value is ScriptActionsAddReceipt {
  return (
    isRecord(value) &&
    (value.worktreeId === null || typeof value.worktreeId === 'string') &&
    isScriptActionsReceiptRequest({
      ...value,
      worktreeId: value.worktreeId ?? undefined,
    }) &&
    isRecord(value) &&
    Array.isArray(value.repoIds) &&
    value.repoIds.length <= 200 &&
    value.repoIds.every((id) => boundedString(id, 200)) &&
    ['scanning', 'complete', 'failed'].includes(String(value.status)) &&
    Number.isInteger(value.pendingCount) &&
    Number(value.pendingCount) >= 0 &&
    (value.completedAt === null ||
      (typeof value.completedAt === 'string' &&
        Number.isFinite(Date.parse(value.completedAt))))
  );
}

/** Shared CanopyClient operation definitions for host adapters. */
export interface ScriptActionsQueryMap {
  'scriptActions.list': {
    args: ScriptActionsListRequest;
    result: ScriptActionsSnapshot;
  };
  'scriptActions.receipt': {
    args: ScriptActionsReceiptRequest;
    result: ScriptActionsAddReceipt | null;
  };
}
export interface ScriptActionsCommandMap {
  'scriptActions.rescan': {
    args: ScriptActionsContext;
    result: ScriptActionsSnapshot;
  };
  'scriptActions.review': {
    args: ScriptActionsReviewRequest;
    result: ScriptActionsSnapshot;
  };
  'scriptActions.setShortcut': {
    args: ScriptActionsShortcutRequest;
    result: ScriptActionsSnapshot;
  };
  'scriptActions.setPinned': {
    args: ScriptActionsPinRequest;
    result: ScriptActionsSnapshot;
  };
  'scriptActions.enableShellAliasScan': {
    args: ScriptActionsContext;
    result: ScriptActionsSnapshot;
  };
}
export const SCRIPT_ACTIONS_DOMAIN_EVENT = 'scriptActions.changed';
