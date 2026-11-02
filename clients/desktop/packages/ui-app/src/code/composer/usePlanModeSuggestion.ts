'use client';

import {
  isPlanModeHintAvailable,
  type PlanModeHintStore,
} from '@canopy/app-state';
import { useComposerTipClaim } from '@canopy/ui-shared/components';
import {
  PLAN_MODE_SUGGESTION_DEBOUNCE_MS,
  isLongMultiStepPrompt,
} from '@canopy/ui-shared/lib';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

export interface UsePlanModeSuggestionOptions {
  /** The composer's current draft text. Attachments do not contribute. */
  text: string;
  /**
   * Identifies the draft session: the composer and its conversation or
   * target. A new key, an accepted send, or clearing the text starts a new
   * session; editing the same draft does not.
   */
  draftKey: string;
  /** Effective enable target/provider; changes cancel stale activation without replacing the draft. */
  activationKey?: string;
  planMode: boolean;
  /** The host's effective capability: Plan is offered in this composer. */
  planAvailable: boolean;
  /** The provider exposes Plan only as a read-only mode. */
  planReadOnly: boolean;
  /** Pipeline or terminal mode. */
  pipelineMode: boolean;
  /** This is the active, visible composer. */
  active: boolean;
  /** IME composition in progress. */
  composing: boolean;
  /** Null while the host's persistence scope is not available. */
  store: PlanModeHintStore | null;
  /**
   * Turn plan mode on in this composer without touching the draft. Resolve
   * whether it actually turned on, including asynchronous failure.
   */
  onEnablePlanMode: () => boolean | Promise<boolean>;
  /** Host telemetry, once per actual presentation. */
  onShown?: () => void;
  /** Host telemetry, only after plan mode turned on. */
  onAccepted?: () => void;
  onDismissed?: () => void;
  /** Return focus to the composer when an action removes the notice. */
  focusComposer?: () => void;
}

export interface PlanModeSuggestion {
  visible: boolean;
  /** Plan mode is being turned on: further activation is disabled. */
  pending: boolean;
  accept: () => Promise<void>;
  dismiss: () => void;
}

interface DraftSession {
  key: string;
  scope: PlanModeHintStore | null;
  /** Presented and then hidden: it does not reappear in this session. */
  done: boolean;
  presented: boolean;
}

const NO_STORE_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * Suggest plan mode for a long, multi-step draft (CAN-4008). Evaluates
 * after the debounce, at most once per draft session, and never intercepts
 * or delays sending. Retirement in any composer sharing the store hides it
 * everywhere.
 */
