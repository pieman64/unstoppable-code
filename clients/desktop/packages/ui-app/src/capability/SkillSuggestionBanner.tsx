import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { SkillIcon } from '@canopy/ui-shared/icons/AppIcons';
import { CapabilityGate } from './CapabilityGate';

/** Copy for repeat-task skill suggestions; the Notice gallery quotes it. */
export const SKILL_SUGGESTION_COPY = {
  title: (count: number): string => `You've asked for this ${count} times`,
  promptMessage: "Turn it into a skill so it's one step next time.",
  chainMessage: (skillCount: number): string =>
    `Turn these ${skillCount} skills into one skill.`,
  create: 'Create skill',
  dismiss: 'Dismiss',
  dismissLabel: 'Dismiss skill suggestion',
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
  /** Disables both actions while a resolution is in flight. */
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
        actions={
          <>
            <NoticeButton
              data-testid="skill-suggestion-banner-dismiss"
              aria-label={SKILL_SUGGESTION_COPY.dismissLabel}
              disabled={busy}
              onClick={onDismiss}
            >
              {SKILL_SUGGESTION_COPY.dismiss}
            </NoticeButton>
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
