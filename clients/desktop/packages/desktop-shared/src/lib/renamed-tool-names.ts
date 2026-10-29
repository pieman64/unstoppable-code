// ---------------------------------------------------------------------------
// The app's own tools that were renamed while approval rules saved under the
// old name may still exist. Pure: no Node/Electron imports, no IO, so the
// approval engine can use it. The brand is read on the first lookup, never at
// import, so importing the approval engine does not need a complete brand.
// ---------------------------------------------------------------------------

import { BRAND } from '@canopy/brand/current';

type Rename = readonly [before: string, now: string];

/** The Agent Ledger tools' display names before and after they took the Feed's. */
const DISPLAY_NAME_RENAMES: readonly Rename[] = [
  ['AddLedgerEntry', 'AddFeedEntry'],
  ['SearchLedgerEntries', 'SearchFeedEntries'],
  ['UpdateLedgerEntry', 'UpdateFeedEntry'],
];

/** The same renames in the snake case Codex tool names end with. */
const CODEX_NAME_RENAMES: readonly Rename[] = [
  ['add_ledger_entry', 'add_feed_entry'],
  ['search_ledger_entries', 'search_feed_entries'],
  ['update_ledger_entry', 'update_feed_entry'],
];

const RENAMED_ENDINGS: readonly string[] = [
  ...DISPLAY_NAME_RENAMES,
  ...CODEX_NAME_RENAMES,
].flat();

/**
 * The name each renamed tool had before, mapped to the one it has now, for
 * every name a provider calls it by on the worktree and App Advisor servers:
 * Claude's `mcp__<server>__<Name>`, Cursor's `<server>: <Name>` and Codex's
 * `<server>_<name>`. The approval engine's tests check these against the
 * names the tool registries advertise.
 */
function buildCurrentNameByNameBeforeRename(): ReadonlyMap<string, string> {
  const namespace = BRAND.tools.namespace;
  const renames = new Map<string, string>();
  for (const server of [namespace, `${namespace}_app_advisor`]) {
    for (const [before, now] of DISPLAY_NAME_RENAMES) {
      renames.set(`mcp__${server}__${before}`, `mcp__${server}__${now}`);
      renames.set(`${server}: ${before}`, `${server}: ${now}`);
    }
    for (const [before, now] of CODEX_NAME_RENAMES) {
      renames.set(`${server}_${before}`, `${server}_${now}`);
    }
  }
  return renames;
}

let currentNameByNameBeforeRename: ReadonlyMap<string, string> | undefined;

/**
 * The name the app's own tool has today, given a name it has or had. Any
 * other name, including the same tool name on a server that is not the app's,
 * is returned unchanged.
 */
export function currentNameOfRenamedTool(toolName: string): string {
  if (!RENAMED_ENDINGS.some((ending) => toolName.endsWith(ending))) {
    return toolName;
  }
  currentNameByNameBeforeRename ??= buildCurrentNameByNameBeforeRename();
  return currentNameByNameBeforeRename.get(toolName) ?? toolName;
}
