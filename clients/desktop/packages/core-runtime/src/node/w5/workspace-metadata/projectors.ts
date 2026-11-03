import {
  at,
  flag,
  object,
  oneOf,
  optional,
  text,
  textList,
} from '../outcome-decoding';
import type { W5OutcomeParser } from '../composition-outcome';
import type {
  WorkspaceMetadataUpdateOutcome,
  WorkspaceReorderOutcome,
} from './metadata';
import type { WorkspacePrivateMemoryUpdateOutcome } from './private-memory';
import type {
  WorkspaceRepositoryAddOutcome,
  WorkspaceRepositoryRemoveOutcome,
} from './repositories';

/*
 * The hosted metadata commands' stored outcome decoders (W5d1,
 * CAN-5522). A stored outcome keeps the desktop's version 1 shape, so the
 * same label decodes the same way on either host; it is host-local, and a
 * repository's `repoPath` stays in it (DQ-7 reading (i)). The first response and
 * every replay map the same decoded value to the wire result (RR4), which
 * carries no host path. An update's version 2 outcome (W7a, DM-2) adds the
 * workspace its decision left.
 */

export const w5MetadataUpdateOutcome: W5OutcomeParser<WorkspaceMetadataUpdateOutcome> =
  {
    parse: (outcome) => {
      const value = object(outcome, '');
      return {
        workspaceId: text(value.workspaceId, 'workspaceId'),
        indexWritten: flag(value.indexWritten, 'indexWritten'),
        manifestWritten: flag(value.manifestWritten, 'manifestWritten'),
        // Version 2 (W7a): the decided workspace, decoded by the wire result.
        ...(value.workspace !== undefined && { workspace: value.workspace }),
      };
    },
  };

export const w5ReorderOutcome: W5OutcomeParser<WorkspaceReorderOutcome> = {
  parse: (outcome) => ({
    workspaceIds: textList(object(outcome, '').workspaceIds, 'workspaceIds'),
  }),
};

export const w5PrivateMemoryOutcome: W5OutcomeParser<WorkspacePrivateMemoryUpdateOutcome> =
  {
    parse: (outcome) => {
      const value = object(outcome, '');
      return {
        workspaceId: text(value.workspaceId, 'workspaceId'),
        privateMemory: flag(value.privateMemory, 'privateMemory'),
      };
    },
  };

/** The desktop's repository outcome schema: these fields, extra ones kept. */
function storedRepository(
  outcome: unknown,
  path: string,
): WorkspaceRepositoryAddOutcome {
  const value = object(outcome, path);
  const source = optional(value.source, at(path, 'source'), (item, where) =>
    oneOf(item, ['local', 'manifest'] as const, where),
  );
  const manifestUrl = optional(
    value.manifestUrl,
    at(path, 'manifestUrl'),
    text,
  );
  const scriptActionsOperationId = optional(
    value.scriptActionsOperationId,
    at(path, 'scriptActionsOperationId'),
    text,
  );
  return {
    ...value,
    id: text(value.id, at(path, 'id')),
    name: text(value.name, at(path, 'name')),
    repoPath: text(value.repoPath, at(path, 'repoPath')),
    ...(source !== undefined && { source }),
    ...(manifestUrl !== undefined && { manifestUrl }),
    ...(scriptActionsOperationId !== undefined && { scriptActionsOperationId }),
  };
}

export const w5RepositoryAddOutcome: W5OutcomeParser<WorkspaceRepositoryAddOutcome> =
  { parse: (outcome) => storedRepository(outcome, '') };

export const w5RepositoryRemoveOutcome: W5OutcomeParser<WorkspaceRepositoryRemoveOutcome> =
  {
    parse: (outcome) => {
      const removed = object(outcome, '').removed;
      return {
        removed: removed === null ? null : storedRepository(removed, 'removed'),
      };
    },
  };
