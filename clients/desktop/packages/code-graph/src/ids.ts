import { createHash } from 'node:crypto';

export function canonicalRelativePath(relativePath: string): string {
  let normalized = relativePath.replace(/\\/g, '/').normalize('NFC');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function fileQualifiedName(relativePath: string): string {
  return canonicalRelativePath(relativePath);
}

// Qualified names are `path::Member.path` — split on the FIRST `::` only
// (member paths can't contain `::` today, but splitting on the first
// occurrence is the safe contract if that ever changes) and canonicalize just
// the path head. A string with no `::` is treated as a bare path and
// canonicalized whole, so this is also safe to call on plain relative paths.
export function canonicalQualifiedName(qualifiedName: string): string {
  const separatorIndex = qualifiedName.indexOf('::');
  if (separatorIndex === -1) {
    return canonicalRelativePath(qualifiedName);
  }
  const pathHead = qualifiedName.slice(0, separatorIndex);
  const memberPath = qualifiedName.slice(separatorIndex + 2);
  return `${canonicalRelativePath(pathHead)}::${memberPath}`;
}

export function symbolQualifiedName(
  relativePath: string,
  ancestors: readonly string[],
  name: string,
): string {
  const memberPath = [...ancestors, name].join('.');
  return `${canonicalRelativePath(relativePath)}::${memberPath}`;
}

// Truncated (32 hex char / 128 bit) sha256 over a sequence of parts, each
// terminated by a newline separator so e.g. ['ab', 'c'] and ['a', 'bc'] hash
// differently. Shared by every `*RowId` helper below plus `communityRowId`/
// `communityFingerprint` (analysis/communities.ts's stable-id fingerprint),
// so there is exactly one hashing implementation to keep in lockstep.
function rawHash(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

function hashedId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${rawHash(parts)}`;
}

export function repositoryRowId(repoId: string): string {
  return hashedId('repo', [repoId]);
}

export function fileRowId(repoId: string, relativePath: string): string {
  return hashedId('file', [repoId, canonicalRelativePath(relativePath)]);
}

export function symbolRowId(repoId: string, qualifiedName: string): string {
  return hashedId('sym', [repoId, qualifiedName]);
}

export function edgeRowId(input: {
  repoId: string;
  kind: string;
  sourceId: string;
  target: string;
  line: number | null;
}): string {
  return hashedId('edge', [
    input.repoId,
    input.kind,
    input.sourceId,
    input.target,
    input.line === null ? '' : String(input.line),
  ]);
}

// A community's fingerprint is the raw hash of its SORTED member symbol ids
// (caller sorts — this function does not, so the same member set always
// hashes the same way regardless of iteration order). Used both as the
// `CodeGraphCommunityRecord.fingerprint` column value and, via
// `communityRowId`, as the basis for a freshly-minted community id when
// stable-id retention finds no sufficiently-overlapping previous community
// (see analysis/communities.ts).
export function communityFingerprint(
  sortedMemberSymbolIds: readonly string[],
): string {
  return rawHash(sortedMemberSymbolIds);
}

export function communityRowId(fingerprint: string): string {
  return `com_${fingerprint}`;
}

// A flow's id is minted directly from its (repoId, entry symbol id) pair --
// unlike communities, flows have no stable-id retention problem to solve
// (an entry point's identity IS the flow's identity across runs), so there
// is no separate fingerprint/rowId split the way communities has. Reuses the
// same `hashedId` helper (and therefore the same `rawHash` newline-joined
// hashing) as every other `*RowId` function above, so `flow_` ids are minted
// with the one shared hashing implementation, not a duplicated one (see
// analysis/flows.ts).
export function flowRowId(repoId: string, entrySymbolId: string): string {
  return hashedId('flow', [repoId, entrySymbolId]);
}
