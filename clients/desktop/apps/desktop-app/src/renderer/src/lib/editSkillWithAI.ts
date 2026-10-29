import type { Descendant } from 'slate';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { SkillEditWithAIState } from '@canopy/ui-app';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { CUSTOM_SKILL_SOURCE_ID } from './sharedSkillImport';

/**
 * "Edit with AI" (CAN-1259) hands a skill to a new Cowork chat. The chat does
 * the editing through the skill-editing tools every chat already has (and the
 * any-chat diff/confirm flow of CAN-1081); this module only starts the chat.
 */

interface SkillIdentity {
  sourceId: string;
  name: string;
}

/** The editable prompt drafted into the new chat's composer. */
export function buildEditSkillWithAIPrompt(skillName: string): string {
  return `Help me edit ${skillName}. Ask what I want to change, use the available skill-editing tools to propose the changes, and save them after I confirm.`;
}

/**
 * Whether the skill-editing tools can change this skill. They write custom
 * skills only, the same skills the page's Edit opens.
 */
function canEditSkillWithAI(skill: { sourceId: string }): boolean {
  return skill.sourceId === CUSTOM_SKILL_SOURCE_ID;
}

/**
 * Why "Edit with AI" is unavailable for an installed skill, with the next
 * step; `null` when the skill can be edited.
 */
export function editSkillWithAIUnavailableReason(
  skill: InstalledSkillInfo,
): string | null {
  if (canEditSkillWithAI(skill)) return null;
  if (skill.builtIn) {
    return 'Built-in skills are read-only. Create a custom skill to make your own version.';
  }
  if (skill.shareableSource?.type === 'github') {
    return 'This skill is managed in its GitHub repository. Change it there, then update it here.';
  }
  return 'This skill is read-only here. Change it where it was installed from.';
}

/**
 * The detail page's "Edit with AI" state. Custom skills offer it at once,
 * like Edit; the reason for any other skill waits for its installed record,
 * like Share and Delete/Remove, so the action stays hidden until then.
 */
export function skillDetailEditWithAIState(
  skill: { sourceId: string },
  installedSkill: InstalledSkillInfo | undefined,
  action: { onSelect: () => void; pending: boolean },
): SkillEditWithAIState | undefined {
  if (canEditSkillWithAI(skill)) {
    return {
      available: true,
      onSelect: action.onSelect,
      pending: action.pending,
    };
  }
  const reason = installedSkill
    ? editSkillWithAIUnavailableReason(installedSkill)
    : null;
  return reason === null ? undefined : { available: false, reason };
}

/**
 * Opens a new chat in the current context's default Cowork project (the
 * sidebar's Chats) with the skill selected for the chat and the prompt in the
 * composer. Nothing is sent: the user describes the change in their own words.
 * Rejects, without leaving the page, when the chat cannot be created.
 */
export async function openEditSkillWithAIChat(
  skill: SkillIdentity,
): Promise<void> {
  const pluginSelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [{ sourceId: skill.sourceId, skillName: skill.name }],
    pluginRefs: [],
  };
  const chatId = await useStandaloneChatStore
    .getState()
    .createStandaloneChatWithMessage({
      message: '',
      config: { pluginSelections },
    });
  const draft: Descendant[] = [
    {
      type: 'paragraph',
      children: [{ text: buildEditSkillWithAIPrompt(skill.name) }],
    },
  ];
  useChatStore.getState().saveTabDraft(chatId, draft);
  useNavigationStore.getState().navigate('chat');
}
