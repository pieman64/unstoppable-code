/**
 * Reply and push decoders at the transport boundary.
 *
 * The validators the desktop preload applies to its replies and pushes are
 * reproduced here (organization project catalogs and setup progress,
 * workspace context, terminal events, organization and shared multi-repo
 * schemas, script actions), so every transport gets them, including the
 * desktop preload transport that does not run the preload's typed methods.
 *
 * Other replies get a shape check: the right top-level kind (a record, an
 * array, a string) plus the fields this adapter reads. Deeper fields are
 * trusted exactly as far as the desktop renderer has always trusted its own
 * host's typed IPC replies; the check turns a wrong reply (an older host, a
 * refused channel answered with nothing) into a typed
 * `RemoteIpcMalformedReplyError` instead of a crash further in.
 */
import type {
  TerminalExitEvent,
  TerminalOutputEvent,
  TerminalRunningChangedEvent,
} from '@canopy/protocol/terminal';
import {
  isOrgProjectSetupProgress,
  isOrgProjectSummary,
  type OrgProjectCatalogSnapshot,
} from '@canopy/protocol/org-projects';
import {
  isWorkspaceContextState,
  type WorkspaceContextState,
} from '@canopy/protocol/workspace-context';
import type { Decoder } from './channel-client';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A decoder for a host reply typed `T` whose top level passes `check`. See
 * the module comment for what is and is not verified.
 */
export function reply<T>(check: (value: unknown) => boolean): Decoder<T> {
  return (value: unknown): value is T => check(value);
}

/** Any record reply typed `T`. */
export function recordReply<T>(): Decoder<T> {
  return reply<T>(isRecord);
}

/** A record reply typed `T`, or `null`. */
export function nullableRecordReply<T>(): Decoder<T | null> {
  return reply<T | null>((value) => value === null || isRecord(value));
}

/** Any array reply typed `T`. */
export function arrayReply<T>(): Decoder<T> {
  return reply<T>(Array.isArray);
}

/** Any reply typed `T` (a value the host defines, including `undefined`). */
export function anyReply<T>(): Decoder<T> {
  return reply<T>(() => true);
}

export const isString = (value: unknown): value is string =>
  typeof value === 'string';

export const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Accepts every push (payloads the adapter does not read). */
export const anyPayload: Decoder<unknown> = reply<unknown>(() => true);

function hasRecordFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => field in value);
}

/** A record carrying `fields`, typed `T`. */
export function recordWith<T>(...fields: string[]): Decoder<T> {
  return reply<T>((value) => hasRecordFields(value, fields));
}

/** A record whose `field` is an array, typed `T`. */
export function recordWithArray<T>(field: string): Decoder<T> {
  return reply<T>((value) => isRecord(value) && Array.isArray(value[field]));
}

/** Organization project catalog snapshot, as the preload checks it. */
export interface CatalogSnapshot extends OrgProjectCatalogSnapshot {
  readonly stale: boolean;
  readonly error: 'unavailable' | 'offline' | 'access-changed' | null;
}

export function isOrgProjectCatalogSnapshot(
  value: unknown,
): value is CatalogSnapshot {
  return (
    isRecord(value) &&
    typeof value.context === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.fetchedAt === 'string' &&
    typeof value.stale === 'boolean' &&
    (value.error === null ||
      value.error === 'unavailable' ||
      value.error === 'offline' ||
      value.error === 'access-changed') &&
    Array.isArray(value.projects) &&
    value.projects.every(isOrgProjectSummary)
  );
}

export { isOrgProjectSetupProgress, isWorkspaceContextState };

const WORKSPACE_CONTEXT_CHANGE_REASONS = [
  'switch',
  'account-change',
  'departed',
  'organizations',
] as const;

export type WorkspaceContextChangeReason =
  (typeof WORKSPACE_CONTEXT_CHANGE_REASONS)[number];

export interface WorkspaceContextBroadcast extends WorkspaceContextState {
  readonly reason: WorkspaceContextChangeReason;
}

export function isWorkspaceContextBroadcast(
  value: unknown,
): value is WorkspaceContextBroadcast {
  return (
    isWorkspaceContextState(value) &&
    'reason' in value &&
    WORKSPACE_CONTEXT_CHANGE_REASONS.some((reason) => reason === value.reason)
  );
}

function hasTerminalRouteKeys(value: Record<string, unknown>): boolean {
  return (
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.terminalId === 'string'
  );
}

export function isTerminalOutputEvent(
  value: unknown,
): value is TerminalOutputEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) return false;
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) {
    return false;
  }
  // Structured clone and the remote codec both deliver bytes as Uint8Array.
  return value.data instanceof Uint8Array;
}

export function isTerminalExitEvent(
  value: unknown,
): value is TerminalExitEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) return false;
  const exitCodeOk =
    value.exitCode === null ||
    (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode));
  const signalOk = value.signal === null || typeof value.signal === 'string';
  return exitCodeOk && signalOk;
}

export function isTerminalRunningChangedEvent(
  value: unknown,
): value is TerminalRunningChangedEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) return false;
  if (typeof value.running !== 'boolean') return false;
  return value.processName === null || typeof value.processName === 'string';
}

/** A Zod-like schema: the protocol's reply schemas. */
export interface ReplySchema<T> {
  parse(value: unknown): T;
}

/** Decode through a protocol schema; a parse failure rejects like the preload. */
export function parsed<T>(schema: ReplySchema<T>, value: unknown): T {
  return schema.parse(value);
}
