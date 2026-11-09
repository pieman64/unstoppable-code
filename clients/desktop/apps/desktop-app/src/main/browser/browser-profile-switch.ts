import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isProfileId,
  isProfileRecord,
  isBrowserProfileBinding,
} from '@canopy/protocol/browser-profiles';
import {
  readProfileJson,
  writeProfileJson,
  withProfileWriter,
} from '@canopy/desktop-shared/node/browser-profiles/storage';
import type {
  BrowserJavaScriptDialog,
  BrowserProfileSwitchRequest,
  BrowserProfileSwitchResult,
  BrowserSessionSnapshot,
} from '@canopy/execution-engine/types/browser';
import { isErrnoException } from '../lib/type-guards';

export interface BrowserSwitchRecord {
  schemaVersion: 1;
  operationId: string;
  digest: string;
  createdAt: number;
  stage:
    | 'prepared'
    | 'close_intent'
    | 'target_committed'
    | 'complete'
    | 'aborted';
  source: BrowserSessionSnapshot;
  target: BrowserSessionSnapshot;
  mode: 'replace' | 'new-tab';
  result?: BrowserProfileSwitchResult;
}

/** Fixed field order makes JSON/tool retries independent of object insertion order. */
export function browserProfileSwitchDigest(
  request: BrowserProfileSwitchRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operationId: request.operationId,
        browserId: request.browserId,
        expectedRuntimeGeneration: request.expectedRuntimeGeneration,
        selection:
          request.selection.kind === 'task'
            ? { kind: 'task' }
            : { kind: 'named', profileId: request.selection.profileId },
        mode: request.mode,
      }),
    )
    .digest('hex');
}
interface ExpiredSwitchRecord {
  schemaVersion: 1;
  stage: 'expired';
  operationId: string;
  digest: string;
  createdAt: number;
}
function isExpiredRecord(value: unknown): value is ExpiredSwitchRecord {
  return (
    isProfileRecord(value) &&
    value.schemaVersion === 1 &&
    value.stage === 'expired' &&
    isProfileId(value.operationId) &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    Number.isSafeInteger(value.createdAt)
  );
}
function expiredRecord(record: BrowserSwitchRecord): ExpiredSwitchRecord {
  return {
    schemaVersion: 1,
    stage: 'expired',
    operationId: record.operationId,
    digest: record.digest,
    createdAt: record.createdAt,
  };
}

function isBrowserSnapshot(value: unknown): value is BrowserSessionSnapshot {
  return (
    isProfileRecord(value) &&
    isProfileId(value.id) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    isBrowserProfileBinding(value.profile)
  );
}

function isBrowserDialog(value: unknown): value is BrowserJavaScriptDialog {
  return (
    isProfileRecord(value) &&
    isProfileId(value.id) &&
    isProfileId(value.browserId) &&
    ['alert', 'confirm', 'prompt', 'beforeunload'].includes(
      String(value.type),
    ) &&
    typeof value.message === 'string' &&
    typeof value.url === 'string' &&
    Number.isFinite(value.openedAt)
  );
}

function isSwitchResult(value: unknown): value is BrowserProfileSwitchResult {
  return (
    isProfileRecord(value) &&
    [
      'complete',
      'cancelled',
      'source_reloaded_after_failure',
      'pending',
    ].includes(String(value.status)) &&
    isBrowserSnapshot(value.browser) &&
    (value.message === undefined || typeof value.message === 'string') &&
    (value.operationId === undefined || isProfileId(value.operationId)) &&
    (value.dialog === undefined || isBrowserDialog(value.dialog))
  );
}

function isBrowserSwitchRecord(value: unknown): value is BrowserSwitchRecord {
  return (
    isProfileRecord(value) &&
    value.schemaVersion === 1 &&
    isProfileId(value.operationId) &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    Number.isSafeInteger(value.createdAt) &&
    [
      'prepared',
      'close_intent',
      'target_committed',
      'complete',
      'aborted',
    ].includes(String(value.stage)) &&
    ['replace', 'new-tab'].includes(String(value.mode)) &&
    isBrowserSnapshot(value.source) &&
    isBrowserProfileBinding(value.source.profile) &&
    isBrowserSnapshot(value.target) &&
    isBrowserProfileBinding(value.target.profile) &&
    value.source.projectId === value.target.projectId &&
    value.source.worktreeId === value.target.worktreeId &&
    value.source.profile.taskIncarnationId ===
      value.target.profile.taskIncarnationId &&
    (value.result === undefined || isSwitchResult(value.result))
  );
}

function validate(value: unknown): BrowserSwitchRecord {
  if (!isBrowserSwitchRecord(value))
    throw new BrowserProfileError(
      'recovery_required',
      'A profile switch journal is unreadable. Original data was preserved.',
    );
  return value;
}

