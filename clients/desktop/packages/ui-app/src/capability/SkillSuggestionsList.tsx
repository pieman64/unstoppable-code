import { useId, useState, type JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { CapabilityGate } from './CapabilityGate';
import { SKILL_SUGGESTION_COPY } from './SkillSuggestionBanner';
import { Surface } from '@canopy/ui-shared/components';

/** One open suggestion as the list shows it; hosts map their own shape. */
export interface SkillSuggestionListItem {
  readonly id: string;
  readonly kind: 'prompt' | 'chain';
  readonly title: string;
  readonly summary: string;
  readonly occurrenceCount: number;
  readonly chainSkills: readonly string[];
  /** Redacted example requests; hosts pass none for private work. */
  readonly examples: readonly string[];
  readonly ownerLabel: string;
  readonly lastSeenAt: number;
}

export interface SkillSuggestionsListProps {
  readonly suggestions: readonly SkillSuggestionListItem[];
  readonly onCreate: (id: string) => void;
  readonly onDismiss: (id: string) => void;
  /** Suggestions with a resolution in flight; their actions are disabled. */
  readonly busyIds?: ReadonlySet<string>;
}

function SkillSuggestionRow({
  suggestion,
  busy,
  onCreate,
  onDismiss,
}: {
  readonly suggestion: SkillSuggestionListItem;
  readonly busy: boolean;
  readonly onCreate: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const dismissId = useId();
  const hasExamples = suggestion.examples.length > 0;
  return (
    <Surface
      as="li"
      variant="group"
      padding="compact"
      gap="inline"
      data-testid="skill-suggestions-row"
      data-suggestion-id={suggestion.id}
      data-suggestion-kind={suggestion.kind}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Title and summary are drafted from the user's own requests. */}
          <div className="text-s font-medium fg-primary">
            <span id={titleId} className={REPLAY_MASK_CLASS}>
              {suggestion.title}
            </span>
          </div>
          <div className={`mt-0.5 text-s fg-secondary ${REPLAY_BLOCK_CLASS}`}>
            {suggestion.summary}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs fg-tertiary">
            {suggestion.kind === 'chain' ? (
              <span
                className="flex flex-wrap items-center gap-1"
                data-testid="skill-suggestions-row-chain"
              >
                {suggestion.chainSkills.map((skill, index) => (
                  <span
                    key={`${String(index)}-${skill}`}
                    className="rounded-md bg-secondary px-1.5 py-0.5 font-mono fg-secondary"
                  >
                    {skill}
                  </span>
                ))}
              </span>
            ) : (
              <span>
                {SKILL_SUGGESTION_COPY.askedCount(suggestion.occurrenceCount)}
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {SKILL_SUGGESTION_COPY.lastSeen(
                formatRelativeTime(suggestion.lastSeenAt),
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span>{suggestion.ownerLabel}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid="skill-suggestions-row-dismiss"
            id={dismissId}
            // Replay records attributes verbatim; the name comes from the
            // masked title element instead of copying it into aria-label.
            aria-labelledby={`${dismissId} ${titleId}`}
            disabled={busy}
            onClick={() => onDismiss(suggestion.id)}
          >
            {SKILL_SUGGESTION_COPY.dismiss}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="skill-suggestions-row-create"
            disabled={busy}
            onClick={() => onCreate(suggestion.id)}
          >
            {SKILL_SUGGESTION_COPY.create}
          </Button>
        </div>
      </div>
      {hasExamples ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            data-testid="skill-suggestions-row-examples-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? SKILL_SUGGESTION_COPY.hideExamples
              : SKILL_SUGGESTION_COPY.showExamples}
          </Button>
          {expanded ? (
            <ul
              className={`mt-1.5 flex flex-col gap-1 ${REPLAY_BLOCK_CLASS}`}
              data-testid="skill-suggestions-row-examples"
            >
              {suggestion.examples.map((example, index) => (
                <Surface
                  as="li"
                  variant="group"
                  size="small"
                  key={String(index)}
                >
                  <div className="whitespace-pre-wrap break-words px-2 py-1 text-xs fg-secondary">
                    {example}
                  </div>
                </Surface>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Surface>
  );
}

/**
 * Every open repeat-task skill suggestion (CAN-385), with Create skill and
 * Dismiss on each row. Unthrottled, unlike the composer banner.
 */
export function SkillSuggestionsList({
  suggestions,
  onCreate,
  onDismiss,
  busyIds,
}: SkillSuggestionsListProps): JSX.Element {
  return (
    <CapabilityGate when={(c) => c.skillSuggestions === true}>
      {suggestions.length === 0 ? (
        <p
          className="py-6 text-center text-s fg-secondary"
          data-testid="skill-suggestions-empty"
        >
          {SKILL_SUGGESTION_COPY.empty}
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          data-testid="skill-suggestions-list"
        >
          {suggestions.map((suggestion) => (
            <SkillSuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              busy={busyIds?.has(suggestion.id) === true}
              onCreate={onCreate}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      )}
    </CapabilityGate>
  );
}
