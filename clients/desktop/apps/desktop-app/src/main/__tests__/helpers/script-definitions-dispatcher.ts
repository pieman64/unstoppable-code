import {
  CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  CORE_SCRIPT_DEFINITION_QUERIES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  createCoreScriptDefinitionHandlers,
  type CoreScriptDefinitionsHost,
} from '@canopy/core-runtime/node/script/core-script-definitions';
import { desktopScriptDefinitionsHost } from '../../lib/script-definition-host';

export const DESKTOP_SCRIPT_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

export type ScriptDefinitionsDispatcher = CanopyDispatcher<
  typeof CORE_SCRIPT_DEFINITION_QUERIES,
  typeof CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
  Record<never, never>
>;

/** `core.script.definition.*` over a host, by default the desktop one. */
export function scriptDefinitionsDispatcher(
  host: CoreScriptDefinitionsHost = desktopScriptDefinitionsHost,
): ScriptDefinitionsDispatcher {
  const handlers = createCoreScriptDefinitionHandlers(host);
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_SCRIPT_DEFINITION_QUERIES,
      instructions: CORE_SCRIPT_DEFINITION_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: handlers.queries,
      instructions: handlers.instructions,
      streams: {},
    },
  });
}