/** Small process-crash journal; the tab binding is repaired from this decision before reuse. */
export class BrowserSwitchJournal {
  constructor(readonly root: string) {}
  private file(id: string): string {
    if (!isProfileId(id))
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid profile operation ID.',
      );
    return join(this.root, `${id}.json`);
  }
  async find(
    request: BrowserProfileSwitchRequest,
  ): Promise<BrowserSwitchRecord | undefined> {
    const raw = await readProfileJson(this.file(request.operationId));
    if (raw === undefined) return undefined;
    const record = isExpiredRecord(raw) ? raw : validate(raw);
    const digest = browserProfileSwitchDigest(request);
    if (record.digest !== digest)
      throw new BrowserProfileError(
        'operation_conflict',
        'This switch operation ID already has different input.',
      );
    if (
      record.stage === 'expired' ||
      (record.result && Date.now() - record.createdAt > 7 * 86400_000)
    ) {
      if (record.stage !== 'expired')
        await writeProfileJson(
          this.file(record.operationId),
          expiredRecord(record),
        );
      throw new BrowserProfileError(
        'operation_expired',
        'This switch result expired. Refresh before issuing another operation.',
      );
    }
    return record;
  }
  async begin(
    request: BrowserProfileSwitchRequest,
    source: BrowserSessionSnapshot,
    target: BrowserSessionSnapshot,
  ): Promise<BrowserSwitchRecord> {
    return withProfileWriter(this.root, async () => {
      const existing = await this.find(request);
      if (existing) return existing;
      const record: BrowserSwitchRecord = {
        schemaVersion: 1,
        operationId: request.operationId,
        digest: browserProfileSwitchDigest(request),
        createdAt: Date.now(),
        stage: 'prepared',
        source,
        target,
        mode: request.mode,
      };
      await writeProfileJson(this.file(record.operationId), record);
      return record;
    });
  }
  async update(
    record: BrowserSwitchRecord,
    stage: BrowserSwitchRecord['stage'],
    result?: BrowserProfileSwitchResult,
  ): Promise<BrowserSwitchRecord> {
    const next = { ...record, stage, ...(result ? { result } : {}) };
    await writeProfileJson(this.file(record.operationId), next);
    return next;
  }
  async pending(
    projectId: string,
    worktreeId: string,
  ): Promise<BrowserSwitchRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const records: BrowserSwitchRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await readProfileJson(join(this.root, file));
      if (isExpiredRecord(raw)) continue;
      const record = validate(raw);
      if (record.result && Date.now() - record.createdAt > 7 * 86400_000) {
        await writeProfileJson(
          this.file(record.operationId),
          expiredRecord(record),
        );
        continue;
      }
      if (
        !record.result &&
        record.source.projectId === projectId &&
        record.source.worktreeId === worktreeId
      )
        records.push(record);
    }
    return records.sort((a, b) => a.createdAt - b.createdAt);
  }
}

export interface BrowserSwitchAdapter<T> {
  allocate(this: void): Promise<T>;
  discard(this: void, target: T): Promise<void>;
  authorize(this: void): Promise<void>;
  closeSource(this: void): Promise<boolean>;
  commit(
    this: void,
    target: T,
    saveDecision: () => Promise<void>,
  ): Promise<void>;
  openTarget(this: void, target: T): Promise<BrowserSessionSnapshot>;
  reloadSource(this: void): Promise<BrowserSessionSnapshot>;
}

export async function performBrowserProfileSwitch<T>(
  journal: BrowserSwitchJournal,
  initial: BrowserSwitchRecord,
  adapter: BrowserSwitchAdapter<T>,
): Promise<BrowserProfileSwitchResult> {
  let record = initial;
  let target: T | undefined;
  let closed = false;
  let committed = false;
  try {
    target = await adapter.allocate();
    await adapter.authorize();
    if (record.mode === 'replace') {
      record = await journal.update(record, 'close_intent');
      closed = await adapter.closeSource();
      if (!closed) {
        const result: BrowserProfileSwitchResult = {
          status: 'cancelled',
          browser: record.source,
        };
        await journal.update(record, 'aborted', result);
        return result;
      }
    }
    await adapter.authorize();
    await adapter.commit(target, async () => {
      record = await journal.update(record, 'target_committed');
    });
    committed = true;
    const browser = await adapter.openTarget(target);
    target = undefined;
    const result: BrowserProfileSwitchResult = { status: 'complete', browser };
    await journal.update(record, 'complete', result);
    return result;
  } catch (error) {
    // A committed target remains the target even if loading or final receipt fails.
    if (committed || record.stage === 'target_committed') throw error;
    if (closed) {
      const browser = await adapter.reloadSource();
      const result: BrowserProfileSwitchResult = {
        status: 'source_reloaded_after_failure',
        browser,
        message:
          'The profile switch failed after the page closed. The original profile was reloaded; unsaved page changes were lost.',
      };
      await journal.update(record, 'aborted', result);
      return result;
    }
    await journal.update(record, 'aborted', {
      status: 'cancelled',
      browser: record.source,
    });
    throw error;
  } finally {
    if (target !== undefined) await adapter.discard(target);
  }
}
