import { useCallback, type JSX } from 'react';
import { isMessageBubbleStatesPageEnabled } from '@/components/sidebar/message-bubble-states-page-flag';
import { PageTitlebar } from '../shared/PageTitlebar';
import { ChatMessageItem } from '../chat/ChatMessageItem';
import { QueuedMessageBubble } from '../chat/QueuedMessageBubble';
import type { ScheduledMessageBubbleDescriptor } from '../chat/QueuedMessageBubble';
import {
  queuedRowForceAction,
  queuedRowTurnPhase,
} from '@/stores/chat/queue-mirror';
import { ScheduledAutomationsNoticeView } from '../chat/ScheduledAutomationsNotice';
import type { AutomationMutationResponse } from '@canopy/desktop-shared/types';
import {
  ASSISTANT_MESSAGE_STATES,
  GALLERY_FIXED_NOW,
  QUEUED_BUBBLE_STATES,
  RECURRING_NOTICE_STATES,
  USER_BUBBLE_STATES,
  messageSectionSlug,
  type MessageGalleryState,
  type QueuedGalleryState,
  type RecurringNoticeGalleryState,
} from './messageBubbleStateGalleryData';
import { Heading } from '@canopy/ui-shared/components';

/**
 * Dev-only reference page rendering the real chat message components
 * (`ChatMessageItem` → shared `UserBubble`, and `QueuedMessageBubble`) in
 * every visual state they can express, via direct props — no live sessions,
 * stores, or seeded chats. Reachable from the sidebar More menu in dev and
 * E2E builds only; the page itself stays mounted-on-demand in all builds so
 * navigation can never dead-end. Mirrors `WorktreeStateGalleryPage`.
 */

const noopAsync = async (): Promise<void> => {
  // Gallery rows are inert — revert affordances render but do nothing.
};

interface MessageStateRowProps {
  state: MessageGalleryState;
}

function MessageStateRow({ state }: MessageStateRowProps): JSX.Element {
  return (
    <div data-testid={`bubble-gallery-row-${state.id}`} className="min-w-0">
      <p className="text-xs font-medium fg-primary">{state.title}</p>
      <p className="mt-0.5 mb-2 text-xs leading-relaxed fg-secondary">
        {state.description}
      </p>
      <ChatMessageItem
        message={state.message}
        chatPendingQuestions={[]}
        onResetToPoint={state.withRevert ? noopAsync : undefined}
      />
    </div>
  );
}

interface QueuedStateRowProps {
  state: QueuedGalleryState;
}

function QueuedStateRow({ state }: QueuedStateRowProps): JSX.Element {
  const noop = useCallback((): void => {
    // Inert gallery handlers.
  }, []);
  const scheduled: ScheduledMessageBubbleDescriptor | undefined =
    state.scheduled
      ? {
          automationId: 'demo-automation',
          activityName: 'Nightly summary',
          // Fixed offset from the fixture epoch, so the rendered
          // "Sends …" stamp is stable across capture runs.
          scheduledAt: new Date(GALLERY_FIXED_NOW + 3_600_000).toISOString(),
          onEdit: noop,
          onClear: noop,
          onInterrupt: noop,
        }
      : undefined;
  // Same mapping as the live transcript; gallery rows never sit behind a
  // running turn, and a local row shows the failed-launch Retry.
  const forceAction = queuedRowForceAction(state.message, 'recoverable');
  const turnPhase = queuedRowTurnPhase(state.message, 'recoverable');
  return (
    <div data-testid={`bubble-gallery-row-${state.id}`} className="min-w-0">
      <p className="text-xs font-medium fg-primary">{state.title}</p>
      <p className="mt-0.5 mb-2 text-xs leading-relaxed fg-secondary">
        {state.description}
      </p>
      <QueuedMessageBubble
        message={state.message}
        index={0}
        onClear={noop}
        turnPhase={turnPhase}
        onForce={forceAction === 'interrupt' ? noop : undefined}
        onRetry={forceAction === 'retry' ? noop : undefined}
        onRunNow={forceAction === 'run-now' ? noop : undefined}
        onSteer={state.steerable ? noop : undefined}
        steeringSupported={state.steerable}
        settingsHeld={state.message.restartHeldChanges}
        onEdit={noop}
        canForce={state.canForce}
        scheduled={scheduled}
      />
    </div>
  );
}

