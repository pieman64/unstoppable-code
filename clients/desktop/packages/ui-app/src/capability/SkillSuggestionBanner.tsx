import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { SkillIcon } from '@canopy/ui-shared/icons/AppIcons';
import { CapabilityGate } from './CapabilityGate';

/** Copy for repeat-task skill suggestions; the Notice gallery quotes it. */
export const SKILL_SUGGESTION_COPY = {
  title: (count: number): string =>
    `You've asked for this ${count} ${count === 1 ? 'time' : 'times'}`,
  promptMessage: "Turn it into a skill so it's one step next time.",
  chainMessage: (skillCount: number): string =>
    `Turn these ${skillCount} skills into one skill.`,
  create: 'Create skill',
  dismiss: 'Dismiss',
  dismissLabel: 'Dismiss skill suggestion',
  dismissForever: 'Don’t show again',
  modalTitle: 'Suggested skills',
  viewSuggestions: 'View suggestions',
  askedCount: (count: number): string => `Asked ${count} times`,
  lastSeen: (when: string): string => `Last seen ${when}`,
  showExamples: 'Show examples',
  hideExamples: 'Hide examples',
  empty:
    'No suggestions yet. They show up after you ask for the same kind of task a few times.',
} as const;

export interface SkillSuggestionBannerProps {
  readonly count: number;
  readonly kind: 'prompt' | 'chain';
  readonly chainSkills?: readonly string[];
  readonly onCreate: () => void;
  readonly onDismiss: () => void;
  /**
   * Don't show again: retires skill suggestions as a category (CAN-4343).
   * Omitted where the host keeps no suggestion preferences.
   */
  readonly onDismissForever?: () => void;
  /** Disables the actions while a resolution is in flight. */
  readonly busy?: boolean;
}

/**
 * The composer banner offering to turn a repeated request into a skill
 * (CAN-385). The host decides when it shows; this only renders it.
 */
export function SkillSuggestionBanner({
  count,
  kind,
  chainSkills = [],
  onCreate,
  onDismiss,
  onDismissForever,
  busy = false,
}: SkillSuggestionBannerProps): JSX.Element {
  return (
    <CapabilityGate when={(c) => c.skillSuggestions === true}>
      <Notice
        intent="neutral"
        icon={<SkillIcon size={16} aria-hidden="true" />}
        title={SKILL_SUGGESTION_COPY.title(count)}
        data-testid="skill-suggestion-banner"
        data-suggestion-kind={kind}
        onDismiss={() => {
          if (!busy) onDismiss();
        }}
        dismissLabel={SKILL_SUGGESTION_COPY.dismissLabel}
        dismissTestId="skill-suggestion-banner-dismiss"
        actions={
          <>
            {onDismissForever ? (
              <NoticeButton
                data-testid="skill-suggestion-banner-dismiss-forever"
                disabled={busy}
                onClick={onDismissForever}
              >
                {SKILL_SUGGESTION_COPY.dismissForever}
              </NoticeButton>
            ) : null}
            <NoticeButton
              variant="primary"
              data-testid="skill-suggestion-banner-create"
              disabled={busy}
              onClick={onCreate}
            >
              {SKILL_SUGGESTION_COPY.create}
            </NoticeButton>
          </>
        }
      >
        {kind === 'chain'
          ? SKILL_SUGGESTION_COPY.chainMessage(chainSkills.length)
          : SKILL_SUGGESTION_COPY.promptMessage}
      </Notice>
    </CapabilityGate>
  );
}
