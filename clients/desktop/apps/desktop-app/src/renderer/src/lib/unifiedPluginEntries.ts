import { brandText } from '@/lib/brand';
import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import {
  buildUnifiedPluginEntries as buildSharedUnifiedPluginEntries,
  marketplaceTitleCase,
  type UnifiedEntryInputs,
  type UnifiedPluginEntry,
} from '@canopy/ui-app/capability';

import { skillSharePath } from '@canopy/protocol/skills';

export * from '@canopy/ui-app/capability';

/** The source a publisher skill's installed copy lives in. */
const CUSTOM_SKILL_SOURCE = 'custom:app';
// The `skill:<sourceId>:<name>` entry id format of `entryIdForSelection`.
const CUSTOM_SKILL_ENTRY_PREFIX = `skill:${CUSTOM_SKILL_SOURCE}:`;

function publisherEntryId(skill: DesktopPublisherSkill): string {
  return `public-share:skill:${skill.externalId}`;
}

/**
 * The entry that shows a local skill. A publisher skill's installed copy is
 * folded into its publisher entry and has no entry of its own, so a request
 * to open the copy opens the publisher entry instead.
 */
export function visibleEntryId(
  entryId: string,
  publisherSkills: readonly DesktopPublisherSkill[],
): string {
  if (!entryId.startsWith(CUSTOM_SKILL_ENTRY_PREFIX)) return entryId;
  const skillName = entryId.slice(CUSTOM_SKILL_ENTRY_PREFIX.length);
  const publisher = publisherSkills.find(
    (skill) => skill.installedSkillName === skillName,
  );
  return publisher ? publisherEntryId(publisher) : entryId;
}

export function buildUnifiedPluginEntries(
  inputs: UnifiedEntryInputs & {
    publisherSkills?: DesktopPublisherSkill[];
  },
): UnifiedPluginEntry[] {
  const installedPublisherNames = new Set(
    (inputs.publisherSkills ?? []).flatMap((skill) =>
      skill.installedSkillName ? [skill.installedSkillName] : [],
    ),
  );
  return [
    ...buildSharedUnifiedPluginEntries({
      ...inputs,
      appName: brandText.appName,
    }).filter(
      (entry) =>
        !(
          entry.ref.type === 'skill' &&
          entry.ref.sourceId === CUSTOM_SKILL_SOURCE &&
          installedPublisherNames.has(entry.ref.skillName)
        ),
    ),
    ...(inputs.publisherSkills ?? []).map(
      (skill): UnifiedPluginEntry => ({
        id: publisherEntryId(skill),
        kind: 'skill',
        origin: 'shared',
        name: marketplaceTitleCase(skill.name),
        description: skill.description,
        categories: [],
        typeLabel: 'Skill',
        sourceLabel: skill.publisher,
        components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
        providerSupport: { claude: true, codex: true },
        state: skill.installedSkillName ? 'installed' : 'available',
        recommended: false,
        ref: {
          type: 'public-share',
          shareKind: 'skill',
          externalId: skill.externalId,
          sharePath: skillSharePath(skill.externalId),
        },
      }),
    ),
  ];
}