const inertMutation = (): Promise<AutomationMutationResponse> =>
  Promise.resolve({ ok: true });

const inertHandler = (): void => {
  // Inert gallery handlers.
};

interface RecurringNoticeRowProps {
  state: RecurringNoticeGalleryState;
}

function RecurringNoticeRow({ state }: RecurringNoticeRowProps): JSX.Element {
  return (
    <div data-testid={`bubble-gallery-row-${state.id}`} className="min-w-0">
      <p className="text-xs font-medium fg-primary">{state.title}</p>
      <p className="mt-0.5 mb-2 text-xs leading-relaxed fg-secondary">
        {state.description}
      </p>
      <ScheduledAutomationsNoticeView
        automations={state.automations}
        onRunNow={inertMutation}
        onPause={inertMutation}
        onEdit={inertHandler}
        onManage={inertHandler}
      />
    </div>
  );
}

interface GallerySectionProps {
  title: string;
  description: string;
  children: JSX.Element[];
}

function GallerySection({
  title,
  description,
  children,
}: GallerySectionProps): JSX.Element {
  return (
    <div
      data-testid={`bubble-gallery-section-${messageSectionSlug(title)}`}
      className="rounded-xl border bg-base p-4"
    >
      <Heading level={2} variant="title">
        {title}
      </Heading>
      <p className="mt-1 text-xs leading-relaxed fg-secondary">{description}</p>
      <div className="mt-4 flex flex-col gap-5">{children}</div>
    </div>
  );
}

/**
 * Flag gate at the PAGE, not just the sidebar entry. `message-bubble-states`
 * stays in `NavigationPage` and the route dispatcher so the More-menu item can
 * reach it, which means an App Advisor `navigation.go_to_page` action could
 * otherwise land on this fixture gallery in a packaged build. Gating here
 * closes that route at the render boundary. Mirrors `HeaderStateGalleryPage`.
 */
export function MessageBubbleStateGalleryPage(): JSX.Element {
  if (!isMessageBubbleStatesPageEnabled()) {
    return (
      <div
        className="flex h-full items-center justify-center bg-base"
        data-testid="message-bubble-states-page-disabled"
      >
        <p className="text-xs fg-secondary">
          This page is a development-only reference and is not enabled in this
          build.
        </p>
      </div>
    );
  }
  return <MessageBubbleStateGalleryContent />;
}

function MessageBubbleStateGalleryContent(): JSX.Element {
  return (
    <section
      className="flex h-full flex-col"
      data-testid="page-message-bubble-states"
    >
      <PageTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <div className="mx-auto max-w-5xl space-y-8">
          <div className="space-y-2">
            <Heading level={1} variant="page">
              Message Bubbles
            </Heading>
            <p className="text-s fg-secondary">
              Every state the chat message bubbles can express, rendered by the
              real components with direct props — no live sessions. Hover any
              bubble to reveal its action cluster. This page is only reachable
              in dev and E2E builds.
            </p>
          </div>

          <GallerySection
            title="User bubbles"
            description="The shared UserBubble shell (packages/ui-shared) as rendered through the desktop ChatMessageItem path."
          >
            {USER_BUBBLE_STATES.map((state) => (
              <MessageStateRow key={state.id} state={state} />
            ))}
          </GallerySection>

          <GallerySection
            title="Assistant output"
            description="Assistant messages render flat with no shell — shown for contrast against the user pill."
          >
            {ASSISTANT_MESSAGE_STATES.map((state) => (
              <MessageStateRow key={state.id} state={state} />
            ))}
          </GallerySection>

          <GallerySection
            title="Queued bubbles"
            description="Right-aligned neutral-tinted bubbles for not-yet-sent messages, including setup, hook-queue, and scheduled variants."
          >
            {QUEUED_BUBBLE_STATES.map((state) => (
              <QueuedStateRow key={state.id} state={state} />
            ))}
          </GallerySection>

          <GallerySection
            title="Recurring automations"
            description="Recurring automations that target a chat render as one composer notice instead of a transcript bubble."
          >
            {RECURRING_NOTICE_STATES.map((state) => (
              <RecurringNoticeRow key={state.id} state={state} />
            ))}
          </GallerySection>
        </div>
      </div>
    </section>
  );
}
