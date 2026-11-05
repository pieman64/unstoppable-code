'use client';

import type { JSX } from 'react';
import { ComposerDrawerSection, Notice } from '@canopy/ui-shared/components';
import { CheckIcon, StarIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { ComposerHint } from '../../onboarding-tips/ComposerHint';
import type { GitHubStarPromptOffer } from './useGitHubStarPrompt';

export interface GitHubStarPromptProps {
  /** The composer's `useGitHubStarPrompt` result. */
  readonly prompt: GitHubStarPromptOffer;
  /** The brand's product name, from the host's brand helper. */
  readonly appName: string;
  /** The GitHub CLI login that stars in app, when the host offers it. */
  readonly starLogin: string | null;
  readonly appearance?: 'drawer' | 'notice';
}

const DONE_TITLE = 'Starred, thanks!';

/**
 * The one-time GitHub star nudge (CAN-5604), drawn as the composer's tip.
 * Hosts place it right after `PlanModeHint`; the composer tip arbiter shows
 * at most one. After an in-app star it briefly confirms, then retires.
 */
export function GitHubStarPrompt({
  prompt,
  appName,
  starLogin,
  appearance = 'drawer',
}: GitHubStarPromptProps): JSX.Element | null {
  if (prompt.done === 'starred') {
    const glyph = <CheckIcon size="md" aria-hidden="true" />;
    if (appearance === 'notice') {
      return (
        <Notice
          intent="neutral"
          icon={glyph}
          role="status"
          data-testid="github-star-prompt-done"
        >
          {DONE_TITLE}
        </Notice>
      );
    }
    return (
      <ComposerDrawerSection
        role="status"
        aria-live="polite"
        data-testid="github-star-prompt-done"
      >
        <div className="flex min-w-0 items-center gap-1.5 py-1 pl-1 text-xs">
          <span
            aria-hidden="true"
            className="flex w-6 shrink-0 justify-center fg-tertiary"
          >
            {glyph}
          </span>
          <span className="min-w-0 flex-1 font-medium fg-primary text-balance">
            {DONE_TITLE}
          </span>
        </div>
      </ComposerDrawerSection>
    );
  }
  if (!prompt.visible) return null;
  return (
    <ComposerHint
      appearance={appearance}
      icon={<StarIcon size="md" aria-hidden="true" />}
      title={`Enjoying ${appName}?`}
      action={{
        // Replay records the button but blocks the login itself. A long
        // login (up to 39 characters) ends in an ellipsis so the button
        // never crowds out the copy; the tooltip and the accessible name
        // keep the whole account.
        label:
          prompt.starsInApp && starLogin !== null ? (
            <>
              Star as{' '}
              <span
                className={`${REPLAY_BLOCK_CLASS} inline-block max-w-40 truncate align-bottom`}
                title={`@${starLogin}`}
              >
                @{starLogin}
              </span>
            </>
          ) : (
            'Star on GitHub'
          ),
        onClick: (): void => void prompt.accept(),
        busy: prompt.pending,
        busyText: 'Starring…',
        testId: 'github-star-prompt-accept',
        variant: 'primary',
      }}
      onDismiss={prompt.dismiss}
      // The close button declines; a second decline button blurs the ask.
      dismissLabel={null}
      dismissAriaLabel="Dismiss GitHub star suggestion"
      data-testid="github-star-prompt"
    >
      A star on GitHub helps more people find us.
    </ComposerHint>
  );
}
