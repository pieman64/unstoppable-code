import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import { Notice, NoticeButton } from './Notice';

export interface GettingStartedSidebarTileProps {
  /** The current step's title; omitted when nothing is left. */
  title?: string;
  /** One sentence under the title on what the step gets the user. */
  description?: string;
  /** The step's action, sized to its label. Defaults to `Start`. */
  actionLabel?: string;
  /** True while the action is in flight. */
  disabled?: boolean;
  onActivate?: () => void;
  /**
   * Moves past this step through the card's top-right ×; the next card in the
   * stack comes forward.
   */
  onSkip?: () => void;
  /** The ×'s accessible name: `Skip`, or `Next` for a step already done. */
  skipLabel?: string;
  /** Steps still waiting after this one; up to two peek out behind it. */
  upcoming?: number;
  /** The host's queue entry, exposed for automation. */
  entryId?: string;
}

/** Cards that peek out behind the front one, like the toast deck. */
const MAX_PEEKING_CARDS = 2;

/**
 * Every card in the deck: a toast card's 20px corners, edged with the notice
 * tray's hairline so a card reads apart from the one behind it in dark themes
 * too, where a shadow does not. The front card takes the sidebar's raised
 * surface; the cards behind it sit a step lower, so they read as waiting.
 */
const CARD_SHAPE =
  'rounded-2xl ring-[length:var(--border-hairline)] ring-line-secondary';
const FRONT_CARD_SURFACE = `${CARD_SHAPE} bg-tertiary`;
const BEHIND_CARD_SURFACE = `${CARD_SHAPE} bg-secondary`;

interface CardCopy {
  key: string;
  title: string;
  description?: string;
  actionLabel: string;
  skipLabel: string;
}

/**
 * The sidebar's Getting started card, drawn as the front of a deck: one card
 * per step, the steps still to come peeking out above it the way older toasts
 * do. Skip (or finishing the step) slides the card away toward the sidebar's
 * edge and the next card comes forward. Its copy and controls follow a
 * toast's `Notice`: the title over one sentence, the action below as a 32px
 * pill sized to its label, and Skip as the × in the top-right corner. A
 * pointer click anywhere else on the card runs the action; the buttons stay
 * the keyboard targets.
 */
