/*
 * The portable worktree row in W5 outcomes, decoded by hand so core needs no
 * schema library. It accepts and refuses what the zod schemas it replaced
 * (CAN-5199) did, with the same projection: output keys in shape order,
 * unknown keys stripped, and an optional key kept, even as undefined, exactly
 * when it is present in the input. Saved receipts therefore decode, and live
 * results serialize, to the same values and bytes.
 */
import {
  at,
  flag,
  object,
  oneOf,
  optional,
  text,
  textList,
  textRecord,
} from './outcome-decoding';

export { W5OutcomeDecodeError } from './outcome-decoding';

const BRANCH_GROUPING_OVERRIDES = ['group', 'ungroup'] as const;
const SETUP_PHASES = ['git-pending', 'git-ready'] as const;

/** Portable row fields returned by keyed metadata commands; never host journals. */
export interface W5WorktreeOutcome {
  id: string;
  branchName: string;
  createdAt: string;
  label?: string;
  hidden?: boolean;
  pinned?: boolean;
  branchGroupingOverride?: (typeof BRANCH_GROUPING_OVERRIDES)[number];
  branchGroupingParentWorktreeId?: string;
  trackedBaseBranch?: string | null;
  trackedRepoBaseBranches?: Record<string, string>;
  includedRepoIds?: string[];
  setupPhase?: (typeof SETUP_PHASES)[number];
}

/** `core.worktree.update`'s saved outcome. */
export interface W5WorktreeUpdateOutcome {
  worktree: W5WorktreeOutcome;
  changed: boolean;
}

/** `core.worktree.branch.rename`'s saved outcome; a null row is a missing row. */
export interface W5WorktreeBranchRenameOutcome {
  branchName: string;
  worktree: W5WorktreeOutcome | null;
}

export interface W5WorktreeHooksPausedRow extends W5WorktreeOutcome {
  pausedHookKeys?: string[];
}

/** `core.worktree.hooks.setPaused`'s saved outcome. */
export interface W5WorktreeHooksPausedOutcome {
  worktree: W5WorktreeHooksPausedRow;
  pausedHookKeys: string[];
  changed: boolean;
}

function decodeRow(
  input: Record<string, unknown>,
  path: string,
): W5WorktreeOutcome {
  const row: W5WorktreeOutcome = {
    id: text(input.id, at(path, 'id')),
    branchName: text(input.branchName, at(path, 'branchName')),
    createdAt: text(input.createdAt, at(path, 'createdAt')),
  };
  if ('label' in input)
    row.label = optional(input.label, at(path, 'label'), text);
  if ('hidden' in input)
    row.hidden = optional(input.hidden, at(path, 'hidden'), flag);
  if ('pinned' in input)
    row.pinned = optional(input.pinned, at(path, 'pinned'), flag);
  if ('branchGroupingOverride' in input)
    row.branchGroupingOverride = optional(
      input.branchGroupingOverride,
      at(path, 'branchGroupingOverride'),
      (value, valuePath) => oneOf(value, BRANCH_GROUPING_OVERRIDES, valuePath),
    );
  if ('branchGroupingParentWorktreeId' in input)
    row.branchGroupingParentWorktreeId = optional(
      input.branchGroupingParentWorktreeId,
      at(path, 'branchGroupingParentWorktreeId'),
      text,
    );
  if ('trackedBaseBranch' in input)
    row.trackedBaseBranch = optional(
      input.trackedBaseBranch,
      at(path, 'trackedBaseBranch'),
      (value, valuePath) => (value === null ? null : text(value, valuePath)),
    );
  if ('trackedRepoBaseBranches' in input)
    row.trackedRepoBaseBranches = optional(
      input.trackedRepoBaseBranches,
      at(path, 'trackedRepoBaseBranches'),
      textRecord,
    );
  if ('includedRepoIds' in input)
    row.includedRepoIds = optional(
      input.includedRepoIds,
      at(path, 'includedRepoIds'),
      textList,
    );
  if ('setupPhase' in input)
    row.setupPhase = optional(
      input.setupPhase,
      at(path, 'setupPhase'),
      (value, valuePath) => oneOf(value, SETUP_PHASES, valuePath),
    );
  return row;
}

/** A row nested at `path` in another outcome. */
export function decodeW5WorktreeOutcomeAt(
  value: unknown,
  path: string,
): W5WorktreeOutcome {
  return decodeRow(object(value, path), path);
}

/** Throws {@link W5OutcomeDecodeError} for an invalid row. */
export function decodeW5WorktreeOutcome(value: unknown): W5WorktreeOutcome {
  return decodeW5WorktreeOutcomeAt(value, '');
}

/** Throws {@link W5OutcomeDecodeError} for an invalid outcome. */
export function decodeW5WorktreeUpdateOutcome(
  value: unknown,
): W5WorktreeUpdateOutcome {
  const input = object(value, '');
  return {
    worktree: decodeW5WorktreeOutcomeAt(input.worktree, 'worktree'),
    changed: flag(input.changed, 'changed'),
  };
}

/** Throws {@link W5OutcomeDecodeError} for an invalid outcome. */
export function decodeW5WorktreeBranchRenameOutcome(
  value: unknown,
): W5WorktreeBranchRenameOutcome {
  const input = object(value, '');
  return {
    branchName: text(input.branchName, 'branchName'),
    worktree:
      input.worktree === null
        ? null
        : decodeW5WorktreeOutcomeAt(input.worktree, 'worktree'),
  };
}

/** Throws {@link W5OutcomeDecodeError} for an invalid outcome. */
export function decodeW5WorktreeHooksPausedOutcome(
  value: unknown,
): W5WorktreeHooksPausedOutcome {
  const input = object(value, '');
  const rowInput = object(input.worktree, 'worktree');
  const worktree: W5WorktreeHooksPausedRow = decodeRow(rowInput, 'worktree');
  if ('pausedHookKeys' in rowInput)
    worktree.pausedHookKeys = optional(
      rowInput.pausedHookKeys,
      'worktree.pausedHookKeys',
      textList,
    );
  return {
    worktree,
    pausedHookKeys: textList(input.pausedHookKeys, 'pausedHookKeys'),
    changed: flag(input.changed, 'changed'),
  };
}
