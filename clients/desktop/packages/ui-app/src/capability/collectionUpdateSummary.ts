import type {
  CollectionPluginRef,
  CollectionSkillRef,
  SharedCollectionDocument,
  SharedCollectionComparisonDetail,
} from '@canopy/protocol/collections';

/** The members of a local collection that an update summary compares. */
export interface CollectionLocalMembers {
  revision?: string;
  updatedAt?: string;
  skills: readonly CollectionSkillRef[];
  plugins: readonly CollectionPluginRef[];
}

export interface CollectionUpdateSummaryInput {
  localMembers?: CollectionLocalMembers;
  live?: SharedCollectionDocument;
  localCounts: { skills: number; plugins: number };
  liveCounts?: { skills: number; plugins: number };
  /** Collection sharer attribution, as displayed by the collection inventory. */
  sharerName?: string;
}

/** How a host loads the two sides of a collection update. */
export interface CollectionUpdatePorts {
  readonly contextKey?: string;
  readonly refreshKey?: string | number;
  readonly onRevisionMismatch?: () => void;
  loadLocalMembers: (
    collectionId: string,
  ) => Promise<CollectionLocalMembers | null>;
  loadSharedDocument: (
    remoteId: string,
  ) => Promise<SharedCollectionComparisonDetail | null>;
}

type MemberKind = 'skill' | 'plugin';

interface MemberChange {
  readonly verb: 'added' | 'removed';
  readonly kind: MemberKind;
  readonly name: string;
}

interface MemberIdentity {
  key: string;
  name: string;
  kind: MemberKind;
}

// Bundled source IDs are aliases for the single app-bundled skill namespace.
// If multiple bundled namespaces are introduced, preserve their identities here
// and in liveIdentities instead of folding them into builtin:app.
function localIdentities(
  local: CollectionLocalMembers,
): MemberIdentity[] | null {
  // Imported custom skills need provenance that these refs do not carry. Never
  // guess their identity from a display name or remove a legitimate suffix.
  if (
    local.skills.some(
      (ref) =>
        ref.sourceId !== 'builtin' &&
        !/^builtin[:/][^:/]+$/.test(ref.sourceId) &&
        !/^(github:[^:]+:[^:]+|builtin:[^:]+)$/.test(ref.sourceId),
    )
  )
    return null;
  return [
    ...local.skills.map(
      (ref): MemberIdentity => ({
        key: JSON.stringify([
          'skill',
          ref.sourceId === 'builtin' || /^builtin[:/][^:/]+$/.test(ref.sourceId)
            ? 'builtin:app'
            : ref.sourceId,
          ref.skillName,
        ]),
        name: ref.skillName,
        kind: 'skill',
      }),
    ),
    ...local.plugins.map(
      (ref): MemberIdentity => ({
        key: JSON.stringify(['plugin', ref.marketplaceId, ref.pluginName]),
        name: ref.pluginName,
        kind: 'plugin',
      }),
    ),
  ];
}

function liveIdentities(
  live: SharedCollectionDocument,
): MemberIdentity[] | null {
  if (live.items.some((item) => item.type === 'custom_skill')) return null;
  return live.items.flatMap((item): MemberIdentity[] => {
    if (item.type === 'custom_skill') return [];
    if (item.type === 'skill') {
      const source =
        item.source.type === 'github'
          ? `github:${item.source.repo.replace(/\//g, ':')}`
          : 'builtin:app';
      return [
        {
          key: JSON.stringify(['skill', source, item.skill_name]),
          name: item.skill_name,
          kind: 'skill',
        },
      ];
    }
    const source =
      item.marketplace.type === 'github'
        ? item.marketplace.repo
        : item.marketplace.type === 'builtin'
          ? `builtin/${item.marketplace.id}`
          : item.marketplace.id;
    return [
      {
        key: JSON.stringify(['plugin', source, item.plugin_name]),
        name: item.plugin_name,
        kind: 'plugin',
      },
    ];
  });
}

function memberChanges(
  local: CollectionLocalMembers,
  live: SharedCollectionDocument,
): MemberChange[] | null {
  const before = localIdentities(local);
  const after = liveIdentities(live);
  if (!before || !after) return null;
  const oldMembers = new Map(before.map((member) => [member.key, member]));
  const newMembers = new Map(after.map((member) => [member.key, member]));
  const changes: MemberChange[] = [
    ...[...newMembers.values()]
      .filter((member) => !oldMembers.has(member.key))
      .map(
        (member): MemberChange => ({
          verb: 'added',
          kind: member.kind,
          name: member.name,
        }),
      ),
    ...[...oldMembers.values()]
      .filter((member) => !newMembers.has(member.key))
      .map(
        (member): MemberChange => ({
          verb: 'removed',
          kind: member.kind,
          name: member.name,
        }),
      ),
  ];
  // Same display name with different source identities cannot be explained by
  // a named summary. Case/whitespace aliases are likewise not exact matches.
  const labels = changes.map(
    (member) => `${member.kind}:${member.name.trim().toLowerCase()}`,
  );
  return new Set(labels).size === labels.length ? changes : null;
}

function countLabel(count: number, kind: MemberKind): string {
  return `${count} ${kind}${count === 1 ? '' : 's'}`;
}

function describeChanges(changes: readonly MemberChange[]): string {
  const [only] = changes;
  if (changes.length === 1 && only) {
    return `${only.verb} the ${only.name.trim()} ${only.kind}`;
  }
  const clauses: string[][] = [];
  for (const verb of ['added', 'removed'] as const) {
    const kinds = (['skill', 'plugin'] as const)
      .map((kind) => ({
        kind,
        count: changes.filter((c) => c.verb === verb && c.kind === kind).length,
      }))
      .filter(({ count }) => count > 0)
      .map(({ kind, count }) => countLabel(count, kind));
    if (kinds.length) clauses.push([verb, kinds.join(' and ')]);
  }
  const parts = clauses.map((clause) => clause.join(' '));
  // Two verbs that each list two kinds read better split by a comma.
  return parts.join(
    clauses.every((clause) => !clause[1]?.includes(' and ')) ? ' and ' : ', ',
  );
}

/**
 * Describe observed membership changes and attribute them to the collection
 * sharer. Aggregate totals cannot prove changed-item counts.
 */
export function summarizeCollectionUpdate(
  input: CollectionUpdateSummaryInput,
): string {
  if (input.localMembers && input.live) {
    const changes = memberChanges(input.localMembers, input.live);
    if (changes?.length) {
      const phrase = describeChanges(changes);
      const sharer = input.sharerName?.trim();
      return sharer
        ? `${sharer} ${phrase}`
        : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
    }
  }
  return 'Changed the collection';
}
