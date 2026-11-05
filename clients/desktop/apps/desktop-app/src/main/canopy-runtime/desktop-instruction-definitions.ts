import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  type WorkerFilesystemEntryInstructionDefinitions,
} from '@canopy/protocol/canopy-core';
import { CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/metadata-commands';
import { CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import { CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/guarded-commands';
import { CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/source-composition-commands';

/**
 * The CAN-4159 write instructions this dispatcher serves (CAN-4100), each the
 * write registry's own definition object, never a copy. The daemon profile
 * does not admit these until CAN-4100's registration follow-up. Served keyed
 * with no retained outcome, accepted debt until CAN-4733 (q-14 D3).
 */
const DESKTOP_WRITE_INSTRUCTION_DEFINITIONS = {
  'worker.filesystem.file.write':
    WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS[
      'worker.filesystem.file.write'
    ],
  'worker.filesystem.directory.create':
    WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS[
      'worker.filesystem.directory.create'
    ],
};

/**
 * The desktop dispatcher's instructions: the composed registry, which carries
 * the entry instructions (CAN-5502), plus the two write instructions, the
 * W5 metadata commands (W7a, DM-1: the in-process dispatcher only; the
 * daemon composes them in W7a-3), the lifecycle commands (W7b-3 creates
 * and W7b-2a archive, delete and restore; D-1(a): the in-process dispatcher
 * only), the guarded W5 commands (W7b-1b/1c, D-1(a): the in-process
 * dispatcher only, over the Electron boundaries of W5d2's M-1(a)) and
 * the keyed source, composition, rename and fork lifecycles (W7b-4,
 * D-1(a): this dispatcher only, whose handlers call the Electron boundaries).
 * Composing throws on a name two maps define, so a registry that later
 * gains one of these fails at startup instead of serving two definitions.
 */
export const DESKTOP_INSTRUCTION_DEFINITIONS =
  composeCanopyInstructionRegistries(
    CANOPY_INSTRUCTION_DEFINITIONS,
    WORKER_AGENT_HELPER_INSTRUCTION_DEFINITIONS,
    DESKTOP_WRITE_INSTRUCTION_DEFINITIONS,
    CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
    CORE_WORKSPACE_LIFECYCLE_COMMAND_DEFINITIONS,
    CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
    CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
  );

export type DesktopInstructionDefinitions =
  typeof DESKTOP_INSTRUCTION_DEFINITIONS;

/** The write and entry instructions the mutation adapter handles. */
export type DesktopMutationInstructionDefinitions =
  typeof DESKTOP_WRITE_INSTRUCTION_DEFINITIONS &
    WorkerFilesystemEntryInstructionDefinitions;