export function usePlanModeSuggestion({
  text,
  draftKey,
  activationKey,
  planMode,
  planAvailable,
  planReadOnly,
  pipelineMode,
  active,
  composing,
  store,
  onEnablePlanMode,
  onShown,
  onAccepted,
  onDismissed,
  focusComposer,
}: UsePlanModeSuggestionOptions): PlanModeSuggestion {
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      store === null ? (): void => undefined : store.subscribe(listener),
    [store],
  );
  const available = useSyncExternalStore(
    store === null ? NO_STORE_SUBSCRIPTION : subscribe,
    () => store !== null && isPlanModeHintAvailable(store.getState()),
    () => false,
  );
  const gate =
    available &&
    active &&
    planAvailable &&
    !planReadOnly &&
    !planMode &&
    !pipelineMode &&
    !composing;

  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const session = useRef<DraftSession>({
    key: draftKey,
    scope: store,
    done: false,
    presented: false,
  });
  const activationAllowed =
    active && planAvailable && !planReadOnly && !pipelineMode && !composing;
  // Hosts may project Plan optimistically before its acknowledgement. Keep
  // this existing notice disabled through that request so rejection restores
  // it; every other capability/visibility gate still hides it immediately.
  const awaitingActivation = pending && available && activationAllowed;
  const presentationGate = gate || awaitingActivation;
  const { visible: tipAllowed, isVisible: isTipAllowed } = useComposerTipClaim(
    'plan-mode',
    presentationGate &&
      (session.current.key !== draftKey ||
        session.current.scope !== store ||
        !session.current.done) &&
      isLongMultiStepPrompt(text),
  );
  const latest = useRef({
    draftKey,
    activationKey,
    gate,
    visible: visible && tipAllowed,
    store,
    activationAllowed,
    text,
  });
  latest.current = {
    draftKey,
    activationKey,
    gate,
    visible: visible && tipAllowed,
    store,
    activationAllowed,
    text,
  };
  const activating = useRef(false);
  const activationId = useRef(0);
  const callbacks = useRef({
    onEnablePlanMode,
    onShown,
    onAccepted,
    onDismissed,
    focusComposer,
  });
  callbacks.current = {
    onEnablePlanMode,
    onShown,
    onAccepted,
    onDismissed,
    focusComposer,
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    activationId.current += 1;
    activating.current = false;
    setPending(false);
  }, [activationKey]);

  const empty = text.trim() === '';
  useEffect(() => {
    const replaced =
      session.current.key !== draftKey || session.current.scope !== store;
    if (replaced || empty) {
      session.current = {
        key: draftKey,
        scope: store,
        done: false,
        presented: false,
      };
      activationId.current += 1;
      activating.current = false;
      setPending(false);
      setVisible(false);
      if (empty) return undefined;
    }
    if (!replaced && visible) {
      if (!presentationGate || !isLongMultiStepPrompt(text)) {
        session.current.done = true;
        setVisible(false);
      }
      if (!tipAllowed) setVisible(false);
      return undefined;
    }
    // Arbitration pauses presentation without retiring this draft session.
    if (!tipAllowed) {
      setVisible(false);
      return undefined;
    }
    if (session.current.done || !gate || composing) return undefined;
    const timer = setTimeout(() => {
      if (
        session.current.done ||
        session.current.key !== draftKey ||
        !isLongMultiStepPrompt(text)
      ) {
        return;
      }
      setVisible(true);
    }, PLAN_MODE_SUGGESTION_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [
    text,
    empty,
    draftKey,
    gate,
    presentationGate,
    tipAllowed,
    composing,
    visible,
    store,
  ]);

  const actuallyVisible =
    visible &&
    tipAllowed &&
    presentationGate &&
    session.current.key === draftKey &&
    session.current.scope === store &&
    isLongMultiStepPrompt(text);
  useEffect(() => {
    if (!actuallyVisible || !isTipAllowed() || session.current.presented)
      return;
    session.current.presented = true;
    callbacks.current.onShown?.();
    void store?.getState().markShown();
  }, [actuallyVisible, isTipAllowed, store]);

  const accept = useCallback(async () => {
    const {
      draftKey: key,
      activationKey: enableKey,
      gate: open,
      visible: shown,
      store: scope,
      text: draft,
    } = latest.current;
    if (
      !shown ||
      !open ||
      !isTipAllowed() ||
      activating.current ||
      !isLongMultiStepPrompt(draft)
    )
      return;
    const acceptedSession = session.current;
    const generation = scope?.getState().record?.generation;
    const attempt = ++activationId.current;
    activating.current = true;
    setPending(true);
    let enabled = false;
    try {
      enabled = await callbacks.current.onEnablePlanMode();
    } catch {
      enabled = false;
    }
    if (activationId.current !== attempt) return;
    activating.current = false;
    if (!mounted.current) return;
    setPending(false);
    // A failed enable keeps the suggestion; a stale target never retires it.
    if (
      !enabled ||
      session.current !== acceptedSession ||
      latest.current.draftKey !== key ||
      latest.current.activationKey !== enableKey ||
      latest.current.store !== scope ||
      scope?.getState().record?.generation !== generation ||
      !latest.current.activationAllowed ||
      !isLongMultiStepPrompt(latest.current.text)
    )
      return;
    session.current.done = true;
    setVisible(false);
    void store?.getState().markTried();
    callbacks.current.onAccepted?.();
    callbacks.current.focusComposer?.();
  }, [store, isTipAllowed]);

  const dismiss = useCallback(() => {
    if (!latest.current.visible || !latest.current.gate || !isTipAllowed())
      return;
    session.current.done = true;
    setVisible(false);
    void store?.getState().markDismissed();
    callbacks.current.onDismissed?.();
    callbacks.current.focusComposer?.();
  }, [store, isTipAllowed]);

  return { visible: actuallyVisible, pending, accept, dismiss };
}
