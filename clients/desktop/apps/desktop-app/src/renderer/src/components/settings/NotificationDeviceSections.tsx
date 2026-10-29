import { type JSX, type ReactNode, useId } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import {
  IN_APP_NOTIFICATION_PLACEMENTS,
  OS_NOTIFICATION_CATEGORY_SOUNDS,
  OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
  type InAppNotificationPlacement,
  type NotificationCategoryKey,
  type OsNotificationCategorySound,
  type OsNotificationTopLevelSound,
  type PromotionalNotificationCategory,
} from '@canopy/desktop-shared/types';
import {
  osNotificationSoundsForPlatform,
  resolveOsNotificationSoundForPlatform,
} from '@canopy/desktop-shared/notification-sounds';
import { brandText } from '@/lib/brand';
import { defaultInAppNotificationPlacement } from '@/lib/useInAppNotificationPlacement';
import { pt } from '@/lib/platform-text';
import { localPlatform } from '@/lib/local-platform';
import { uiText } from '@/lib/ui-text';
import { Button, Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import { SettingsRow, SettingsSelect, SettingsSubRow } from './SettingsLayout';
import { SETTINGS_CHECK_INPUT_CLASS_NAME } from './settings-classes';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';
import type {
  NotificationSettingsController,
  NotificationTestStatus,
} from './notification-settings';

// The bodies of this computer's notification settings, as bare rows. The
// local Notifications tab wraps each in a section and group; the hosted
// Notifications page puts them in device cards. They live in their own module
// so both chunks share one copy.

interface NotificationRowsProps {
  settings: NotificationSettingsController;
}

interface CategoryEntry {
  key: NotificationCategoryKey;
  label: string;
  description: string;
}

const CATEGORY_ENTRIES: CategoryEntry[] = [
  {
    key: 'chat',
    label: CHAT_UNIT_LABEL,
    description: `Assistant turn completions, plan approvals, and ${CHAT_UNIT_LABEL} alerts`,
  },
  {
    key: 'script',
    label: 'Script',
    description: 'Script run completions and failures',
  },
  {
    key: 'hook',
    label: 'Hook',
    description: 'Hook execution results',
  },
  {
    key: 'gitCommit',
    label: 'Git commit',
    description: 'Commit success and failure notifications',
  },
  {
    key: 'gitPush',
    label: 'Git push',
    description: 'Push success and failure notifications',
  },
  {
    key: 'prCreate',
    label: 'PR create',
    description: 'Pull request creation results',
  },
  {
    key: 'pipeline',
    label: 'Pipeline',
    description: 'Pipeline completion and worktree lifecycle alerts',
  },
  {
    key: 'terminal',
    label: 'Terminal',
    description: 'Terminal command completion and exit notifications',
  },
  {
    key: 'runComment',
    label: 'Run comment',
    description: 'Replies and new comments on a run you shared',
  },
];

interface PromotionalChildEntry {
  key: PromotionalNotificationCategory;
  label: string;
  description: string;
  testId: string;
}

/**
 * Children of the promotional master (CAN-3013). They replace the flat
 * `activation` row the category matrix used to carry: campaigns are sent by
 * main as OS notifications only, so the matrix's in-app and sound columns
 * never applied to them.
 */
const PROMOTIONAL_CHILD_ENTRIES: PromotionalChildEntry[] = [
  {
    key: 'gettingStarted',
    label: 'Getting started notifications',
    description: 'At most one tip a day until you finish the setup checklist',
    testId: 'notifications-toggle-promotional-getting-started',
  },
  {
    key: 'arbitrary',
    label: 'Other promotional notifications',
    description: 'Occasional product tips and offers',
    testId: 'notifications-toggle-promotional-arbitrary',
  },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_unused, hour) => (
  <option key={hour} value={hour}>
    {`${String(hour).padStart(2, '0')}:00`}
  </option>
));

