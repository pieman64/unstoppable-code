/*
 * Promotion and combine outcomes, decoded by hand with the projection of the
 * zod schemas they replaced (CAN-5200; see ./outcome-decoding). Object
 * literals list fields in shape order, so output key order and the first
 * reported field both follow the replaced shape.
 */
import {
  at,
  finiteNumber,
  flag,
  list,
  object,
  oneOf,
  optional,
  text,
  textRecord,
} from './outcome-decoding';
import {
  decodeW5WorktreeOutcomeAt,
  type W5WorktreeOutcome,
} from './worktree-outcome';

/**
 * The minimum a composition decoder must provide. A zod schema satisfies it,
 * so consumer-owned schemas plug in unchanged.
 */
export interface W5OutcomeParser<T> {
  /** Returns a fresh projection or throws for a refused outcome. */
  parse(outcome: unknown): T;
}

/** `core.workspace.composition.promote`'s saved outcome. */
export interface W5PromoteOutcome {
  id: string;
  type: 'multi-repo';
  name: string;
  color: string;
  order: number;
  collapsed?: boolean;
  temporary?: boolean;
  repos: Array<{ id: string; name: string }>;
  worktrees: W5WorktreeOutcome[];
}

export interface W5RepositoryMigrationOutcome {
  repoMappings: Array<{
    sourceRepoId?: string;
    destinationRepoId: string;
    repoName: string;
  }>;
  selectedRepoIdRewrites: Record<string, string>;
  sourceRootRepoIdRewrite?: string;
  removedTemporaryWorkspaceId?: string;
}

/** `core.workspace.composition.combine`'s saved workspace-variant outcome. */
export interface W5CombineOutcome extends W5RepositoryMigrationOutcome {
  sourceWorkspaceId: string;
  sourceWorktreeId: string;
  destinationWorkspaceId: string;
  destinationWorktreeId: string;
  destinationWorkspace: W5PromoteOutcome;
  destinationWorktree: W5WorktreeOutcome;
  createdTemporaryWorkspace: boolean;
  reusedWorkspace: boolean;
  removedSourceWorktree: boolean;
}

/** `core.workspace.composition.combine`'s saved existing-worktree outcome. */
export interface W5ExistingCombineOutcome extends W5CombineOutcome {
  joinedWorktree: W5RepositoryMigrationOutcome & {
    workspaceId: string;
    worktreeId: string;
  };
}

const WORKSPACE_TYPES = ['multi-repo'] as const;

function decodeRepository(
  value: unknown,
  path: string,
): { id: string; name: string } {
  const input = object(value, path);
  return {
    id: text(input.id, at(path, 'id')),
    name: text(input.name, at(path, 'name')),
  };
}

function decodeWorkspace(value: unknown, path: string): W5PromoteOutcome {
  const input = object(value, path);
  return {
    id: text(input.id, at(path, 'id')),
    type: oneOf(input.type, WORKSPACE_TYPES, at(path, 'type')),
    name: text(input.name, at(path, 'name')),
    color: text(input.color, at(path, 'color')),
    order: finiteNumber(input.order, at(path, 'order')),
    ...('collapsed' in input
      ? { collapsed: optional(input.collapsed, at(path, 'collapsed'), flag) }
      : {}),
    ...('temporary' in input
      ? { temporary: optional(input.temporary, at(path, 'temporary'), flag) }
      : {}),
    repos: list(input.repos, at(path, 'repos'), decodeRepository),
    worktrees: list(
      input.worktrees,
      at(path, 'worktrees'),
      decodeW5WorktreeOutcomeAt,
    ),
  };
}

function decodeRepositoryMapping(
  value: unknown,
  path: string,
): W5RepositoryMigrationOutcome['repoMappings'][number] {
  const input = object(value, path);
  return {
    ...('sourceRepoId' in input
      ? {
          sourceRepoId: optional(
            input.sourceRepoId,
            at(path, 'sourceRepoId'),
            text,
          ),
        }
      : {}),
    destinationRepoId: text(
      input.destinationRepoId,
      at(path, 'destinationRepoId'),
    ),
    repoName: text(input.repoName, at(path, 'repoName')),
  };
}

