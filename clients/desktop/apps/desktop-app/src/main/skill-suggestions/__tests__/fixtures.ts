import type { StoredSkillSuggestion } from '../registry';

export function storedSuggestion(
  overrides: Partial<StoredSkillSuggestion> = {},
): StoredSkillSuggestion {
  return {
    id: 'suggestion-1',
    kind: 'prompt',
    state: 'confirmed',
    partition: 'personal',
    title: 'Summarize release notes',
    summary: 'Summarizes the latest release notes.',
    proposedSkillName: 'release-notes',
    proposedDescription: 'Summarize release notes.',
    parameters: ['version'],
    chainSkills: [],
    exemplars: ['Summarize the release notes for 1.2'],
    members: [{ tokens: ['notes', 'release', 'summarize'], tools: [] }],
    matchedTurnIds: [],
    showCount: 0,
    createdAt: 1,
    lastMatchedAt: 1,
    ...overrides,
  };
}