// Category, In-app, OS notification (checkbox + sound + test).
const CATEGORY_GRID_COLUMNS = '1fr 3.5rem 15rem';

/** In-app banners: the on/off switch and where banners appear. */
export function InAppNotificationRows({
  settings,
}: NotificationRowsProps): JSX.Element {
  const { inAppPrefs } = settings;
  return (
    <>
      <ToggleRow
        label="Show in-app banners"
        description={`Banners inside ${brandText.appName} for the events you choose below. Separate from OS notifications.`}
        checked={inAppPrefs.enabled}
        onChange={(value) => {
          void settings.handleInAppEnabledToggle(value);
        }}
        testId="notifications-toggle-in-app-enabled"
      />
      <SettingsRow
        label="Placement"
        htmlFor="notifications-in-app-placement"
        description="Where banners appear in the window."
        control={
          <PlacementSelect
            id="notifications-in-app-placement"
            value={inAppPrefs.placement ?? defaultInAppNotificationPlacement()}
            disabled={!inAppPrefs.enabled}
            onChange={(value) => {
              void settings.handleInAppPlacementChange(value);
            }}
            testId="notifications-select-in-app-placement"
          />
        }
      />
    </>
  );
}

/**
 * OS notifications: the master switch, focus skip, default sound, quiet
 * hours and close-to-tray (journey-gated), and the test notification.
 */
export function OsNotificationRows({
  settings,
}: NotificationRowsProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const {
    osPrefs,
    quietHours,
    closeToTray,
    loadFailed,
    testStatus,
    activationJourneyEnabled,
    isWindows,
    persistQuietHours,
  } = settings;
  return (
    <>
      <ToggleRow
        label="Send OS notifications"
        description={`Native desktop notifications, so you are alerted while ${brandText.appName} is in the background.`}
        checked={osPrefs.enabled}
        onChange={(value) => {
          void settings.handleMasterToggle(value);
        }}
        testId="notifications-toggle-master"
      />
      <ToggleRow
        label={`Skip while ${brandText.appName} is focused`}
        description="Don't send an OS notification for events already visible in the app."
        checked={osPrefs.skipWhenFocused}
        disabled={!osPrefs.enabled}
        onChange={(value) => {
          void settings.handleSkipWhenFocusedToggle(value);
        }}
        testId="notifications-toggle-skip-when-focused"
      />
      <SettingsRow
        label="Default sound"
        htmlFor="notifications-default-sound"
        control={
          <SoundSelect
            id="notifications-default-sound"
            value={osPrefs.defaultSound}
            disabled={!osPrefs.enabled}
            includeDefault={false}
            onChange={(value) => {
              if (isTopLevelSoundValue(value)) {
                void settings.handleDefaultSoundChange(value);
              }
            }}
            testId="notifications-default-sound"
          />
        }
      />
      {activationJourneyEnabled && (
        <ToggleRow
          label="Quiet hours for promotional notifications"
          checked={quietHours.enabled}
          disabled={loadFailed}
          onChange={(value) => {
            void persistQuietHours({ ...quietHours, enabled: value });
          }}
          testId="notifications-toggle-quiet-hours"
        >
          {quietHours.enabled && (
            <SettingsSubRow
              label="Hours"
              description={
                quietHours.startHour === quietHours.endHour
                  ? 'Start and end are the same, so no quiet time applies. Pick different hours.'
                  : 'Holds promotional notifications only. Agent and pipeline alerts still come through.'
              }
              control={
                <>
                  <label
                    htmlFor="quiet-hours-start"
                    className="text-xs fg-secondary"
                  >
                    From
                  </label>
                  <SettingsSelect
                    width="fit"
                    id="quiet-hours-start"
                    value={quietHours.startHour}
                    onChange={(event) => {
                      void persistQuietHours({
                        ...quietHours,
                        startHour: Number(event.target.value),
                      });
                    }}
                    data-testid="notifications-quiet-hours-start"
                  >
                    {HOUR_OPTIONS}
                  </SettingsSelect>
                  <label
                    htmlFor="quiet-hours-end"
                    className="text-xs fg-secondary"
                  >
                    to
                  </label>
                  <SettingsSelect
                    width="fit"
                    id="quiet-hours-end"
                    value={quietHours.endHour}
                    onChange={(event) => {
                      void persistQuietHours({
                        ...quietHours,
                        endHour: Number(event.target.value),
                      });
                    }}
                    data-testid="notifications-quiet-hours-end"
                  >
                    {HOUR_OPTIONS}
                  </SettingsSelect>
                </>
              }
            />
          )}
        </ToggleRow>
      )}
      {/*
        Windows-only: closing the window quits the app there, which ends
        every scheduled notification. macOS keeps the app alive on window
        close by platform convention, so the toggle would be a no-op, and
        Linux is excluded because tray support varies by desktop
        environment.
      */}
      {activationJourneyEnabled && isWindows && (
        <ToggleRow
          label="Keep running in the tray when the window closes"
          checked={closeToTray}
          disabled={loadFailed}
          onChange={(value) => {
            void settings.handleCloseToTrayToggle(value);
          }}
          testId="notifications-toggle-close-to-tray"
        />
      )}
      <SettingsRow
        label="Test notification"
        description={pt(uiText.notifications.permissionHelper)}
        control={
          <Button
            size={settingsButtonSize}
            variant="secondary"
            onClick={() => {
              void settings.handleTestNotification();
            }}
            disabled={!osPrefs.enabled || testStatus === 'sending'}
            data-testid="notifications-test-button"
          >
            Send test
          </Button>
        }
      >
        <TestStatusHint status={testStatus} />
      </SettingsRow>
    </>
  );
}