function decodeMigration(
  input: Record<string, unknown>,
  path: string,
): W5RepositoryMigrationOutcome {
  return {
    repoMappings: list(
      input.repoMappings,
      at(path, 'repoMappings'),
      decodeRepositoryMapping,
    ),
    selectedRepoIdRewrites: textRecord(
      input.selectedRepoIdRewrites,
      at(path, 'selectedRepoIdRewrites'),
    ),
    ...('sourceRootRepoIdRewrite' in input
      ? {
          sourceRootRepoIdRewrite: optional(
            input.sourceRootRepoIdRewrite,
            at(path, 'sourceRootRepoIdRewrite'),
            text,
          ),
        }
      : {}),
    ...('removedTemporaryWorkspaceId' in input
      ? {
          removedTemporaryWorkspaceId: optional(
            input.removedTemporaryWorkspaceId,
            at(path, 'removedTemporaryWorkspaceId'),
            text,
          ),
        }
      : {}),
  };
}

function decodeCombine(input: Record<string, unknown>): W5CombineOutcome {
  return {
    ...decodeMigration(input, ''),
    sourceWorkspaceId: text(input.sourceWorkspaceId, 'sourceWorkspaceId'),
    sourceWorktreeId: text(input.sourceWorktreeId, 'sourceWorktreeId'),
    destinationWorkspaceId: text(
      input.destinationWorkspaceId,
      'destinationWorkspaceId',
    ),
    destinationWorktreeId: text(
      input.destinationWorktreeId,
      'destinationWorktreeId',
    ),
    destinationWorkspace: decodeWorkspace(
      input.destinationWorkspace,
      'destinationWorkspace',
    ),
    destinationWorktree: decodeW5WorktreeOutcomeAt(
      input.destinationWorktree,
      'destinationWorktree',
    ),
    createdTemporaryWorkspace: flag(
      input.createdTemporaryWorkspace,
      'createdTemporaryWorkspace',
    ),
    reusedWorkspace: flag(input.reusedWorkspace, 'reusedWorkspace'),
    removedSourceWorktree: flag(
      input.removedSourceWorktree,
      'removedSourceWorktree',
    ),
  };
}

function decodeJoinedWorktree(
  value: unknown,
  path: string,
): W5ExistingCombineOutcome['joinedWorktree'] {
  const input = object(value, path);
  return {
    ...decodeMigration(input, path),
    workspaceId: text(input.workspaceId, at(path, 'workspaceId')),
    worktreeId: text(input.worktreeId, at(path, 'worktreeId')),
  };
}

/** Throws `W5OutcomeDecodeError` for an invalid outcome. */
export const w5PromoteOutcomeParser: W5OutcomeParser<W5PromoteOutcome> = {
  parse: (outcome) => decodeWorkspace(outcome, ''),
};

/** Throws `W5OutcomeDecodeError` for an invalid outcome. */
export const w5CombineOutcomeParser: W5OutcomeParser<W5CombineOutcome> = {
  parse: (outcome) => decodeCombine(object(outcome, '')),
};

/** Throws `W5OutcomeDecodeError` for an invalid outcome. */
export const w5ExistingCombineOutcomeParser: W5OutcomeParser<W5ExistingCombineOutcome> =
  {
    parse: (outcome) => {
      const input = object(outcome, '');
      return {
        ...decodeCombine(input),
        joinedWorktree: decodeJoinedWorktree(
          input.joinedWorktree,
          'joinedWorktree',
        ),
      };
    },
  };

/**
 * Live results decode to what their saved receipt replays: parse, JSON
 * round-trip, parse again, so caller transforms and passthrough fields apply
 * to the serialized form.
 */
export function decodeW5CompositionOutcome<T>(
  parser: W5OutcomeParser<T>,
  outcome: unknown,
): T {
  const serialized: unknown = JSON.parse(JSON.stringify(parser.parse(outcome)));
  return parser.parse(serialized);
}
