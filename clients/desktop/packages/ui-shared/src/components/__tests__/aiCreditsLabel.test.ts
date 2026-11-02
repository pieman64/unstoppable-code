import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  AI_CREDITS_LABEL,
  FREE_AI_CREDITS_LABEL,
  aiCreditsLabel,
  isFreeOnlyAiCredits,
} from '../aiCreditsLabel';
import { AI_CREDITS_LABEL as SIDEBAR_AI_CREDITS_LABEL } from '../SidebarAiCreditsMenuItem';

describe('aiCreditsLabel', () => {
  it.each<[ModelLibraryAccess | undefined, string]>([
    ['needs_purchase', 'Free AI Credits'],
    ['needs_sign_in_then_purchase', 'Free AI Credits'],
    ['unlocked', 'AI Credits'],
    ['needs_sign_in', 'AI Credits'],
    [undefined, 'AI Credits'],
  ])('labels %s access as %s', (access, label) => {
    expect(aiCreditsLabel(access)).toBe(label);
    expect(isFreeOnlyAiCredits(access)).toBe(label === FREE_AI_CREDITS_LABEL);
  });

  it('keeps the plain constant importable from the account-menu row', () => {
    expect(SIDEBAR_AI_CREDITS_LABEL).toBe(AI_CREDITS_LABEL);
    expect(AI_CREDITS_LABEL).toBe('AI Credits');
  });
});
