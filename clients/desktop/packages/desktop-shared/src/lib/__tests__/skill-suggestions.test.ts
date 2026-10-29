import {
  isSkillSuggestionOrigin,
  isSkillSuggestionResolution,
  isSkillSuggestionResolveRequest,
  SKILL_SUGGESTION_CHANNELS,
  SKILL_SUGGESTION_SKILL_NAME_PATTERN,
} from '../skill-suggestions';

const origin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

describe('skill suggestion contracts', () => {
  it('uses stable channel names', () => {
    expect(SKILL_SUGGESTION_CHANNELS).toEqual({
      getPending: 'skill-suggestion:get-pending',
      list: 'skill-suggestion:list',
      resolve: 'skill-suggestion:resolve',
      changed: 'skill-suggestion:changed',
    });
  });

  it('accepts only known resolutions', () => {
    for (const value of ['shown', 'dismissed', 'accepted']) {
      expect(isSkillSuggestionResolution(value)).toBe(true);
    }
    for (const value of ['shared', '', null, 1]) {
      expect(isSkillSuggestionResolution(value)).toBe(false);
    }
  });

  it('validates chat origins', () => {
    expect(isSkillSuggestionOrigin(origin)).toBe(true);
    expect(isSkillSuggestionOrigin({ ...origin, chatId: ' ' })).toBe(false);
    expect(
      isSkillSuggestionOrigin({ ...origin, chatId: 'x'.repeat(4097) }),
    ).toBe(false);
    expect(isSkillSuggestionOrigin(null)).toBe(false);
  });

  it('validates banner resolve requests with an origin and pending id', () => {
    const banner = {
      ...origin,
      source: 'banner',
      pendingId: 'pending-1',
      suggestionId: 'suggestion-1',
      resolution: 'shown',
    };
    expect(isSkillSuggestionResolveRequest(banner)).toBe(true);
    expect(isSkillSuggestionResolveRequest({ ...banner, pendingId: '' })).toBe(
      false,
    );
    expect(isSkillSuggestionResolveRequest({ ...banner, chatId: 1 })).toBe(
      false,
    );
    expect(
      isSkillSuggestionResolveRequest({ ...banner, resolution: 'shared' }),
    ).toBe(false);
  });

  it('validates modal resolve requests without an origin', () => {
    const modal = {
      source: 'suggestions_modal',
      suggestionId: 'suggestion-1',
      resolution: 'dismissed',
    };
    expect(isSkillSuggestionResolveRequest(modal)).toBe(true);
    expect(
      isSkillSuggestionResolveRequest({ ...modal, resolution: 'accepted' }),
    ).toBe(true);
    expect(
      isSkillSuggestionResolveRequest({ ...modal, resolution: 'shown' }),
    ).toBe(false);
    expect(isSkillSuggestionResolveRequest({ ...modal, source: 'other' })).toBe(
      false,
    );
    expect(
      isSkillSuggestionResolveRequest({ ...modal, suggestionId: '' }),
    ).toBe(false);
  });

  it('constrains proposed skill names', () => {
    expect(SKILL_SUGGESTION_SKILL_NAME_PATTERN.test('weekly-report')).toBe(
      true,
    );
    expect(SKILL_SUGGESTION_SKILL_NAME_PATTERN.test('-bad')).toBe(false);
    expect(SKILL_SUGGESTION_SKILL_NAME_PATTERN.test('Bad')).toBe(false);
    expect(SKILL_SUGGESTION_SKILL_NAME_PATTERN.test('a')).toBe(false);
  });
});
