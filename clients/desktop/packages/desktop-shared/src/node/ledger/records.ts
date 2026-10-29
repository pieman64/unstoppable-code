import {
  LEDGER_ACTOR_KINDS,
  LedgerEntrySchema,
  type LedgerActorKind,
  type LedgerContainer,
  type LedgerEntry,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from './errors';
import {
  parseStoredJson,
  rowInteger,
  rowNullableText,
  rowText,
  type LedgerSqlRow,
} from './rows';
import {
  LEDGER_SCOPE_LIFECYCLE_STATES,
  type LedgerActorRecord,
  type LedgerScopeLifecycleState,
  type LedgerScopeRecord,
} from './types';

/** A structural stand-in for a protocol schema's `safeParse`. */
interface LedgerParseIssue {
  readonly path: readonly PropertyKey[];
}

type LedgerParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | {
      readonly success: false;
      readonly error: { readonly issues: readonly LedgerParseIssue[] };
    };

export interface LedgerParser<Output> {
  safeParse(value: unknown): LedgerParseResult<Output>;
}

function issueField(
  prefix: string,
  issue: LedgerParseIssue | undefined,
): string {
  const path = (issue?.path ?? []).map((segment: PropertyKey): string =>
    String(segment),
  );
  return [prefix, ...path]
    .filter((part: string): boolean => part !== '')
    .join('.');
}

/**
 * Validates caller input with a protocol schema. Failures report the first
 * offending field under `prefix` as `INVALID_INPUT`.
 */
export function parseLedgerInput<Output>(
  parser: LedgerParser<Output>,
  value: unknown,
  prefix: string,
): Output {
  const result = parser.safeParse(value);
  if (result.success) return result.data;
  return failInput(prefix, result.error.issues[0]);
}

function failInput(prefix: string, issue: LedgerParseIssue | undefined): never {
  throw new LedgerStoreError('INVALID_INPUT', {
    field: issueField(prefix, issue),
  });
}

/** Parses stored JSON with a protocol schema; failure is a storage fault. */
export function parseStoredRecord<Output>(
  parser: LedgerParser<Output>,
  json: string,
): Output {
  const result = parser.safeParse(parseStoredJson(json));
  if (result.success) return result.data;
  throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
    diagnosticCode: 'malformed_record',
  });
}

export function parseStoredEntry(json: string): LedgerEntry {
  return parseStoredRecord(LedgerEntrySchema, json);
}

/** Identity columns of a container tuple. */
export interface LedgerContainerColumns {
  readonly kind: LedgerContainer['kind'];
  readonly parentId: string;
  readonly itemId: string;
}

export function toContainerColumns(
  container: LedgerContainer,
): LedgerContainerColumns {
  switch (container.kind) {
    case 'code_worktree':
      return {
        kind: container.kind,
        parentId: container.workspaceId,
        itemId: container.worktreeId,
      };
    case 'cowork_entry':
      return {
        kind: container.kind,
        parentId: container.workspaceId,
        itemId: container.entryId,
      };
    case 'advisor_entry':
      return {
        kind: container.kind,
        parentId: container.appWorkspaceId,
        itemId: container.entryId,
      };
  }
}

function malformedScope(): LedgerStoreError {
  return new LedgerStoreError('STORAGE_UNAVAILABLE', {
    diagnosticCode: 'malformed_scope',
  });
}

function fromContainerColumns(
  kind: string,
  parentId: string,
  itemId: string,
): LedgerContainer {
  switch (kind) {
    case 'code_worktree':
      return { kind, workspaceId: parentId, worktreeId: itemId };
    case 'cowork_entry':
      return { kind, workspaceId: parentId, entryId: itemId };
    case 'advisor_entry':
      if (parentId !== 'app-advisor') throw malformedScope();
      return { kind, appWorkspaceId: parentId, entryId: itemId };
    default:
      throw malformedScope();
  }
}

function lifecycleState(value: string): LedgerScopeLifecycleState {
  const state = LEDGER_SCOPE_LIFECYCLE_STATES.find(
    (candidate: LedgerScopeLifecycleState): boolean => candidate === value,
  );
  if (state === undefined) throw malformedScope();
  return state;
}

function actorKind(value: string): LedgerActorKind {
  const kind = LEDGER_ACTOR_KINDS.find(
    (candidate: LedgerActorKind): boolean => candidate === value,
  );
  if (kind === undefined) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'malformed_actor',
    });
  }
  return kind;
}

/** Columns selected for every scope read. */
export const LEDGER_SCOPE_COLUMNS =
  'ledger_id, authority_id, container_kind, container_parent_id, container_item_id, container_created_at, account_id, lifecycle_state, sequence, created_at';

/** A scope row with its sequence as a number for arithmetic. */
export interface LedgerScopeState {
  readonly ledgerId: string;
  readonly sequence: number;
  readonly record: LedgerScopeRecord;
}

export function scopeFromRow(row: LedgerSqlRow): LedgerScopeState {
  const ledgerId = rowText(row, 'ledger_id');
  const sequence = rowInteger(row, 'sequence');
  return {
    ledgerId,
    sequence,
    record: {
      scope: {
        ledgerId,
        authorityId: rowText(row, 'authority_id'),
        container: fromContainerColumns(
          rowText(row, 'container_kind'),
          rowText(row, 'container_parent_id'),
          rowText(row, 'container_item_id'),
        ),
      },
      containerCreatedAt: rowText(row, 'container_created_at'),
      accountId: rowNullableText(row, 'account_id'),
      lifecycleState: lifecycleState(rowText(row, 'lifecycle_state')),
      sequence: String(sequence),
      createdAt: rowText(row, 'created_at'),
    },
  };
}

/** Columns selected for every actor read. */
export const LEDGER_ACTOR_COLUMNS =
  'actor_id, ledger_id, kind, authority_id, origin_key, display_name, created_at';

export function actorFromRow(row: LedgerSqlRow): LedgerActorRecord {
  return {
    actor: {
      actorId: rowText(row, 'actor_id'),
      kind: actorKind(rowText(row, 'kind')),
      authorityId: rowText(row, 'authority_id'),
    },
    ledgerId: rowText(row, 'ledger_id'),
    originKey: rowText(row, 'origin_key'),
    displayName: rowText(row, 'display_name'),
    createdAt: rowText(row, 'created_at'),
  };
}
