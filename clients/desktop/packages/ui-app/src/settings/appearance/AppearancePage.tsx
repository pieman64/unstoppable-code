'use client';

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  accountAppearanceSchema,
  type ChatDetail,
} from '@canopy/protocol/chat-detail';
import {
  CHAT_DETAIL_COPY,
  CHAT_DETAIL_LABEL,
  ChatDetailControl,
  DelayedLoadingPlaceholder,
  ErrorBanner,
  SettingsFormSkeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';

const ACCOUNT_APPEARANCE_ERROR_SCOPE = 'settings.account.appearance';

function parseChatDetail(value: unknown): ChatDetail {
  const parsed = accountAppearanceSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid account appearance response');
  return parsed.data.chatDetail;
}

/**
 * `/account/appearance`: how chats look, saved on the account. Today it
 * holds "Chat detail", the same picker desktop shows under Display →
 * Appearance. The level shows its requested value while the save runs and
 * goes back if the save fails. Chats read it when they load.
 */
// `account.appearance` page data is empty, so the page takes no props (it
// still satisfies the registry's `SettingsPageProps` component type).
export function AppearancePage(): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(ACCOUNT_APPEARANCE_ERROR_SCOPE);
  const [saved, setSaved] = useState<ChatDetail | null>(null);
  const [requested, setRequested] = useState<ChatDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry so the load effect runs again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(true);
  // Only the newest save may settle the picker.
  const saveGeneration = useRef(0);
  // Saves go out one after another, so the server stores the latest pick
  // last even when picks overlap.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const next = parseChatDetail(
          await client.read('account.appearance.read', {}),
        );
        if (!active) return;
        setSaved(next);
        setLoadError(null);
      } catch (caught: unknown) {
        if (active) setLoadError(errorCopy.loadCopy(caught));
      }
    };
    void load();
    return (): void => {
      active = false;
    };
  }, [client, errorCopy, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setLoadError(null);
    setSaved(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const onChange = useCallback(
    (chatDetail: ChatDetail): void => {
      const generation = ++saveGeneration.current;
      setRequested(chatDetail);
      setError(null);
      const save = async (): Promise<void> => {
        try {
          const next = parseChatDetail(
            await client.write('account.appearance.update', { chatDetail }),
          );
          // Saves finish in order, so each success is what the account holds.
          if (mounted.current) setSaved(next);
        } catch (caught: unknown) {
          if (mounted.current && generation === saveGeneration.current)
            setError(
              errorCopy.actionCopy(caught, { action: 'save your choice' }),
            );
        } finally {
          if (mounted.current && generation === saveGeneration.current)
            setRequested(null);
        }
      };
      saveQueue.current = saveQueue.current.then(save);
    },
    [client, errorCopy],
  );

  const shown = requested ?? saved;
  return (
    <div className="flex flex-col gap-6" data-testid="account-appearance-page">
      {loadError !== null ? (
        <ErrorBanner error={loadError} onRetry={retryLoad} />
      ) : shown === null ? (
        <DelayedLoadingPlaceholder>
          <SettingsFormSkeleton rows={1} />
        </DelayedLoadingPlaceholder>
      ) : (
        <SettingsCard title="Chats" testId="account-appearance-chats">
          <div className="flex flex-col gap-3">
            {error !== null && <ErrorBanner className="" error={error} />}
            <div
              className={SETTINGS_CARD_ROW_CLASS}
              data-testid="settings-chat-detail-row"
            >
              <div className="min-w-0">
                <p className="text-s font-medium fg-primary">
                  {CHAT_DETAIL_LABEL}
                </p>
                <p className="text-s fg-secondary">
                  {CHAT_DETAIL_COPY[shown].description}
                </p>
              </div>
              <ChatDetailControl value={shown} onChange={onChange} />
            </div>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
