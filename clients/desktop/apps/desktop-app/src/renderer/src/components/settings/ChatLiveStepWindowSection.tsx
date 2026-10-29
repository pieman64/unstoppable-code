import { type JSX, useCallback, useEffect, useState } from 'react';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import {
  ensureChatGroupToolCallsSubscription,
  useChatGroupToolCallsStore,
} from '@/stores/chatGroupToolCallsStore';
import {
  ensureChatLiveStepWindowSubscription,
  useChatLiveStepWindowStore,
} from '@/stores/chatLiveStepWindowStore';
import type { ChatPreferenceToggleStore } from '@/stores/chatPreferenceToggleStore';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';

/** One saved on/off chat preference, as a settings row. */
function ChatPreferenceToggleRow({
  useStore,
  ensureSubscription,
  id,
  label,
  description,
  dataTestId,
  onError,
}: {
  useStore: ChatPreferenceToggleStore['useStore'];
  ensureSubscription: () => void;
  id: string;
  label: string;
  description: string;
  dataTestId: string;
  onError: (message: string | null) => void;
}): JSX.Element {
  const enabled = useStore((state) => state.enabled);
  const hydrated = useStore((state) => state.hydrated);
  const setEnabled = useStore((state) => state.setEnabled);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ensureSubscription();
  }, [ensureSubscription]);

  const handleToggle = useCallback(
    (next: boolean): void => {
      setSaving(true);
      onError(null);
      void setEnabled(next)
        .catch(() => {
          onError(SAVE_ERROR_MESSAGE);
        })
        .finally(() => {
          setSaving(false);
        });
    },
    [onError, setEnabled],
  );

  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={description}
      control={
        <ToggleSwitch
          id={id}
          checked={enabled}
          disabled={!hydrated || saving}
          label={label}
          onChange={handleToggle}
          dataTestId={dataTestId}
        />
      }
    />
  );
}

/**
 * Settings → Experiments → "Keep chats short while agents work".
 *
 * Two independent switches, each persisting its own preference through a
 * shared store, so open chats change as soon as one flips, and a change saved
 * in another window shows here too:
 * - "Show only recent steps" (CAN-4274, `chatLiveStepWindowEnabled`);
 * - "Group tool calls" (`chatGroupToolCallsEnabled`).
 * Both are off by default. Saves are optimistic and roll back to the last
 * saved value if they fail.
 */
export function ChatLiveStepWindowSection(): JSX.Element {
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Keep chats short while agents work"
      headingId="settings-chat-live-step-window-heading"
      dataTestId="settings-chat-live-step-window"
    >
      <ErrorBanner className="" error={saveError} />
      <SettingsGroup>
        <ChatPreferenceToggleRow
          useStore={useChatLiveStepWindowStore}
          ensureSubscription={ensureChatLiveStepWindowSubscription}
          id="settings-chat-live-step-window-toggle"
          label="Show only recent steps"
          description="While an agent works, the chat shows its three most recent steps. Agent messages still show in full. Open a step row to see every step."
          dataTestId="chat-live-step-window-toggle"
          onError={setSaveError}
        />
        <ChatPreferenceToggleRow
          useStore={useChatGroupToolCallsStore}
          ensureSubscription={ensureChatGroupToolCallsSubscription}
          id="settings-chat-group-tool-calls-toggle"
          label="Group tool calls"
          description="Show back-to-back tool calls as one row, like “Ran 3 commands”. Open the row to see each call."
          dataTestId="chat-group-tool-calls-toggle"
          onError={setSaveError}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
