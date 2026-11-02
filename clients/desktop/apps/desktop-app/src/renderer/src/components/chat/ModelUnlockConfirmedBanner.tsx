import { useCallback, useEffect, useState, type JSX } from 'react';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { ModelUnlockConfirmedNotice } from '@canopy/ui-shared/components';
import {
  useChatTargetAiCreditsScope,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';
import {
  dismissModelUnlockConfirmation,
  ensureModelUnlockConfirmationBalance,
  selectModelUnlockConfirmationAdded,
  selectModelUnlockConfirmationCredits,
  selectModelUnlockConfirmationForChat,
  useModelUnlockConfirmationStore,
} from '@/lib/modelUnlockConfirmation';
import { readBillingOwnerKey } from '@/lib/openBillingPage';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';

interface ModelUnlockConfirmedBannerProps {
  target: ChatBannerTarget | null;
  /** The chat's committed model, read live so the sentence tracks it. */
  model: string | undefined;
}

/**
 * The composer's confirmation of a confirmed advanced-model unlock
 * (CAN-5027), in the chat the purchase started in.
 *
 * Shows only once this chat's billing owner is the one checkout was opened
 * for; the balance is read only for a personal owner, because the purchase
 * funded the personal wallet. Wait until the owner can be established before
 * showing any account-scoped confirmation.
 */
export function ModelUnlockConfirmedBanner({
  target,
  model,
}: ModelUnlockConfirmedBannerProps): JSX.Element | null {
  const confirmation = useModelUnlockConfirmationStore((state) =>
    selectModelUnlockConfirmationForChat(state, target),
  );
  const { scope, key: scopeKey } = useStableAiCreditsScope(
    useChatTargetAiCreditsScope(target),
  );
  const requestId = confirmation?.requestId;

  // The owner read is keyed by request and scope, so an answer about another
  // chat or an earlier confirmation is never used.
  const ownerReadKey =
    requestId !== undefined && scope !== undefined
      ? `${requestId}|${scopeKey}`
      : null;
  const [ownerRead, setOwnerRead] = useState<{
    key: string;
    owner: string | null;
  } | null>(null);
  useEffect(() => {
    if (ownerReadKey === null) return undefined;
    let cancelled = false;
    const settle = (owner: string | null): void => {
      if (!cancelled) setOwnerRead({ key: ownerReadKey, owner });
    };
    readBillingOwnerKey(scope).then(settle, (): void => settle(null));
    return (): void => {
      cancelled = true;
    };
  }, [ownerReadKey, scope]);
  const owner = ownerRead?.key === ownerReadKey ? ownerRead.owner : undefined;

  const readsBalance =
    confirmation !== null &&
    confirmation.owner === 'personal' &&
    owner === 'personal';
  useEffect(() => {
    if (!readsBalance || requestId === undefined || scope === undefined) {
      return;
    }
    return ensureModelUnlockConfirmationBalance(requestId, scope, scopeKey);
  }, [readsBalance, requestId, scope, scopeKey]);
  const credits = useModelUnlockConfirmationStore((state) =>
    readsBalance
      ? selectModelUnlockConfirmationCredits(state, requestId, scopeKey)
      : null,
  );

  // The amount added, when the balance read before checkout opened was the
  // same wallet (CAN-5160); the title then names it like every purchase path.
  const addedCredits = useModelUnlockConfirmationStore((state) =>
    readsBalance
      ? selectModelUnlockConfirmationAdded(state, requestId, scopeKey)
      : null,
  );

  const handleDismiss = useCallback((): void => {
    if (requestId !== undefined) dismissModelUnlockConfirmation(requestId);
  }, [requestId]);

  // Wait for the owner, and stay silent for a chat that now belongs to a
  // different owner than the one that paid.
  if (confirmation === null || owner !== confirmation.owner) {
    return null;
  }
  const modelLabel =
    confirmation.modelId !== null && model === confirmation.modelId
      ? getModelDisplayName(model)
      : undefined;
  return (
    <ModelUnlockConfirmedNotice
      {...(credits !== null ? { credits } : {})}
      {...(addedCredits !== null ? { addedCredits } : {})}
      {...(modelLabel !== undefined ? { modelLabel } : {})}
      onDismiss={handleDismiss}
    />
  );
}
