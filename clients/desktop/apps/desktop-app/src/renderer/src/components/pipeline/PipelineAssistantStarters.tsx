import type { JSX, ReactNode } from 'react';
import { Button, EmptyState, Heading, SuggestionRow } from '@canopy/ui-shared';
import {
  CopyIcon,
  PencilIcon,
  SparkleIcon,
  WorkflowIcon,
  type AppIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import {
  PIPELINE_STARTERS,
  pipelineAssistantSuggestions,
  type PipelineAssistantContext,
  type PipelineAssistantSuggestion,
} from './pipelineAssistantSuggestions';

export interface PipelineAssistantStartersProps {
  /** The assistant tab whose composer a suggestion fills. */
  readonly tabId: string;
  /** The open saved workflow; absent for a new one. */
  readonly context?: PipelineAssistantContext;
}

interface EmptyStateCopy {
  readonly variant: 'new' | 'read-only' | 'editable';
  readonly art: AppIcon;
  readonly heading: ReactNode;
  /**
   * Plain text: it is the shared `EmptyState` subtitle, so it never holds
   * the workflow's name (which session replay masks).
   */
  readonly description: string;
  /**
   * The visible label over the suggestions. Examples have none: the
   * description says they are examples, which saves the list a line.
   */
  readonly listLabel?: string;
  /** What the suggestions are, for assistive technology. */
  readonly listName: string;
  readonly suggestions: readonly PipelineAssistantSuggestion[];
}

function workflowName(name: string): JSX.Element {
  return <span className={REPLAY_MASK_CLASS}>{name}</span>;
}

function emptyStateCopy(
  context: PipelineAssistantContext | undefined,
): EmptyStateCopy {
  if (context === undefined) {
    return {
      variant: 'new',
      art: WorkflowIcon,
      heading: 'What should this workflow do?',
      description:
        'Describe it or pick an example, and the assistant builds it.',
      listName: 'Examples',
      suggestions: PIPELINE_STARTERS,
    };
  }
  const suggestions = pipelineAssistantSuggestions(context);
  if (context.readOnly) {
    return {
      variant: 'read-only',
      art: SparkleIcon,
      heading: <>Ask about {workflowName(context.name)}</>,
      description: 'It’s read-only, so duplicate it to make changes.',
      listLabel: 'Try asking',
      listName: 'Try asking',
      suggestions,
    };
  }
  return {
    variant: 'editable',
    art: PencilIcon,
    heading: <>What should change in {workflowName(context.name)}?</>,
    description:
      context.jobCount === 0
        ? 'Describe what it should do or pick an example.'
        : 'The assistant saves each change as it makes it.',
    ...(context.jobCount === 0
      ? { listName: 'Examples' }
      : { listLabel: 'Try asking', listName: 'Try asking' }),
    suggestions,
  };
}

/**
 * The empty assistant chat beside a workflow (CAN-4319): for a new one, what
 * to describe and examples; for a read-only one, what to ask and a way to an
 * editable copy; for an editable one, what to change, from the workflow's
 * own state. The shared `EmptyState` sits centered in the pane with the
 * suggestions under it, a block centered as a whole whose rows stay
 * left-aligned so their icons share one edge. A suggestion puts its prompt
 * in the composer for the person to edit and send; it never sends.
 */
export function PipelineAssistantStarters({
  tabId,
  context,
}: PipelineAssistantStartersProps): JSX.Element {
  const copy = emptyStateCopy(context);
  const duplicate = context?.readOnly ? context.duplicate : undefined;
  return (
    <div
      className="mx-auto flex w-full max-w-100 flex-col gap-6 px-2 text-pretty"
      data-testid="pipeline-assistant-starters"
      data-variant={copy.variant}
    >
      <EmptyState
        inset="none"
        spacing="relaxed"
        art={copy.art}
        title={copy.heading}
        subtitle={copy.description}
        {...(duplicate
          ? {
              action: (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={duplicate}
                  data-testid="pipeline-assistant-duplicate"
                >
                  <CopyIcon size="xs" aria-hidden="true" />
                  Duplicate to edit
                </Button>
              ),
            }
          : {})}
      />
      <div
        role="group"
        aria-label={copy.listName}
        // Sized to the longest row and centered as a block.
        className="mx-auto flex w-fit max-w-full flex-col"
      >
        {copy.listLabel ? (
          <div className="px-4 pb-1">
            <Heading level={3} variant="label">
              {copy.listLabel}
            </Heading>
          </div>
        ) : null}
        {copy.suggestions.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={suggestion.icon}
            multiline
            data-testid="pipeline-assistant-starter"
            data-starter-id={suggestion.id}
            onClick={(): void => {
              const detail: InsertChatTextDetail = {
                text: suggestion.prompt,
                targetTabId: tabId,
              };
              document.dispatchEvent(
                new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }),
              );
            }}
          >
            {suggestion.label}
          </SuggestionRow>
        ))}
      </div>
    </div>
  );
}
