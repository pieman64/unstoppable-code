import type { SkillContentResponse } from '@canopy/desktop-shared/types/skills';
import type { SkillDetailSelection } from './unifiedTableDetailView';

export async function readSkillContentForDisplay(
  skill: SkillDetailSelection,
): Promise<SkillContentResponse> {
  const result = await window.skills.readContent(skill.sourceId, skill.name);
  if (result.success && result.data) return result.data;
  throw new Error(result.error || 'Failed to load skill content.');
}
