import { useCallback, type JSX } from 'react';
import { SuggestionRow } from '@canopy/ui-shared';
import {
  CloseMediumIcon,
  DocumentIcon,
  DownloadIcon,
  GitBranchCompactIcon,
  HistoryIcon,
  TerminalIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { brandText } from '@/lib/brand';
import { SuggestedPromptChips } from '@/components/suggestions/SuggestedPromptChips';
import type { SuggestedPrompt } from '@/components/suggestions/mcpPromptIndex';
import { HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY } from './home-below-composer-gallery-flag';

const GALLERY_PROMPTS: readonly SuggestedPrompt[] = [
  {
    id: 'generic-home-1',
    curatedKey: null,
    text: 'Summarize the latest changes and suggest a next task',
  },
  {
    id: 'generic-home-2',
    curatedKey: null,
    text: 'Draft a plan to add tests around the riskiest paths',
  },
];

/**
 * Dev-only fixture stack for every below-composer Home section. Spacing comes
 * from `home-composer-group`'s gap — sections here must not add outer margin.
 */
export function HomeBelowComposerGallery(): JSX.Element {
  const hideGallery = useCallback((): void => {
    try {
      window.localStorage.setItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY, '0');
    } catch {
      // Ignore private-mode storage failures; reload still exits preview.
    }
    window.location.reload();
  }, []);

  return (
    <>
      <div
        data-testid="home-below-composer-gallery-banner"
        className="flex w-full items-center justify-between gap-3 rounded-lg bg-depth px-4 py-2 text-xs fg-secondary"
      >
        <span>
          Preview: all below-composer sections (dev only). Spacing uses the live
          Home stack gap.
        </span>
        <button
          type="button"
          data-testid="home-below-composer-gallery-hide"
          onClick={hideGallery}
          className="focus-ring shrink-0 rounded-md px-2 py-1 fg-primary transition-colors hover:bg-subtle"
        >
          Hide preview
        </button>
      </div>

      <section
        data-testid="home-resume-card"
        aria-label="Continue where you left off"
        className="flex w-full flex-col gap-3"
      >
        <h2 className="px-4 text-m font-medium fg-primary">Continue</h2>
        <ul className="flex flex-col">
          <li className="group relative flex items-center rounded-full">
            <SuggestionRow
              icon={<WarningIcon size={16} aria-hidden="true" />}
              trailingControl
            >
              Resume 2 interrupted sessions
            </SuggestionRow>
            <button
              type="button"
              aria-label="Dismiss"
              className="focus-ring absolute right-2 top-1/2 z-10 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-full fg-secondary transition-colors hover:bg-muted hover:fg-primary"
            >
              <CloseMediumIcon width={16} height={16} />
            </button>
          </li>
          <li data-testid="home-resume-details">
            <SuggestionRow icon={<HistoryIcon size={16} aria-hidden="true" />}>
              feature/home-section-spacing
              <span className="ml-2 fg-quaternary">Demo Workspace</span>
            </SuggestionRow>
          </li>
        </ul>
      </section>

      <section
        data-testid="home-onboarding-suggestions"
        aria-label={`Get started with ${brandText.appName}`}
        className="flex w-full flex-col gap-3"
      >
        <h2 className="px-4 text-m font-medium fg-primary">
          Get started with {brandText.appName}
        </h2>
        <ul className="flex flex-col">
          <li className="group relative flex items-center rounded-full">
            <SuggestionRow
              icon={<DownloadIcon size={16} aria-hidden="true" />}
              trailingControl
            >
              Import your Claude and Codex projects
            </SuggestionRow>
            <button
              type="button"
              aria-label="Dismiss"
              className="focus-ring absolute right-2 top-1/2 z-10 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-full fg-secondary transition-colors hover:bg-muted hover:fg-primary"
            >
              <CloseMediumIcon width={16} height={16} />
            </button>
          </li>
        </ul>
      </section>

      <SuggestedPromptChips
        prompts={GALLERY_PROMPTS}
        surface="home"
        onSelect={(): void => {
          // Fixture-only preview — no composer insertion.
        }}
      />

      <section
        data-testid="home-workspace-readiness"
        aria-label="Suggestions for Demo Workspace"
        className="flex w-full flex-col gap-3"
      >
        <h2 className="px-4 text-m font-medium fg-primary">
          Suggestions for <span className="fg-tertiary">Demo Workspace</span>
        </h2>
        <ul className="flex flex-col">
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow icon={<TerminalIcon size={16} aria-hidden="true" />}>
              Configure setup scripts
            </SuggestionRow>
          </li>
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow
              icon={<GitBranchCompactIcon size={16} aria-hidden="true" />}
            >
              Configure git hooks
            </SuggestionRow>
          </li>
          <li data-testid="home-workspace-readiness-row">
            <SuggestionRow icon={<DocumentIcon size={16} aria-hidden="true" />}>
              Add agent instructions
            </SuggestionRow>
          </li>
        </ul>
      </section>
    </>
  );
}
