import { createHash } from 'node:crypto';
import {
  CORE_WORKSPACE_ITEM_KINDS,
  type CoreWorkspaceItemKind,
} from '@canopy/protocol/canopy-core';

/*
 * The deterministic `core.workspace.item.*` ID shared by every item kind:
 * `<kind>:<workspaceId>[@<worktreeId>]:<key>`, each part percent-encoded
 * (which escapes `:`, `@` and `#`). `get` takes only the ID, so it carries
 * the scope. Each kind supplies its own name for the key: attachments their
 * file name, notes and prompts their stem. A key that would push the ID past
 * its bound becomes `#` plus a digest of the name, resolved by scanning the
 * store. A name a host lists but a key cannot carry (a POSIX `\`, say)
 * also takes the digest form, so every stored item stays addressable. Each
 * item has exactly one ID. IDs never hold host paths, and the requested
 * workspace ID is encoded as given.
 */

export interface CoreWorkspaceItemScope {
  readonly workspaceId: string;
  /** null addresses the workspace itself rather than one worktree. */
  readonly worktreeId: string | null;
}

export type CoreWorkspaceItemKey =
  | { readonly form: 'name'; readonly name: string }
  | { readonly form: 'digest'; readonly digest: string };

export interface CoreWorkspaceItemRef extends CoreWorkspaceItemScope {
  readonly kind: CoreWorkspaceItemKind;
  readonly key: CoreWorkspaceItemKey;
}

export const CORE_WORKSPACE_ITEM_ID_MAX_LENGTH = 512;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isKind(value: string): value is CoreWorkspaceItemKind {
  return CORE_WORKSPACE_ITEM_KINDS.some((kind) => kind === value);
}

/** A store-relative name a key may carry: one segment, never `.` or `..`. */
export function isWorkspaceItemName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

export function workspaceItemNameDigest(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('base64url');
}

function decodePart(part: string): string | null {
  try {
    const value = decodeURIComponent(part);
    // One spelling per ID: a non-canonical escape is a different ID.
    return encodeURIComponent(value) === part ? value : null;
  } catch {
    return null;
  }
}

function scopePrefix(
  kind: CoreWorkspaceItemKind,
  scope: CoreWorkspaceItemScope,
): string {
  const worktree =
    scope.worktreeId === null ? '' : `@${encodeURIComponent(scope.worktreeId)}`;
  return `${kind}:${encodeURIComponent(scope.workspaceId)}${worktree}:`;
}

type CoreWorkspaceItemIdInput = CoreWorkspaceItemScope & {
  readonly kind: CoreWorkspaceItemKind;
  readonly name: string;
};

/** The percent-encoded name, or null for a string with a lone surrogate. */
function encodeName(name: string): string | null {
  try {
    return encodeURIComponent(name);
  } catch {
    return null;
  }
}

function digestedId(input: CoreWorkspaceItemIdInput): string | null {
  const digested = `${scopePrefix(input.kind, input)}#${workspaceItemNameDigest(input.name)}`;
  return digested.length <= CORE_WORKSPACE_ITEM_ID_MAX_LENGTH ? digested : null;
}

/**
 * The item ID of a key name, or null when the name is not one a key may
 * carry or even the digest form exceeds the ID bound.
 */
export function encodeWorkspaceItemId(
  input: CoreWorkspaceItemIdInput,
): string | null {
  if (input.workspaceId === '' || input.worktreeId === '') return null;
  const encoded = isWorkspaceItemName(input.name)
    ? encodeName(input.name)
    : null;
  if (encoded === null) return null;
  const named = `${scopePrefix(input.kind, input)}${encoded}`;
  if (named.length <= CORE_WORKSPACE_ITEM_ID_MAX_LENGTH) return named;
  return digestedId(input);
}

/**
 * The item ID of a name the host listed from its store: spelled out as
 * {@link encodeWorkspaceItemId} does when it can be, otherwise the digest
 * form. Null only for an empty, `.` or `..` name or a scope too long for any
 * ID.
 */
export function encodeStoredWorkspaceItemId(
  input: CoreWorkspaceItemIdInput,
): string | null {
  if (input.workspaceId === '' || input.worktreeId === '') return null;
  if (input.name === '' || input.name === '.' || input.name === '..')
    return null;
  return encodeWorkspaceItemId(input) ?? digestedId(input);
}

export function decodeWorkspaceItemId(
  itemId: string,
): CoreWorkspaceItemRef | null {
  if (itemId.length > CORE_WORKSPACE_ITEM_ID_MAX_LENGTH) return null;
  const parts = itemId.split(':');
  if (parts.length !== 3) return null;
  const [kind, scopePart, keyPart] = parts;
  if (!isKind(kind)) return null;
  const scopeParts = scopePart.split('@');
  if (scopeParts.length > 2 || scopeParts.some((part) => part === ''))
    return null;
  const workspaceId = decodePart(scopeParts[0]);
  const worktreeId = scopeParts.length === 2 ? decodePart(scopeParts[1]) : null;
  if (workspaceId === null || (scopeParts.length === 2 && worktreeId === null))
    return null;
  let key: CoreWorkspaceItemKey;
  if (keyPart.startsWith('#')) {
    const digest = keyPart.slice(1);
    if (!DIGEST_PATTERN.test(digest)) return null;
    key = { form: 'digest', digest };
  } else {
    const name = decodePart(keyPart);
    if (name === null || !isWorkspaceItemName(name)) return null;
    // A name that fits is always spelled out, so each item has one ID.
    if (
      encodeWorkspaceItemId({ kind, workspaceId, worktreeId, name }) !== itemId
    )
      return null;
    key = { form: 'name', name };
  }
  return { kind, workspaceId, worktreeId, key };
}

/**
 * Whether a decoded key names this store-relative name. A digest key also
 * matches a name whose ID is spelled out; resolve stored items with
 * {@link workspaceItemRefMatches}, which accepts only the item's one ID.
 */
export function workspaceItemKeyMatches(
  key: CoreWorkspaceItemKey,
  name: string,
): boolean {
  return key.form === 'name'
    ? key.name === name
    : key.digest === workspaceItemNameDigest(name);
}

/**
 * Whether a decoded ID is the one ID of this stored name in the ref's scope
 * ({@link encodeStoredWorkspaceItemId}), so a digest never aliases a name
 * that is spelled out.
 */
export function workspaceItemRefMatches(
  ref: CoreWorkspaceItemRef,
  name: string,
): boolean {
  if (!workspaceItemKeyMatches(ref.key, name)) return false;
  const id = encodeStoredWorkspaceItemId({
    kind: ref.kind,
    workspaceId: ref.workspaceId,
    worktreeId: ref.worktreeId,
    name,
  });
  if (id === null) return false;
  const digested = id.charAt(scopePrefix(ref.kind, ref).length) === '#';
  return digested === (ref.key.form === 'digest');
}

/** Whether every item of this kind in the scope gets an ID within the bound. */
export function isAddressableWorkspaceItemScope(
  scope: CoreWorkspaceItemScope,
  kind: CoreWorkspaceItemKind,
): boolean {
  return (
    `${scopePrefix(kind, scope)}#${'k'.repeat(43)}`.length <=
    CORE_WORKSPACE_ITEM_ID_MAX_LENGTH
  );
}
