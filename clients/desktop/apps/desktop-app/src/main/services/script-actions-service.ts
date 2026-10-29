import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import {
  isRecord,
  isScriptAction,
  isScriptActionsContext,
  isScriptActionsReviewRequest,
  isScriptActionsShortcutRequest,
  isScriptActionsPinRequest,
  type ScriptAction,
  type ScriptActionsContext,
  type ScriptActionsSnapshot,
  type ScriptActionsListRequest,
  type ScriptActionsReviewRequest,
  type ScriptActionsShortcutRequest,
  type ScriptActionsPinRequest,
  type ScriptActionsReceiptRequest,
  type ScriptActionsAddReceipt,
  type ScriptActionsErrorCode,
  type ScriptActionDiagnostic,
} from '@canopy/protocol/script-actions';
import {
  detectRepositoryScripts,
  detectShellAliases,
  type ScriptTerminalShell,
} from '@canopy/desktop-shared/node/script-detection';
import { isMissing } from '@canopy/desktop-shared/node/script-detection/source-reader';
import {
  normalizeAccelerator,
  parseAccelerator,
  validateGlobalShortcut,
  type ShortcutPlatform,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { acceleratorSignature } from '@canopy/protocol/shortcuts';

export class ScriptActionsError extends Error {
  public constructor(
    public readonly code: ScriptActionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptActionsError';
  }
}
export interface ScriptActionCheckout {
  repoId: string;
  repoName: string;
  root: string;
}
export interface ScriptActionsServicePorts {
  workspacePath(projectId: string): string;
  aliasPath(): string;
  home(): string;
  shell(): ScriptTerminalShell;
  platform: ShortcutPlatform;
  /** Typed worker read port; defaults to the bounded in-process detector. */
  detectRepository?: typeof detectRepositoryScripts;
  detectAliases?: typeof detectShellAliases;
  /** Must authorize workspace/worktree membership before projecting host paths. */
  resolve(context: ScriptActionsContext): Promise<ScriptActionCheckout[]>;
  resolveRepositorySources?(projectId: string): Promise<ScriptActionCheckout[]>;
  tracked(context: ScriptActionsContext): Promise<ScriptAction[]>;
  reservedShortcuts(): Promise<ReadonlyMap<string, string>>;
  changed(context: ScriptActionsContext): void;
  found?(receipt: ScriptActionsAddReceipt): void;
  watch?: boolean;
}
interface Row {
  action: ScriptAction;
  active: boolean;
  reviewedRevision: string | null;
}
interface State {
  version: 1;
  enabled: boolean;
  targets: Record<string, Row[]>;
}
function emptyState(): State {
  return { version: 1, enabled: false, targets: {} };
}
function isRow(value: unknown): value is Row {
  return (
    isRecord(value) &&
    isScriptAction(value.action) &&
    typeof value.active === 'boolean' &&
    (value.reviewedRevision === null ||
      typeof value.reviewedRevision === 'string')
  );
}
async function loadState(file: string): Promise<State> {
  try {
    const handle = await open(file, 'r');
    let raw: string;
    try {
      if ((await handle.stat()).size > 32 * 1024 * 1024)
        throw new Error('State exceeds storage limit.');
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.enabled !== 'boolean' ||
      !isRecord(value.targets) ||
      !Object.values(value.targets).every(
        (rows) => Array.isArray(rows) && rows.every(isRow),
      )
    )
      throw new Error('Invalid state.');
    const targets: Record<string, Row[]> = {};
    for (const [key, rows] of Object.entries(value.targets)) {
      if (
        !Array.isArray(rows) ||
        !rows.every(isRow) ||
        new Set(rows.map((row) => row.action.id)).size !== rows.length
      )
        throw new Error('Invalid state rows.');
      targets[key] = rows;
    }
    return { version: 1, enabled: value.enabled, targets };
  } catch (error) {
    if (isMissing(error)) return emptyState();
    throw new ScriptActionsError(
      'storage_error',
      'Script action preferences could not be read. Existing data was preserved.',
    );
  }
}
async function saveState(file: string, state: State): Promise<void> {
  if (
    Object.values(state.targets).some(
      (rows) =>
        !rows.every(isRow) ||
        new Set(rows.map((row) => row.action.id)).size !== rows.length,
    )
  ) {
    throw new ScriptActionsError(
      'invalid_payload',
      'Scan produced invalid or conflicting script definitions. Existing preferences were preserved.',
    );
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(temp, 'wx', 0o600);
    try {
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024 * 1024)
        throw new Error('State exceeds storage limit.');
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch {
    await unlink(temp).catch(() => undefined);
    throw new ScriptActionsError(
      'storage_error',
      'Script action preferences could not be saved.',
    );
  }
}
function reconcile(
  previous: Row[],
  actions: ScriptAction[],
  complete: boolean,
): Row[] {
  const byId = new Map(previous.map((row) => [row.action.id, row]));
  const next: Row[] = [];
  for (const action of actions) {
    const old = byId.get(action.id);
    byId.delete(action.id);
    const unchanged =
      old?.active === true && old.action.revision === action.revision;
    next.push({
      action: {
        ...action,
        status:
          action.kind === 'tracked'
            ? 'approved'
            : unchanged
              ? old.action.status
              : 'pending',
        pinned: old?.action.pinned ?? false,
        shortcut: old?.action.shortcut ?? null,
      },
      active: true,
      reviewedRevision:
        action.kind === 'tracked'
          ? action.revision
          : unchanged
            ? old.reviewedRevision
            : null,
    });
  }
  for (const old of Array.from(byId.values()))
    next.push({
      ...old,
      active: complete ? false : old.active,
      reviewedRevision: null,
      action: {
        ...old.action,
        status: 'pending',
        ...(!complete && old.active
          ? {
              unavailableReason:
                'Source could not be verified. Rescan before reviewing or running.',
            }
          : {}),
      },
    });
  return next;
}
const contextKey = (context: ScriptActionsContext): string =>
  JSON.stringify([context.projectId, context.worktreeId]);
/** Single writer for script review metadata. All cross-file operations use the same queue.
 * Review batches must target one store; callers split alias/workspace submissions explicitly.
 */
export class ScriptActionsService {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly scans = new Map<string, Promise<ScriptActionsSnapshot>>();
  private readonly activeScans = new Set<string>();
  private readonly scanInfo = new Map<
    string,
    {
      scanStatus: ScriptActionsSnapshot['scanStatus'];
      scannedAt: string | null;
      diagnostics: ScriptActionDiagnostic[];
    }
  >();
  private readonly contexts = new Map<string, ScriptActionsContext>();
  private readonly receipts = new Map<string, ScriptActionsAddReceipt>();
  private readonly watchers = new Map<
    string,
    { watchers: FSWatcher[]; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly addJobs = new Map<
    string,
    Promise<ScriptActionsAddReceipt>
  >();
  private readonly generations = new Map<string, number>();
  private disposed = false;
  public constructor(private readonly ports: ScriptActionsServicePorts) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.disposed)
        throw new ScriptActionsError(
          'invalid_target',
          'Script action service is closed.',
        );
      return run();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async authorize(
    context: ScriptActionsContext,
  ): Promise<ScriptActionCheckout[]> {
    if (!isScriptActionsContext(context))
      throw new ScriptActionsError(
        'invalid_payload',
        'Invalid script action context.',
      );
    const checkouts = await this.ports.resolve(context);
    this.contexts.set(contextKey(context), {
      projectId: context.projectId,
      worktreeId: context.worktreeId,
    });
    return checkouts;
  }
  private async snapshot(
    context: ScriptActionsListRequest,
  ): Promise<ScriptActionsSnapshot> {
    const workspace = await loadState(
      this.ports.workspacePath(context.projectId),
    );
    const aliases = await loadState(this.ports.aliasPath());
    const tracked = await this.ports.tracked(context);
    const stored = workspace.targets[context.worktreeId] ?? [];
    const trackedById = new Map(
      stored
        .filter((row) => row.action.kind === 'tracked')
        .map((row) => [row.action.id, row.action]),
    );
    const actions = [
      ...tracked.map((action) => ({
        ...action,
        shortcut: trackedById.get(action.id)?.shortcut ?? null,
        pinned: trackedById.get(action.id)?.pinned ?? false,
      })),
      ...stored
        .filter((row) => row.active && row.action.kind !== 'tracked')
        .map((row) => this.effective(row)),
      ...(aliases.enabled
        ? (aliases.targets.user ?? [])
            .filter((row) => row.active)
            .map((row) => this.effective(row))
        : []),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const reserved = await this.ports.reservedShortcuts();
    const bindings = new Map<string, ScriptAction[]>();
    for (const action of actions) {
      if (
        !action.shortcut ||
        action.status !== 'approved' ||
        action.unavailableReason
      )
        continue;
      const key = this.shortcutKey(action.shortcut);
      const list = bindings.get(key) ?? [];
      list.push(action);
      bindings.set(key, list);
    }
    for (const [key, members] of Array.from(bindings)) {
      const conflict = Array.from(reserved).find(
        ([chord]) => this.shortcutKey(chord) === key,
      )?.[1];
      if (conflict || members.length > 1)
        for (const member of members)
          member.shortcutConflict = `Already used by ${conflict ?? members.find((action) => action.id !== member.id)?.name ?? 'another action'}`;
    }
    return {
      actions: actions.filter(
        (action) => context.includeDismissed || action.status !== 'dismissed',
      ),
      pendingCount: actions.filter((action) => action.status === 'pending')
        .length,
      shellAliasScanEnabled: aliases.enabled,
      shortcutContext: {
        platform: this.ports.platform,
        reserved: Array.from(reserved, ([accelerator, title]) => ({
          accelerator,
          title,
        })),
      },
      ...(this.scanInfo.get(contextKey(context)) ?? {
        scanStatus: 'idle',
        scannedAt: null,
        diagnostics: [],
      }),
    };
  }
  private effective(row: Row): ScriptAction {
    const action = { ...row.action };
    if (action.kind !== 'tracked' && row.reviewedRevision !== action.revision)
      action.status = 'pending';
    return action;
  }
  public list(
    context: ScriptActionsListRequest,
  ): Promise<ScriptActionsSnapshot> {
    if (!this.scanInfo.has(contextKey(context))) {
      return this.rescan(context).then(() =>
        this.serialize(() => this.snapshot(context)),
      );
    }
    return this.serialize(async () => {
      await this.authorize(context);
      return this.snapshot(context);
    });
  }
  public rescan(context: ScriptActionsContext): Promise<ScriptActionsSnapshot> {
    const key = contextKey(context);
    const existing = this.scans.get(key);
    if (existing) {
      // A running scan may already have read sources that changed before this
      // request. Only requests queued before scanning starts can share it.
      return this.activeScans.has(key)
        ? existing.then(() => this.rescan(context))
        : existing;
    }
    const generation = this.generations.get(key) ?? 0;
    const result = this.serialize(async () => {
      this.activeScans.add(key);
      const checkouts = await this.authorize(context);
      const workspace = await loadState(
        this.ports.workspacePath(context.projectId),
      );
      const aliases = await loadState(this.ports.aliasPath());
      const detected: ScriptAction[] = [];
      const diagnostics: ScriptActionDiagnostic[] = [];
      const watchPaths: string[] = [];
      let complete = true;
      for (const checkout of checkouts) {
        const scan = await (
          this.ports.detectRepository ?? detectRepositoryScripts
        )({
          ...checkout,
          shell: this.ports.shell(),
          platform: this.ports.platform === 'win32' ? 'win32' : 'posix',
        });
        detected.push(...scan.actions);
        diagnostics.push(...scan.diagnostics);
        complete = complete && scan.complete;
        watchPaths.push(
          ...scan.watchedDirectories.map((directory) =>
            join(checkout.root, directory),
          ),
        );
      }
      await this.ports.resolve(context);
      if (
        !this.contexts.has(key) ||
        this.disposed ||
        (this.generations.get(key) ?? 0) !== generation
      )
        throw new ScriptActionsError(
          'invalid_target',
          'Script action target was closed.',
        );
      const tracked = await this.ports.tracked(context);
      workspace.targets[context.worktreeId] = reconcile(
        workspace.targets[context.worktreeId] ?? [],
        [...tracked, ...detected],
        complete,
      );
      // Separate store commits: never report a mixed review as one atomic success.
      if (aliases.enabled) {
        const scan = await (this.ports.detectAliases ?? detectShellAliases)({
          home: this.ports.home(),
          shell: this.ports.shell(),
        });
        if (this.disposed || (this.generations.get(key) ?? 0) !== generation)
          throw new ScriptActionsError(
            'invalid_target',
            'Script action target was closed.',
          );
        aliases.targets.user = reconcile(
          aliases.targets.user ?? [],
          scan.actions,
          scan.complete,
        );
        diagnostics.push(...scan.diagnostics);
        complete = complete && scan.complete;
        await saveState(this.ports.aliasPath(), aliases);
        this.publishAll();
        watchPaths.push(
          this.ports.home(),
          join(this.ports.home(), '.config'),
          join(this.ports.home(), '.config/fish'),
        );
      }
      await saveState(this.ports.workspacePath(context.projectId), workspace);
      this.scanInfo.set(key, {
        scanStatus: complete ? 'complete' : 'incomplete',
        scannedAt: new Date().toISOString(),
        diagnostics: diagnostics.slice(0, 10000),
      });
      this.installWatches(context, watchPaths);
      this.ports.changed(context);
      return this.snapshot({ ...context, includeDismissed: true });
    }).catch((error) => {
      this.closeTargetWatches(context);
      this.scanInfo.set(key, {
        scanStatus: 'failed',
        scannedAt: this.scanInfo.get(key)?.scannedAt ?? null,
        diagnostics: [
          {
            source: '.',
            code: 'unreadable',
            message: 'Scan failed. Previous inventory is retained.',
          },
        ],
      });
      throw error;
    });
    this.scans.set(key, result);
    void result.then(
      () => {
        this.activeScans.delete(key);
        this.scans.delete(key);
      },
      () => {
        this.activeScans.delete(key);
        this.scans.delete(key);
      },
    );
    return result;
  }
  public enableShellAliasScan(
    context: ScriptActionsContext,
  ): Promise<ScriptActionsSnapshot> {
    return this.serialize(async () => {
      await this.authorize(context);
      const state = await loadState(this.ports.aliasPath());
      state.enabled = true;
      await saveState(this.ports.aliasPath(), state);
      this.publishAll();
    }).then(() => this.rescan(context));
  }
  public review(
    request: ScriptActionsReviewRequest,
  ): Promise<ScriptActionsSnapshot> {
    if (!isScriptActionsReviewRequest(request))
      return Promise.reject(
        new ScriptActionsError(
          'invalid_payload',
          'Invalid script review request.',
        ),
      );
    return this.rescan(request).then(() =>
      this.mutate(
        request,
        request.entries.map((entry) => entry.id),
        async (rows, snapshot) => {
          for (const entry of request.entries) {
            const row = rows.find(
              (candidate) =>
                candidate.active && candidate.action.id === entry.id,
            );
            if (!row)
              throw new ScriptActionsError(
                'not_found',
                'Script action was not found.',
              );
            if (row.action.kind === 'tracked')
              throw new ScriptActionsError(
                'invalid_payload',
                'Tracked scripts do not require review.',
              );
            if (row.action.revision !== entry.revision)
              throw new ScriptActionsError(
                'stale_revision',
                'Script definition changed. Refresh and select it again.',
              );
            if (request.decision === 'approve') {
              if (row.action.unavailableReason)
                throw new ScriptActionsError(
                  'invalid_target',
                  row.action.unavailableReason,
                );
              if (row.action.shortcut)
                await this.assertNoConflict(
                  row.action.shortcut,
                  row.action.id,
                  snapshot,
                );
            }
          }
          for (const entry of request.entries) {
            const row = rows.find(
              (candidate) => candidate.action.id === entry.id,
            );
            if (!row) continue;
            row.action.status =
              request.decision === 'approve'
                ? 'approved'
                : request.decision === 'dismiss'
                  ? 'dismissed'
                  : 'pending';
            row.reviewedRevision =
              request.decision === 'reset' ? null : row.action.revision;
          }
          // Reapproving multiple retained bindings must not reactivate a duplicate chord.
          const chords = new Set<string>();
          for (const row of rows)
            if (
              row.active &&
              row.action.status === 'approved' &&
              row.action.shortcut
            ) {
              const key = this.shortcutKey(row.action.shortcut);
              if (chords.has(key))
                throw new ScriptActionsError(
                  'shortcut_conflict',
                  'Selected actions have conflicting shortcuts.',
                );
              chords.add(key);
            }
        },
      ),
    );
  }
  public setShortcut(
    request: ScriptActionsShortcutRequest,
  ): Promise<ScriptActionsSnapshot> {
    if (!isScriptActionsShortcutRequest(request))
      return Promise.reject(
        new ScriptActionsError('invalid_payload', 'Invalid shortcut request.'),
      );
    return this.mutate(request, [request.id], async (rows, snapshot) => {
      const row = rows.find(
        (candidate) => candidate.active && candidate.action.id === request.id,
      );
      if (!row)
        throw new ScriptActionsError(
          'not_found',
          'Script action was not found.',
        );
      const accelerator =
        request.accelerator === null
          ? null
          : this.normalizeShortcut(request.accelerator);
      if (accelerator) {
        this.requireApproval(row);
        await this.assertNoConflict(accelerator, row.action.id, snapshot);
      }
      row.action.shortcut = accelerator;
    });
  }
  public setPinned(
    request: ScriptActionsPinRequest,
  ): Promise<ScriptActionsSnapshot> {
    if (!isScriptActionsPinRequest(request))
      return Promise.reject(
        new ScriptActionsError('invalid_payload', 'Invalid pin request.'),
      );
    return this.mutate(request, [request.id], (rows) => {
      const row = rows.find(
        (candidate) => candidate.active && candidate.action.id === request.id,
      );
      if (!row)
        throw new ScriptActionsError(
          'not_found',
          'Script action was not found.',
        );
      if (request.pinned) this.requireApproval(row);
      row.action.pinned = request.pinned;
    });
  }
  private requireApproval(row: Row): void {
    if (
      this.effective(row).status !== 'approved' ||
      row.action.unavailableReason
    )
      throw new ScriptActionsError(
        'approval_required',
        'Approve this script before assigning a shortcut or pin.',
      );
  }
  private shortcutKey(value: string): string {
    return acceleratorSignature(value, this.ports.platform) ?? value;
  }
  private normalizeShortcut(value: string): string {
    const parsed = parseAccelerator(value);
    const normalized = normalizeAccelerator(value);
    if (
      !parsed ||
      !normalized ||
      !parsed.modifiers.some((modifier) =>
        ['CommandOrControl', 'Command', 'Control', 'Alt'].includes(modifier),
      ) ||
      ((): boolean => {
        const validation = validateGlobalShortcut(
          normalized,
          this.ports.platform,
        );
        return (
          !validation.ok &&
          !(
            validation.reason === 'needs-modifier' &&
            parsed.modifiers.includes('Alt')
          )
        );
      })()
    )
      throw new ScriptActionsError(
        'invalid_payload',
        'Use a valid shortcut with Command, Control or Alt.',
      );
    return normalized;
  }
  private async assertNoConflict(
    value: string,
    id: string,
    snapshot: ScriptActionsSnapshot,
  ): Promise<void> {
    const key = this.shortcutKey(value);
    const conflict = snapshot.actions.find(
      (action) =>
        action.id !== id &&
        action.status === 'approved' &&
        !action.unavailableReason &&
        action.shortcut &&
        this.shortcutKey(action.shortcut) === key,
    );
    const reserved = Array.from(await this.ports.reservedShortcuts()).find(
      ([chord]) => this.shortcutKey(chord) === key,
    )?.[1];
    if (conflict || reserved)
      throw new ScriptActionsError(
        'shortcut_conflict',
        conflict
          ? `Already used by ${conflict.name}`
          : (reserved ?? 'Shortcut is already used.'),
      );
  }
  private mutate(
    context: ScriptActionsContext,
    ids: string[],
    update: (
      rows: Row[],
      snapshot: ScriptActionsSnapshot,
    ) => void | Promise<void>,
  ): Promise<ScriptActionsSnapshot> {
    return this.serialize(async () => {
      await this.authorize(context);
      const snapshot = await this.snapshot({
        ...context,
        includeDismissed: true,
      });
      const actions = ids.map((id) =>
        snapshot.actions.find((action) => action.id === id),
      );
      if (actions.some((action) => !action))
        throw new ScriptActionsError(
          'not_found',
          'Script action was not found.',
        );
      const alias = actions.some((action) => action?.kind === 'alias');
      if (alias && actions.some((action) => action?.kind !== 'alias'))
        throw new ScriptActionsError(
          'mixed_stores',
          'Submit personal alias and repository reviews separately.',
        );
      const file = alias
        ? this.ports.aliasPath()
        : this.ports.workspacePath(context.projectId);
      const state = await loadState(file);
      const key = alias ? 'user' : context.worktreeId;
      const rows = state.targets[key] ?? [];
      for (const action of snapshot.actions.filter(
        (action) => action.kind === 'tracked',
      )) {
        if (!alias && !rows.some((row) => row.action.id === action.id))
          rows.push({
            action,
            active: true,
            reviewedRevision: action.revision,
          });
      }
      await update(rows, snapshot);
      state.targets[key] = rows;
      await saveState(file, state);
      if (alias) this.publishAll();
      else this.ports.changed(context);
      return this.snapshot({ ...context, includeDismissed: true });
    });
  }
  private publishAll(): void {
    for (const context of Array.from(this.contexts.values()))
      this.ports.changed(context);
  }
  public scanAfterAdd(
    context: ScriptActionsContext,
    repoIds: string[],
    operationId: string = randomUUID(),
  ): Promise<ScriptActionsAddReceipt> {
    const key = JSON.stringify([
      context.projectId,
      context.worktreeId,
      operationId,
    ]);
    const existing = this.addJobs.get(key);
    if (existing) return existing;
    const job = this.performAddScan(context, repoIds, operationId);
    this.addJobs.set(key, job);
    void job.then(
      () => this.addJobs.delete(key),
      () => this.addJobs.delete(key),
    );
    return job;
  }
  private async performAddScan(
    context: ScriptActionsContext,
    repoIds: string[],
    operationId: string = randomUUID(),
  ): Promise<ScriptActionsAddReceipt> {
    await this.authorize(context);
    const key = JSON.stringify([
      context.projectId,
      context.worktreeId,
      operationId,
    ]);
    const previous = this.receipts.get(key);
    if (previous) return previous;
    const before = await this.serialize(() =>
      this.snapshot({ ...context, includeDismissed: true }),
    );
    const known = new Map(
      before.actions.map((action) => [action.id, action.revision]),
    );
    const receipt: ScriptActionsAddReceipt = {
      ...context,
      operationId,
      repoIds: Array.from(new Set(repoIds)),
      status: 'scanning',
      pendingCount: 0,
      completedAt: null,
    };
    this.receipts.set(key, receipt);
    while (this.receipts.size > 100) {
      const oldest = this.receipts.keys().next().value;
      if (oldest) this.receipts.delete(oldest);
    }
    try {
      const existingScan = this.scans.get(contextKey(context));
      if (existingScan) await existingScan;
      const snapshot = await this.rescan(context);
      receipt.status = 'complete';
      receipt.pendingCount = snapshot.actions.filter(
        (action) =>
          action.kind === 'detected' &&
          action.repoId &&
          repoIds.includes(action.repoId) &&
          action.status === 'pending' &&
          known.get(action.id) !== action.revision,
      ).length;
      receipt.completedAt = new Date().toISOString();
      if (receipt.pendingCount > 0) this.ports.found?.({ ...receipt });
    } catch {
      receipt.status = 'failed';
      receipt.completedAt = new Date().toISOString();
    }
    return { ...receipt };
  }
  public scanWorkspaceAfterAdd(
    projectId: string,
    repoIds: string[],
    operationId: string,
  ): Promise<ScriptActionsAddReceipt> {
    const key = JSON.stringify([projectId, null, operationId]);
    const existing = this.addJobs.get(key);
    if (existing) return existing;
    const job = this.serialize(async () => {
      const prior = this.receipts.get(key);
      if (prior) return prior;
      if (!this.ports.resolveRepositorySources)
        throw new ScriptActionsError(
          'unsupported',
          'Repository source scanning is unavailable.',
        );
      const checkouts = await this.ports.resolveRepositorySources(projectId);
      const receipt: ScriptActionsAddReceipt = {
        projectId,
        worktreeId: null,
        repoIds,
        operationId,
        status: 'scanning',
        pendingCount: 0,
        completedAt: null,
      };
      this.receipts.set(key, receipt);
      try {
        for (const checkout of checkouts.filter((repo) =>
          repoIds.includes(repo.repoId),
        )) {
          const scan = await (
            this.ports.detectRepository ?? detectRepositoryScripts
          )({
            ...checkout,
            shell: this.ports.shell(),
            platform: this.ports.platform === 'win32' ? 'win32' : 'posix',
          });
          receipt.pendingCount += scan.actions.length;
        }
        await this.ports.resolveRepositorySources(projectId);
        receipt.status = 'complete';
        receipt.completedAt = new Date().toISOString();
        if (receipt.pendingCount > 0) this.ports.found?.({ ...receipt });
      } catch {
        receipt.status = 'failed';
        receipt.pendingCount = 0;
        receipt.completedAt = new Date().toISOString();
      }
      while (this.receipts.size > 100) {
        const oldest = this.receipts.keys().next().value;
        if (oldest) this.receipts.delete(oldest);
      }
      return { ...receipt };
    });
    this.addJobs.set(key, job);
    void job.then(
      () => this.addJobs.delete(key),
      () => this.addJobs.delete(key),
    );
    return job;
  }
  public async receipt(
    request: ScriptActionsReceiptRequest,
  ): Promise<ScriptActionsAddReceipt | null> {
    if (this.disposed)
      throw new ScriptActionsError(
        'invalid_target',
        'Script action service is closed.',
      );
    // Receipt reads must stay responsive while scans occupy the mutation queue.
    if (request.worktreeId !== undefined)
      await this.authorize({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      });
    else if (this.ports.resolveRepositorySources)
      await this.ports.resolveRepositorySources(request.projectId);
    else
      throw new ScriptActionsError(
        'invalid_target',
        'Select a worktree for this receipt.',
      );
    const receipt = this.receipts.get(
      JSON.stringify([
        request.projectId,
        request.worktreeId ?? null,
        request.operationId,
      ]),
    );
    return receipt ? { ...receipt, repoIds: [...receipt.repoIds] } : null;
  }
  private installWatches(context: ScriptActionsContext, paths: string[]): void {
    if (!this.ports.watch || this.disposed) return;
    this.closeTargetWatches(context);
    const key = contextKey(context);
    const slot: {
      watchers: FSWatcher[];
      timer?: ReturnType<typeof setTimeout>;
    } = { watchers: [] };
    this.watchers.set(key, slot);
    const used = Array.from(this.watchers)
      .filter(
        ([other]) => this.contexts.get(other)?.projectId === context.projectId,
      )
      .reduce((sum, [, value]) => sum + value.watchers.length, 0);
    for (const path of Array.from(new Set(paths))
      .sort()
      .slice(0, Math.max(0, 50 - used))) {
      try {
        const scheduleRescan = (): void => {
          if (this.disposed || this.watchers.get(key) !== slot) return;
          if (slot.timer) clearTimeout(slot.timer);
          slot.timer = setTimeout(() => {
            void this.rescan(context).catch(() => undefined);
          }, 1000);
          slot.timer.unref();
        };
        const watcher = watch(path, scheduleRescan);
        watcher.unref();
        watcher.on('error', () => {
          watcher.close();
          scheduleRescan();
        });
        slot.watchers.push(watcher);
      } catch {
        /* Missing directories recover on root rename events or explicit rescan. */
      }
    }
  }
  private closeTargetWatches(context: ScriptActionsContext): void {
    const key = contextKey(context);
    const slot = this.watchers.get(key);
    if (slot?.timer) clearTimeout(slot.timer);
    for (const watcher of slot?.watchers ?? []) watcher.close();
    this.watchers.delete(key);
  }
  public closeTarget(context: ScriptActionsContext): void {
    this.closeTargetWatches(context);
    const key = contextKey(context);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.contexts.delete(key);
    this.scanInfo.delete(key);
  }
  public async dispose(): Promise<void> {
    this.disposed = true;
    for (const context of Array.from(this.contexts.values()))
      this.closeTargetWatches(context);
    await this.tail;
    await Promise.allSettled(Array.from(this.addJobs.values()));
  }
}