/**
 * The promotional master and its children. Nothing while the activation
 * journey is dark.
 */
export function PromotionalNotificationRows({
  settings,
}: NotificationRowsProps): JSX.Element | null {
  const { promoPrefs, loadFailed, activationJourneyEnabled } = settings;
  if (!activationJourneyEnabled) return null;
  return (
    <ToggleRow
      label="All promotional notifications"
      checked={promoPrefs.enabled}
      disabled={loadFailed}
      onChange={(value) => {
        void settings.persistPromotional({ enabled: value });
      }}
      testId="notifications-toggle-promotional-master"
    >
      <div
        className="flex flex-col gap-2"
        data-testid="notifications-promotional-children"
      >
        {PROMOTIONAL_CHILD_ENTRIES.map((entry) => (
          <ToggleSubRow
            key={entry.key}
            label={entry.label}
            description={entry.description}
            checked={promoPrefs[entry.key]}
            disabled={!promoPrefs.enabled || loadFailed}
            onChange={(value) => {
              void settings.persistPromotional({ [entry.key]: value });
            }}
            testId={entry.testId}
          />
        ))}
      </div>
    </ToggleRow>
  );
}

/**
 * Why the promotional and quiet-hours controls are locked after a failed
 * read. Nothing when the read succeeded or the journey is dark.
 */
export function PromotionalNotificationsLoadFailedNotice({
  settings,
}: NotificationRowsProps): JSX.Element | null {
  if (!settings.loadFailed || !settings.activationJourneyEnabled) return null;
  return (
    <Notice
      intent="attention"
      title="Reopen Settings to change these"
      data-testid="notifications-promotional-load-failed"
    >
      Your saved choices could not be read, so these promotional and quiet-hours
      settings show defaults and are locked to keep them from being overwritten.
    </Notice>
  );
}

