import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  composeCanopyInstructionRegistries,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/metadata-commands';
import { CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/guarded-commands';
import { CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS } from '@canopy/core-runtime/node/workspace/source-composition-commands';
import { createCoreWorkspaceMetadataAdapter } from '../../canopy-runtime/core-workspace-metadata-adapter';
import { createCoreWorkspaceGuardedAdapter } from '../../canopy-runtime/core-workspace-guarded-adapter';
import { createCoreSourceCompositionAdapter } from '../../canopy-runtime/core-source-composition-adapter';
import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';

/**
 * The registered `core.workspace.*` metadata commands (W7a), guarded
 * commands (W7b-1b) and keyed source, composition, rename and fork
 * lifecycles (W7b-4) over the desktop hosts, for IPC suites that stub the
 * rest of the dispatcher: their projections then run the host request the
 * handler is given, as in main.
 */
export function createWorkspaceMetadataTestDispatcher(): Pick<
  DesktopCanopyDispatcher,
  'instruction'
> {
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: composeCanopyInstructionRegistries(
        CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
        CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
        CORE_SOURCE_COMPOSITION_COMMAND_DEFINITIONS,
      ),
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: {
        ...createCoreWorkspaceMetadataAdapter().instructions,
        ...createCoreWorkspaceGuardedAdapter().instructions,
        // A projection never reaches a wire call's Git effect.
        ...createCoreSourceCompositionAdapter(undefined, () => {
          throw new Error('Unexpected wire lifecycle effect');
        }).instructions,
      },
      streams: {},
    },
  });
  // Only these names reach it; the projections name nothing else.
  const instruction: unknown = dispatcher.instruction.bind(dispatcher);
  return {
    instruction: instruction as DesktopCanopyDispatcher['instruction'],
  };
}

/** A trusted renderer caller, as `deriveDesktopIpcCaller` builds one. */
export const TEST_IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};
