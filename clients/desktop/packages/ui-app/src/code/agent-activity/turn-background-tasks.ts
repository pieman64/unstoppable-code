import type { BackgroundTaskKind } from '@canopy/protocol/background-tasks';

/** The tool uses one turn owns, keyed by that turn's stable id. */
export interface TurnToolUseOwnership {
  readonly turnKey: string;
  readonly toolUseIds: ReadonlySet<string>;
}

const EMPTY_BY_TURN: Readonly<Record<string, readonly never[]>> = {};

/**
 * Background Agent/Task launches already render in the transcript's dedicated
 * subagent block, so a second card in Agent activity would be redundant. The
 * Agent Background Processes panel still lists them.
 */
function isTranscriptSubagentKind(kind: BackgroundTaskKind): boolean {
  return kind === 'agent' || kind === 'task';
}

/**
 * Group background work under the turn whose tool use launched it.
 *
 * Deliberately cheap on the two paths that dominate: with no background work
 * (the overwhelmingly common case) it returns a shared empty record without
 * touching a single turn, and otherwise it resolves each turn's tool uses
 * through `resolveTurn`, which hosts back with an identity cache so a
 * streaming delta re-walks the streaming turn alone. Turns `resolveTurn`
 * returns null for (plain messages) are skipped.
 */
export function groupBackgroundWorkByTurn<
  TTurn,
  TItem extends { readonly kind: BackgroundTaskKind },
>(
  turns: readonly TTurn[],
  items: readonly TItem[],
  resolveTurn: (turn: TTurn) => TurnToolUseOwnership | null,
  ownerToolUseId: (item: TItem) => string | null,
): Readonly<Record<string, readonly TItem[]>> {
  if (items.length === 0) return EMPTY_BY_TURN;
  const candidates = items.filter(
    (item) => !isTranscriptSubagentKind(item.kind),
  );
  if (candidates.length === 0) return EMPTY_BY_TURN;

  const byTurn: Record<string, readonly TItem[]> = {};
  for (const turn of turns) {
    const ownership = resolveTurn(turn);
    if (!ownership || ownership.toolUseIds.size === 0) continue;
    const owned = candidates.filter((item) => {
      const toolUseId = ownerToolUseId(item);
      return toolUseId !== null && ownership.toolUseIds.has(toolUseId);
    });
    if (owned.length > 0) byTurn[ownership.turnKey] = owned;
  }
  return Object.keys(byTurn).length === 0 ? EMPTY_BY_TURN : byTurn;
}
