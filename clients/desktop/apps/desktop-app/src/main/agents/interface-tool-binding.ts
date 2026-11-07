import type { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { AssistantMode } from '@canopy/desktop-shared/types';

let sessionRegistry: InterfaceToolRegistry | null = null;

const APP_ADVISOR_INTERFACE_TOOLS: ReadonlySet<InterfaceToolName> = new Set([
  'ui.app_advisor.present',
  'ui.app_advisor.show_files',
  'ui.get_current_ui_state',
  'ui.show_files',
]);

/** Set by the desktop runtime when it builds the registry; null after disposal. Avoids importing desktop-runtime here. */
export function setSessionInterfaceToolRegistry(
  registry: InterfaceToolRegistry | null,
): void {
  sessionRegistry = registry;
}

export function getSessionInterfaceToolRegistry(): InterfaceToolRegistry | null {
  return sessionRegistry;
}

/** D12: the catalog tools a session of this kind binds now, sorted. Empty without a registry. */
export function resolveSessionInterfaceTools(opts: {
  assistantMode?: AssistantMode;
}): readonly InterfaceToolName[] {
  const live = sessionRegistry?.available().toolNames ?? [];
  switch (opts.assistantMode) {
    case 'app-advisor':
      return live
        .filter((name) => APP_ADVISOR_INTERFACE_TOOLS.has(name))
        .sort();
    case 'pipeline-editor':
      return [];
    default:
      return live.filter((name) => name === 'ui.show_files');
  }
}

/** Sorted names joined by ','; '' for none or undefined. */
export function interfaceToolsSignature(
  tools: readonly InterfaceToolName[] | undefined,
): string {
  return [...(tools ?? [])].sort().join(',');
}

export function hasInterfaceTool(
  tools: readonly InterfaceToolName[] | undefined,
  name: InterfaceToolName,
): boolean {
  return tools?.includes(name) ?? false;
}
