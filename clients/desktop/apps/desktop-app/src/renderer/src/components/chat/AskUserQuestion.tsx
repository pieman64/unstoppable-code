import { useCallback, useState, type JSX, type ReactNode } from 'react';
import {
  AskUserQuestionCard as SharedAskUserQuestionCard,
  Markdown,
  type AskUserQuestionCardProps,
} from '@canopy/ui-shared/components';
import type { PortalAskUserQuestionState } from '@canopy/protocol/portal';
import { useChatSurfaceScope } from '@/stores/chat/surface-store';
import { useChatStore, type PendingQuestion } from '@/stores/chatStore';

const QUESTION_PROSE_CLASSES =
  'prose prose-sm leading-5 prose-p:leading-5 [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5';

/**
 * Thin store-connected wrapper around the shared `@canopy/ui-shared`
 * {@link SharedAskUserQuestionCard}. It maps the renderer's `PendingQuestion`
 * onto the protocol {@link PortalAskUserQuestionState} shape, threads a
 * shared markdown renderer for the question text, and dispatches the desktop
 * store's awaited answer/dismiss actions. Preserves the historical
 * `ask-user-question-card` test id (owned by the shared card).
 */
export function AskUserQuestionCard({
  pending,
  hideAnswered = false,
  docked = false,
  onDeliveryChange,
}: {
  pending: PendingQuestion;
  /** Async answers render at their submitted timeline position after delivery. */
  hideAnswered?: boolean;
  docked?: boolean;
  onDeliveryChange?: (requestId: string, retained: boolean) => void;
}): JSX.Element | null {
  const scope = useChatSurfaceScope();
  const answerMcpQuestion = useChatStore((s) => s.answerMcpQuestionAndWait);
  const dismissMcpQuestion = useChatStore((s) => s.dismissMcpQuestionAndWait);
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null);
  const [errorKind, setErrorKind] = useState<'submit' | 'dismiss' | null>(null);

  const renderMarkdown = useCallback(
    (text: string): ReactNode => (
      <div className={QUESTION_PROSE_CLASSES}>
        <Markdown>{text}</Markdown>
      </div>
    ),
    [],
  );

  const onSubmit = useCallback<AskUserQuestionCardProps['onSubmit']>(
    (answers) => {
      setBusy('answer');
      onDeliveryChange?.(pending.requestId, true);
      setErrorKind(null);
      void answerMcpQuestion(pending.requestId, answers)
        .then(() => onDeliveryChange?.(pending.requestId, false))
        .catch(() => setErrorKind('submit'))
        .finally(() => setBusy(null));
    },
    [answerMcpQuestion, pending.requestId, onDeliveryChange],
  );

  const onDismiss = useCallback(() => {
    setBusy('dismiss');
    onDeliveryChange?.(pending.requestId, true);
    setErrorKind(null);
    void dismissMcpQuestion(pending.requestId)
      .then(() => onDeliveryChange?.(pending.requestId, false))
      .catch(() => setErrorKind('dismiss'))
      .finally(() => setBusy(null));
  }, [dismissMcpQuestion, pending.requestId, onDeliveryChange]);

  // Canonical persistence reserves the answer before transport acknowledges
  // it. Retain the mounted form and its input until that operation settles.
  const submitting = busy === 'answer' || errorKind === 'submit';
  if (hideAnswered && pending.answeredAt !== undefined && !submitting)
    return null;
  const state: PortalAskUserQuestionState = {
    requestId: pending.requestId,
    ...(pending.toolUseId ? { toolUseId: pending.toolUseId } : {}),
    questions: pending.questions,
    answered: pending.answeredAt !== undefined && !(hideAnswered && submitting),
    ...(pending.answers ? { answers: pending.answers } : {}),
  };

  const card = (
    <SharedAskUserQuestionCard
      state={state}
      renderMarkdown={renderMarkdown}
      onSubmit={onSubmit}
      onDismiss={onDismiss}
      defaultFirstOption={pending.delivery === 'async'}
      busy={busy}
      errorKind={errorKind}
      disconnected={scope?.disconnected}
      embedded={docked}
    />
  );
  return hideAnswered && !docked ? <div className="px-3">{card}</div> : card;
}