export function GettingStartedSidebarTile({
  title,
  description,
  actionLabel = 'Start',
  disabled = false,
  onActivate,
  onSkip,
  skipLabel = 'Skip',
  upcoming = 0,
  entryId,
}: GettingStartedSidebarTileProps): JSX.Element {
  const actionable = Boolean(title) && !disabled;
  const key = entryId ?? title ?? '';
  const [shown, setShown] = useState<CardCopy | null>(null);
  const [leaving, setLeaving] = useState<CardCopy | null>(null);
  // The card that just left keeps its last copy while it slides away.
  if (
    shown?.key !== key ||
    shown.title !== title ||
    shown.description !== description ||
    shown.actionLabel !== actionLabel ||
    shown.skipLabel !== skipLabel
  ) {
    if (shown && shown.key !== key && shown.title) setLeaving(shown);
    setShown(
      title
        ? { key, title, description, actionLabel, skipLabel }
        : { key, title: '', actionLabel, skipLabel },
    );
  }
  // Fallback for hosts without animation events (reduced motion still fires
  // them; a test environment does not).
  useEffect((): (() => void) | undefined => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => setLeaving(null), 400);
    return (): void => window.clearTimeout(timer);
  }, [leaving]);

  // The next card is a new element, so a control that had focus when the
  // card advanced is gone. Its position among the card's buttons is kept to
  // focus the same control on the card that takes its place.
  const frontCardRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<number | null>(null);
  const rememberFocus = (): void => {
    const card = frontCardRef.current;
    const active = document.activeElement;
    restoreFocusRef.current =
      card && active instanceof HTMLButtonElement && card.contains(active)
        ? Array.from(card.querySelectorAll('button')).indexOf(active)
        : null;
  };
  useLayoutEffect((): void => {
    const index = restoreFocusRef.current;
    restoreFocusRef.current = null;
    const card = frontCardRef.current;
    if (index === null || !card) return;
    // Only when focus was lost with the old card, never taken from elsewhere.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const buttons = Array.from(card.querySelectorAll('button'));
    const same = buttons[index];
    (same && !same.disabled
      ? same
      : buttons.find((button) => !button.disabled)
    )?.focus();
  }, [key]);

  const activateFromCard = (event: MouseEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest('button, a')) {
      return;
    }
    if (actionable) onActivate?.();
  };
  const peeking = Math.min(Math.max(upcoming, 0), MAX_PEEKING_CARDS);
  return (
    <section
      aria-label="Getting started"
      data-testid="sidebar-onboarding-checklist"
      data-entry-id={entryId}
      data-upcoming={Math.max(upcoming, 0)}
      className={`getting-started-stack ${peeking === 2 ? 'pt-2' : peeking === 1 ? 'pt-1' : ''}`.trim()}
    >
      <div className="relative">
        {Array.from({ length: peeking }, (_, index) => (
          <div
            key={index}
            aria-hidden="true"
            data-testid="sidebar-onboarding-stack-card"
            className={`getting-started-stack-card getting-started-stack-behind-${String(index + 1)} ${BEHIND_CARD_SURFACE}`}
          />
        ))}
        {title && (
          // Pointer convenience only: the buttons inside are the keyboard
          // targets.
          <div
            key={key}
            ref={frontCardRef}
            onClick={activateFromCard}
            data-testid="sidebar-onboarding-suggestion-row"
            className={`getting-started-stack-card getting-started-stack-front ${FRONT_CARD_SURFACE} ${
              leaving ? 'getting-started-stack-enter' : ''
            } ${actionable ? 'cursor-pointer' : ''}`}
          >
            <StepNotice
              title={title}
              description={description}
              actionLabel={actionLabel}
              skipLabel={skipLabel}
              disabled={disabled}
              onActivate={
                onActivate &&
                ((): void => {
                  rememberFocus();
                  onActivate();
                })
              }
              onSkip={
                onSkip &&
                ((): void => {
                  rememberFocus();
                  onSkip();
                })
              }
            />
          </div>
        )}
        {leaving && (
          <div
            key={`leaving-${leaving.key}`}
            aria-hidden="true"
            inert
            data-testid="sidebar-onboarding-leaving-card"
            onAnimationEnd={(): void => setLeaving(null)}
            className={`getting-started-stack-card getting-started-stack-leave ${FRONT_CARD_SURFACE}`}
          >
            <StepNotice
              title={leaving.title}
              description={leaving.description}
              actionLabel={leaving.actionLabel}
              skipLabel={leaving.skipLabel}
              onSkip={onSkip && ((): void => undefined)}
              testIds={false}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function StepNotice({
  title,
  description,
  actionLabel,
  skipLabel,
  disabled = false,
  onActivate,
  onSkip,
  testIds = true,
}: {
  title: string;
  description?: string;
  actionLabel: string;
  skipLabel: string;
  disabled?: boolean;
  onActivate?: () => void;
  onSkip?: () => void;
  testIds?: boolean;
}): JSX.Element {
  // The pill reads Start; the step's title says what it acts on.
  const titleId = useId();
  return (
    <Notice
      icon={null}
      role="none"
      shape="toast"
      surface="none"
      titleLayout="stacked"
      actionsPlacement="below"
      title={
        <span
          id={titleId}
          data-testid={
            testIds ? 'sidebar-onboarding-suggestion-title' : undefined
          }
        >
          {title}
        </span>
      }
      actions={
        <>
          <NoticeButton
            data-testid={
              testIds ? 'sidebar-onboarding-suggestion-cta' : undefined
            }
            aria-describedby={titleId}
            onClick={onActivate}
            disabled={disabled}
          >
            {actionLabel}
          </NoticeButton>
        </>
      }
      // Skip is the toast's close control, 12px from the card's corner.
      onDismiss={onSkip}
      dismissLabel={skipLabel}
      dismissTestId={testIds ? 'sidebar-onboarding-skip' : undefined}
    >
      {description && (
        <span
          data-testid={
            testIds ? 'sidebar-onboarding-suggestion-description' : undefined
          }
        >
          {description}
        </span>
      )}
    </Notice>
  );
}
