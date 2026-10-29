const mockIsEnabled = jest.fn((): boolean => true);
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => mockIsEnabled(),
  }),
}));

import {
  chatVisualsEligible,
  chatVisualsPromptEligible,
} from '../chat-visuals-feature-flag';
import { CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS } from '@canopy/desktop-shared/lib/canopy-injected-tools';

describe('chat visuals eligibility', () => {
  beforeEach(() => {
    mockIsEnabled.mockReturnValue(true);
  });

  it.each([
    ['claude', 'worktree', true],
    ['claude', 'cowork', true],
    ['codex', 'worktree', true],
    ['codex', 'cowork', true],
    ['cursor', 'worktree', true],
    ['cursor', 'cowork', true],
    ['copilot', 'worktree', false],
    ['ollama', 'worktree', false],
    ['ollama', 'cowork', false],
    [undefined, 'worktree', false],
  ] as const)(
    'describes ShowVisual in a %s %s prompt: %s',
    (provider, workspace, expected) => {
      expect(chatVisualsPromptEligible(provider, workspace)).toBe(expected);
    },
  );

  it('never describes or advertises it while the flag is off', () => {
    mockIsEnabled.mockReturnValue(false);
    expect(chatVisualsPromptEligible('claude', 'worktree')).toBe(false);
    expect(
      chatVisualsEligible({ providerType: 'codex', surface: 'codex-worktree' }),
    ).toBe(false);
  });

  it('excludes App Advisor and the Pipeline Editor', () => {
    for (const assistantMode of ['app-advisor', 'pipeline-editor'] as const)
      expect(
        chatVisualsEligible({
          providerType: 'codex',
          surface: 'codex-worktree',
          assistantMode,
        }),
      ).toBe(false);
  });

  it('gives PreviewVisual the exact ShowVisual surface and provider set', () => {
    const surfaces = [
      ...Object.keys(CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS),
      'codex-worktree',
      'codex-cowork',
    ] as Array<Parameters<typeof chatVisualsEligible>[0]['surface']>;
    for (const surface of surfaces) {
      for (const providerType of [
        'claude',
        'cursor',
        'codex',
        'copilot',
        'ollama',
      ]) {
        expect(
          chatVisualsEligible({ providerType, surface, key: 'preview_visual' }),
        ).toBe(
          chatVisualsEligible({ providerType, surface, key: 'show_visual' }),
        );
      }
    }
  });
});
