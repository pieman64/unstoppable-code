import type { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { AssistantMode } from '@canopy/desktop-shared/types';

let sessionRegistry: InterfaceToolRegistry | null = null;
let audienceResolver: ((chatId: string) => string | null) | null = null;

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

/** Set by remote control: the controller driving a chat, or null for this computer. */
export function setInterfaceToolAudienceResolver(
  resolver: ((chatId: string) => string | null) | null,
): void {
  audienceResolver = resolver;
}

/**
 * CAN-5823: whose windows serve this chat now: undefined for this computer's
 * own, or the device id of the connected computer driving it. Resolved at
 * each call, so a chat never reaches the windows of a former driver.
 */
export function interfaceToolAudience(
  chatId: string | undefined,
): string | undefined {
  if (chatId === undefined) return undefined;
  return audienceResolver?.(chatId) ?? undefined;
}

/** The `audience` field of a registry call for this chat. */
export function interfaceToolAudienceOf(chatId: string | undefined): {
  audience?: string;
} {
  const audience = interfaceToolAudience(chatId);
  return audience === undefined ? {} : { audience };
}

/** D12: the catalog tools a session of this kind binds now, from the windows of the computer driving its chat, sorted. Empty without a registry. */
export function resolveSessionInterfaceTools(opts: {
  assistantMode?: AssistantMode;
  chatId?: string;
}): readonly InterfaceToolName[] {
  const live =
    sessionRegistry?.availableFor(interfaceToolAudience(opts.chatId)) ?? [];
  switch (opts.assistantMode) {
    case 'app-advisor':
      return live
        .filter((name) => APP_ADVISOR_INTERFACE_TOOLS.has(name))
        .sort();
    case 'pipeline-editor':
      return live.filter((name) => name.startsWith('ui.pipeline_editor.'));
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
