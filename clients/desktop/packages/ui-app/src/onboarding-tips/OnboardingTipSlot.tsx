import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import {
  useCapabilities,
  useOnboardingTipsStore,
  useWorkspaceCapabilities,
  type OnboardingTipWorktreeChat,
} from '@canopy/app-state';
import {
  isOnboardingTipId,
  type OnboardingTipId,
} from '@canopy/protocol/onboarding-tips';
import {
  OnboardingTip,
  type OnboardingTipPlacement,
  type OnboardingTipProps,
} from '@canopy/ui-shared/components';
import { ONBOARDING_TIP_COPY, type OnboardingTipContext } from './tip-copy';

export interface OnboardingTipSlotProps {
  readonly placement: OnboardingTipPlacement;
  /**
   * The tips that apply to what is on screen, highest priority first. Pass
   * the ids in `ONBOARDING_TIP_IDS` order; tips for the other placement are
   * ignored.
   */
  readonly eligible: readonly OnboardingTipId[];
  /**
   * Changes when the user arrives somewhere new (a tab, a chat). A tip is
   * chosen only on arrival, so dismissing one never brings up the next on
   * the same screen, and a rerender or a transcript that finishes loading is
   * not a new arrival.
   */
  readonly arrivalKey: string;
  /**
   * The worktree chat on screen, which the `worktree-chat` tip requires: it
   * shows only to a first-time worktree user (CAN-5005). Pass `loading` until
   * the chat and its transcript have loaded; an absent chat is not empty.
   */
  readonly worktreeChat?: OnboardingTipWorktreeChat;
  /**
   * The workspace or worktree the tips are about. When it is on a host that
   * keeps no dismissals (a cloud worktree beside a paired desktop), no tip
   * applies there.
   */
  readonly scopeLocalId?: string;
  readonly context?: OnboardingTipContext;
  /** What a tip's verb does; the tip is dismissed as it runs. */
  readonly onAction?: Partial<Record<OnboardingTipId, () => void>>;
  /** How a composer tip draws: a drawer section or its own notice. */
  readonly appearance?: OnboardingTipProps['appearance'];
  /** Placement only (margins), applied while a tip shows. */
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/**
 * One place a tip can show (CAN-4904). Every mounted slot shares one queue,
 * so at most one tip is on screen, and one dismissal store per host. Renders
 * nothing on a host that keeps no dismissals. Hosts report accepted turns and
 * automatic notices to the store (`noteTurnSent`, `holdForNotice`), which
 * holds every tip after a notice until the user sends (CAN-5005).
 */
export function OnboardingTipSlot({
  placement,
  eligible,
  arrivalKey,
  worktreeChat,
  scopeLocalId,
  context = {},
  onAction,
  appearance,
  className,
  'data-testid': testId,
}: OnboardingTipSlotProps): JSX.Element {
  const slot = useId();
  const status = useOnboardingTipsStore((state) => state.status);
  const current = useOnboardingTipsStore((state) => state.current);
  const load = useOnboardingTipsStore((state) => state.load);
  const arrive = useOnboardingTipsStore((state) => state.arrive);
  const leave = useOnboardingTipsStore((state) => state.leave);
  const dismiss = useOnboardingTipsStore((state) => state.dismiss);

  const scopeCapabilities = useWorkspaceCapabilities(scopeLocalId ?? '');
  const scopeKeepsTips =
    scopeLocalId === undefined || scopeCapabilities.onboardingTips === true;
  // A string, so a new array with the same tips is not a new arrival.
  const eligibleKey = scopeKeepsTips
    ? eligible
        .filter((id) => ONBOARDING_TIP_COPY[id].placement === placement)
        .join(' ')
    : '';

  // Reads once; a store left unavailable (no paired desktop yet, or a failed
  // read) tries again when the host gains the capability or the user arrives.
  const hostKeepsTips = useCapabilities().onboardingTips === true;
  useEffect(() => {
    load();
  }, [arrivalKey, hostKeepsTips, load]);

  // Hosts keep some surfaces mounted while another page or tab is on screen
  // (desktop keeps the main page and unselected chat tabs mounted, hidden).
  // A hidden slot must not hold the one tip, and coming back into view is a
  // new visit.
  const sentinel = useRef<HTMLSpanElement | null>(null);
  const shown = useRenderedOnScreen(sentinel);

  const ready = status === 'ready';
  const worktreeChatId = worktreeChat?.chatId;
  const workspaceId = worktreeChat?.workspaceLocalId;
  const worktreeId = worktreeChat?.worktreeLocalId;
  const worktreeTranscript = worktreeChat?.transcript;
  const newlyCreated = worktreeChat?.newlyCreated;
  useEffect(() => {
    if (!shown) {
      leave(slot);
      return;
    }
    arrive(slot, eligibleKey.split(' ').filter(isOnboardingTipId), {
      key: arrivalKey,
      ...(worktreeChatId !== undefined &&
      worktreeTranscript !== undefined &&
      workspaceId !== undefined &&
      worktreeId !== undefined
        ? {
            worktreeChat: {
              chatId: worktreeChatId,
              workspaceLocalId: workspaceId,
              worktreeLocalId: worktreeId,
              transcript: worktreeTranscript,
              newlyCreated,
            },
          }
        : {}),
    });
  }, [
    arrivalKey,
    arrive,
    eligibleKey,
    leave,
    ready,
    shown,
    slot,
    worktreeChatId,
    workspaceId,
    worktreeId,
    worktreeTranscript,
    newlyCreated,
  ]);

  useEffect(() => (): void => leave(slot), [leave, slot]);

  const marker = (
    <span ref={sentinel} aria-hidden="true" className="block h-0 w-full" />
  );
  if (current === null || current.slot !== slot) return marker;
  const tipId = current.tipId;
  const copy = ONBOARDING_TIP_COPY[tipId];
  const runAction = onAction?.[tipId];
  return (
    <>
      {marker}
      <OnboardingTip
        placement={placement}
        icon={copy.icon}
        title={copy.title(context)}
        action={
          copy.actionLabel !== undefined && runAction !== undefined
            ? {
                label: copy.actionLabel,
                onClick: (): void => {
                  dismiss(tipId);
                  runAction();
                },
                ...(testId ? { testId: `${testId}-action` } : {}),
              }
            : undefined
        }
        onDismiss={(): void => dismiss(tipId)}
        appearance={appearance}
        className={className}
        data-testid={testId}
      >
        {copy.body(context)}
      </OnboardingTip>
    </>
  );
}

/**
 * Whether an element is rendered on screen: not inside a `display: none` or
 * `visibility: hidden` ancestor. Unknown (false) until measured before the
 * first paint, so a hidden slot never claims the tip for a moment. A size
 * change is how a hidden page or tab shows again, so a ResizeObserver
 * re-checks then. Hosts without layout (a test DOM) count as shown.
 */
function useRenderedOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (typeof element.checkVisibility !== 'function') {
      setShown(true);
      return;
    }
    const check = (): void => {
      setShown(element.checkVisibility({ visibilityProperty: true }));
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [ref]);
  return shown;
}
