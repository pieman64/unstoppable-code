/**
 * Which of a chat automation's plugin selections its owned pipeline carries
 * as `chat_plugins` defaults (CAN-5479): an installed skill or plugin with a
 * shareable ref that resolves back to that same selection, as a run resolves
 * the defaults. Anything else stays a preference on this machine, so the
 * conversion stays lossless.
 */
import type {
  ChatPluginPortability,
  ChatPluginSelection,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { PipelinePluginDefault } from '@canopy/desktop-shared/types/pipeline';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
  portablePluginRef,
  portableSkillRef,
  type ShareablePluginCatalog,
} from '../plugins/shareable-plugin-resolution';

function selectionKey(selection: ChatPluginSelection): string {
  return selection.kind === 'skill'
    ? `skill:${selection.sourceId}/${selection.skillName}`
    : `plugin:${selection.marketplaceId}/${selection.pluginName}`;
}

/** The ref `selection` travels as, if it resolves back to `selection`. */
function travellingRef(
  selection: ChatPluginSelection,
  catalog: ShareablePluginCatalog,
): PipelinePluginDefault | undefined {
  const ref =
    selection.kind === 'skill'
      ? portableSkillRef(selection, catalog)
      : portablePluginRef(selection, catalog);
  if (ref === undefined) return undefined;
  const match = matchShareablePluginRef(ref, catalog);
  return match.matchState === 'matched' &&
    selectionKey(match.selection) === selectionKey(selection)
    ? ref
    : undefined;
}

/**
 * The portability of `selections`' skills and plugins. A catalog that can't
 * load leaves every selection local.
 */
export async function chatPluginPortability(
  selections: ChatTabPluginSelections | undefined,
  loadCatalog: () => Promise<ShareablePluginCatalog> = loadShareablePluginCatalog,
): Promise<ChatPluginPortability | undefined> {
  if (
    selections === undefined ||
    (selections.skillRefs.length === 0 && selections.pluginRefs.length === 0)
  )
    return undefined;
  let catalog: ShareablePluginCatalog;
  try {
    catalog = await loadCatalog();
  } catch (error) {
    logMainProcessWarn('Kept chat plugins local; the catalog failed to load', {
      operation: 'chat-plugin-portability',
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
  const refs = new Map<string, PipelinePluginDefault>();
  const selected: ChatPluginSelection[] = [
    ...selections.skillRefs.map(
      ({ sourceId, skillName }): ChatPluginSelection => ({
        kind: 'skill',
        sourceId,
        skillName,
      }),
    ),
    ...selections.pluginRefs.map(
      ({ marketplaceId, pluginName }): ChatPluginSelection => ({
        kind: 'plugin',
        marketplaceId,
        pluginName,
      }),
    ),
  ];
  for (const selection of selected) {
    const ref = travellingRef(selection, catalog);
    if (ref !== undefined) refs.set(selectionKey(selection), ref);
  }
  return (selection) => refs.get(selectionKey(selection));
}