/** The category matrix: a header row, then one row per event category. */
export function CategoryRows({ settings }: NotificationRowsProps): JSX.Element {
  const { inAppPrefs, osPrefs } = settings;
  const inAppDisabled = !inAppPrefs.enabled;
  const osDisabled = !osPrefs.enabled;
  return (
    <>
      <div
        className="grid items-center gap-x-4 text-xs fg-tertiary"
        style={{ gridTemplateColumns: CATEGORY_GRID_COLUMNS }}
      >
        <span>Category</span>
        <span className="text-center">In-app</span>
        <span>OS notification</span>
      </div>
      {CATEGORY_ENTRIES.map((entry) => (
        <CategoryMatrixRow
          key={entry.key}
          entry={entry}
          inAppChecked={inAppPrefs.categories[entry.key]}
          inAppDisabled={inAppDisabled}
          osChecked={osPrefs.categories[entry.key]}
          osDisabled={osDisabled}
          sound={osPrefs.categorySounds[entry.key]}
          onInAppToggle={(value) => {
            void settings.handleInAppCategoryToggle(entry.key, value);
          }}
          onOsToggle={(value) => {
            void settings.handleOsCategoryToggle(entry.key, value);
          }}
          onSoundChange={(value) => {
            if (isCategorySoundValue(value)) {
              void settings.handleCategorySoundChange(entry.key, value);
            }
          }}
          onTest={() => {
            void settings.handleTestCategory(entry.key);
          }}
        />
      ))}
    </>
  );
}

function TestStatusHint({
  status,
}: {
  status: NotificationTestStatus;
}): JSX.Element | null {
  if (status === 'idle') return null;
  if (status === 'sending') {
    return <span className="text-s fg-secondary">Sending&hellip;</span>;
  }
  if (status === 'shown') {
    return <span className="text-s fg-success">Test notification sent.</span>;
  }
  if (status === 'unsupported') {
    return (
      <span className="text-s fg-destructive">
        Notifications are not supported on this platform.
      </span>
    );
  }
  return (
    <span className="text-s fg-destructive">
      {pt(uiText.notifications.failure)}
    </span>
  );
}

interface CategoryMatrixRowProps {
  entry: CategoryEntry;
  inAppChecked: boolean;
  inAppDisabled: boolean;
  osChecked: boolean;
  osDisabled: boolean;
  sound: OsNotificationCategorySound;
  onInAppToggle: (next: boolean) => void;
  onOsToggle: (next: boolean) => void;
  onSoundChange: (next: string) => void;
  onTest: () => void;
}

function CategoryMatrixRow({
  entry,
  inAppChecked,
  inAppDisabled,
  osChecked,
  osDisabled,
  sound,
  onInAppToggle,
  onOsToggle,
  onSoundChange,
  onTest,
}: CategoryMatrixRowProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  return (
    <div
      className="grid items-center gap-x-4"
      style={{ gridTemplateColumns: CATEGORY_GRID_COLUMNS }}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-s font-medium fg-primary">{entry.label}</span>
        <span className="text-xs fg-secondary">{entry.description}</span>
      </div>
      <div className="flex justify-center">
        <input
          type="checkbox"
          className={SETTINGS_CHECK_INPUT_CLASS_NAME}
          checked={inAppChecked}
          disabled={inAppDisabled}
          onChange={(e) => onInAppToggle(e.target.checked)}
          aria-label={`Show in-app banner for ${entry.label}`}
          data-testid={`notifications-toggle-in-app-${entry.key}`}
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className={SETTINGS_CHECK_INPUT_CLASS_NAME}
          checked={osChecked}
          disabled={osDisabled}
          onChange={(e) => onOsToggle(e.target.checked)}
          aria-label={`Send OS notification for ${entry.label}`}
          data-testid={`notifications-toggle-os-${entry.key}`}
        />
        <SoundSelect
          width="fill"
          value={sound}
          disabled={osDisabled || !osChecked}
          includeDefault
          onChange={onSoundChange}
          testId={`notifications-sound-${entry.key}`}
        />
        <Button
          size={settingsButtonSize}
          variant="ghost"
          onClick={onTest}
          disabled={osDisabled || !osChecked}
          aria-label={`Test ${entry.label} notification`}
          data-testid={`notifications-test-${entry.key}`}
        >
          Test
        </Button>
      </div>
    </div>
  );
}

