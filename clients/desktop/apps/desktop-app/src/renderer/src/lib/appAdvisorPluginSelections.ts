import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

export function emptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

/**
 * Normalizes App Advisor plugin selections: legacy builtin skill source ids
 * (`builtin`, `builtin/app`, `builtin/...`, `builtin:...`) collapse to the
 * canonical `builtin:app`, and duplicate skill refs are removed. Shared by
 * the App Advisor store, the scoped workspace surface, and the settings
 * surfaces so persisted selections stay canonical everywhere.
 */
export function normalizeAppAdvisorPluginSelections(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const base = selections ?? emptyPluginSelections();
  const skillRefs: ChatTabPluginSelections['skillRefs'] = [];
  const seenSkillRefs = new Set<string>();
  for (const ref of base.skillRefs ?? []) {
    const sourceId =
      ref.sourceId === 'builtin' ||
      ref.sourceId === 'builtin/app' ||
      ref.sourceId.startsWith('builtin/') ||
      ref.sourceId.startsWith('builtin:')
        ? 'builtin:app'
        : ref.sourceId;
    const key = `${sourceId}\0${ref.skillName}`;
    if (seenSkillRefs.has(key)) continue;
    seenSkillRefs.add(key);
    skillRefs.push({ ...ref, sourceId });
  }
  return {
    ...base,
    skillRefs,
  };
}
