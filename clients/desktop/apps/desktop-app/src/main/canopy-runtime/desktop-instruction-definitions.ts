import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  type WorkerFilesystemEntryInstructionDefinitions,
} from '@canopy/protocol/canopy-core';

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
 * the entry instructions (CAN-5502), plus the two write instructions.
 * Composing throws on a name both maps define, so a registry that later gains
 * one of these fails at startup instead of serving two definitions.
 */
export const DESKTOP_INSTRUCTION_DEFINITIONS =
  composeCanopyInstructionRegistries(
    CANOPY_INSTRUCTION_DEFINITIONS,
    DESKTOP_WRITE_INSTRUCTION_DEFINITIONS,
  );

export type DesktopInstructionDefinitions =
  typeof DESKTOP_INSTRUCTION_DEFINITIONS;

/** The write and entry instructions the mutation adapter handles. */
export type DesktopMutationInstructionDefinitions =
  typeof DESKTOP_WRITE_INSTRUCTION_DEFINITIONS &
    WorkerFilesystemEntryInstructionDefinitions;