interface SoundSelectProps {
  id?: string;
  /** `fill` inside the category table's column; the row control otherwise. */
  width?: 'control' | 'fill';
  value: string;
  disabled?: boolean;
  includeDefault: boolean;
  onChange: (next: string) => void;
  testId?: string;
}

function SoundSelect({
  id,
  width = 'control',
  value,
  disabled = false,
  includeDefault,
  onChange,
  testId,
}: SoundSelectProps): JSX.Element {
  // The OS only plays the sounds its own platform offers, so the list is the
  // platform's. A saved sound from another platform shows as System, which is
  // what actually plays. The toast always plays on this computer, so in a
  // window that shows another computer the list is still this one's.
  const platform = localPlatform();
  const platformSounds = osNotificationSoundsForPlatform(platform);
  const options: readonly string[] = includeDefault
    ? ['Default', ...platformSounds]
    : platformSounds;
  const shownValue = resolveOsNotificationSoundForPlatform(
    isCategorySoundValue(value) ? value : 'System',
    platform,
  );
  return (
    <SettingsSelect
      id={id}
      width={width}
      value={shownValue}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </SettingsSelect>
  );
}

function isTopLevelSoundValue(
  value: string,
): value is OsNotificationTopLevelSound {
  return OS_NOTIFICATION_TOP_LEVEL_SOUNDS.some((option) => option === value);
}

function isCategorySoundValue(
  value: string,
): value is OsNotificationCategorySound {
  return OS_NOTIFICATION_CATEGORY_SOUNDS.some((option) => option === value);
}

function isInAppNotificationPlacementValue(
  value: string,
): value is InAppNotificationPlacement {
  return IN_APP_NOTIFICATION_PLACEMENTS.some((option) => option === value);
}

/** Options read in sentence case; the stored values stay the same. */
const PLACEMENT_LABELS: Record<InAppNotificationPlacement, string> = {
  'top-right': 'Top right',
  'bottom-right': 'Bottom right',
  'bottom-left': 'Bottom left',
  'top-left': 'Top left',
};

interface PlacementSelectProps {
  id?: string;
  value: InAppNotificationPlacement;
  disabled?: boolean;
  onChange: (next: InAppNotificationPlacement) => void;
  testId?: string;
}

function PlacementSelect({
  id,
  value,
  disabled = false,
  onChange,
  testId,
}: PlacementSelectProps): JSX.Element {
  return (
    <SettingsSelect
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const nextValue = e.target.value;
        if (isInAppNotificationPlacementValue(nextValue)) {
          onChange(nextValue);
        }
      }}
      data-testid={testId}
    >
      {IN_APP_NOTIFICATION_PLACEMENTS.map((option) => (
        <option key={option} value={option}>
          {PLACEMENT_LABELS[option]}
        </option>
      ))}
    </SettingsSelect>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
  children?: ReactNode;
}

/** One on/off setting: a switch on the row's trailing edge. */
function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
  testId,
  children,
}: ToggleRowProps): JSX.Element {
  const id = useId();
  return (
    <SettingsRow
      label={label}
      description={description}
      htmlFor={id}
      control={
        <ToggleSwitch
          id={id}
          checked={checked}
          disabled={disabled}
          label={label}
          onChange={onChange}
          dataTestId={testId}
        />
      }
    >
      {children}
    </SettingsRow>
  );
}

/**
 * An on/off setting that depends on the row it sits in, such as one child of
 * a master switch. It goes in that row's children.
 */
function ToggleSubRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
  testId,
}: Omit<ToggleRowProps, 'children'>): JSX.Element {
  const id = useId();
  return (
    <SettingsSubRow
      label={label}
      description={description}
      htmlFor={id}
      control={
        <ToggleSwitch
          id={id}
          checked={checked}
          disabled={disabled}
          label={label}
          onChange={onChange}
          dataTestId={testId}
        />
      }
    />
  );
}
