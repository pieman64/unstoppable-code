import type { PreferencesData } from '@canopy/desktop-shared/types';
import { useEffect, useState, type JSX } from 'react';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
  MAX_MANAGED_DELEGATION_DEPTH,
  MAX_MANAGED_DELEGATION_CONCURRENCY,
  type ManagedDelegationMode,
} from '@canopy/protocol/delegation/discovery';
import {
  ErrorBanner,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  emitManagedDelegationPreferenceUpdated,
  subscribeManagedDelegationPreferenceUpdated,
} from '@/lib/managedDelegationPreferenceEvents';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save consultation settings. Try again.';

interface ManagedDelegationSettingsProps {
  initialMode: ManagedDelegationMode;
  initialRevocationIncomplete?: boolean;
  initialMaxConcurrent?: number;
  initialMaxDepth?: number;
}

/** Host-neutral policy choices; model/runtime discovery belongs to the parent tool. */
export function ManagedDelegationSettings({
  initialMode,
  initialMaxConcurrent,
  initialMaxDepth,
  initialRevocationIncomplete = false,
}: ManagedDelegationSettingsProps): JSX.Element {
  const [mode, setMode] = useState(initialMode);
  const [maxConcurrent, setMaxConcurrent] = useState(
    normalizeManagedDelegationMaxConcurrent(initialMaxConcurrent),
  );
  const [saving, setSaving] = useState(false);
  const [maxDepth, setMaxDepth] = useState(
    normalizeManagedDelegationMaxDepth(initialMaxDepth),
  );
  const [error, setError] = useState(false);
  const [revocationIncomplete, setRevocationIncomplete] = useState(
    initialRevocationIncomplete,
  );
  const windows = window.platform === 'win32';
  const supported = window.platform === 'darwin' || windows;

  useEffect(() => {
    const unsubscribePreferenceUpdate =
      subscribeManagedDelegationPreferenceUpdated((update) => {
        setMode(update.mode);
        if (update.maxDepth !== undefined) setMaxDepth(update.maxDepth);
        if (update.maxConcurrent !== undefined)
          setMaxConcurrent(update.maxConcurrent);
        setRevocationIncomplete(update.revocationIncomplete);
      });
    const unsubscribePreferencesSync =
      typeof window.api.onPreferencesSynced === 'function'
        ? window.api.onPreferencesSynced((preferences) => {
            if (preferences.managedDelegationMaxDepth !== undefined)
              setMaxDepth(
                normalizeManagedDelegationMaxDepth(
                  preferences.managedDelegationMaxDepth,
                ),
              );
            if (preferences.managedDelegationMaxConcurrent !== undefined)
              setMaxConcurrent(
                normalizeManagedDelegationMaxConcurrent(
                  preferences.managedDelegationMaxConcurrent,
                ),
              );
            if (preferences.managedDelegationMode !== undefined) {
              setMode(preferences.managedDelegationMode);
            }
            if (
              preferences.__managedDelegationRevocationIncomplete !== undefined
            ) {
              setRevocationIncomplete(
                preferences.__managedDelegationRevocationIncomplete,
              );
            }
          })
        : undefined;
    return (): void => {
      unsubscribePreferenceUpdate();
      unsubscribePreferencesSync?.();
    };
  }, []);

  useCurrentUiStateReporter('settings.managedDelegation', {
    loaded: true,
    mode,
    maxDepth,
    revocationIncomplete,
  });

  async function save(
    patch: Partial<
      Pick<
        PreferencesData,
        | 'managedDelegationMode'
        | 'managedDelegationMaxConcurrent'
        | 'managedDelegationMaxDepth'
      >
    >,
  ): Promise<void> {
    setSaving(true);
    setError(false);
    try {
      const saved = await window.api.savePreferences(patch);
      const nextMaxDepth = normalizeManagedDelegationMaxDepth(
        saved.managedDelegationMaxDepth,
      );
      setMaxDepth(nextMaxDepth);
      const nextMaxConcurrent = normalizeManagedDelegationMaxConcurrent(
        saved.managedDelegationMaxConcurrent,
      );
      setMaxConcurrent(nextMaxConcurrent);
      setMode(saved.managedDelegationMode ?? 'off');
      setRevocationIncomplete(
        saved.__managedDelegationRevocationIncomplete === true,
      );
      emitManagedDelegationPreferenceUpdated({
        mode: saved.managedDelegationMode ?? 'off',
        maxConcurrent: nextMaxConcurrent,
        maxDepth: nextMaxDepth,
        revocationIncomplete:
          saved.__managedDelegationRevocationIncomplete === true,
      });
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection
      title="Managed delegation"
      description="Let worktree chats delegate tasks to another model. Tasks may use additional tokens."
      dataTestId="managed-delegation-settings"
    >
      <ErrorBanner className="" error={error ? SAVE_ERROR_MESSAGE : null} />
      {!error && revocationIncomplete && (
        <Notice
          intent="attention"
          role="alert"
          actions={
            <NoticeButton
              onClick={() => void save({ managedDelegationMode: 'off' })}
              disabled={saving}
            >
              Retry shutdown
            </NoticeButton>
          }
        >
          Consultation is off, but some child sessions could not be stopped.
        </Notice>
      )}
      <SettingsGroup>
        <SettingsRow
          label="Delegate tasks"
          htmlFor="managed-delegation-mode"
          description={
            supported
              ? 'Applies to new turns in worktree chats. Enabling replaces native subagent tools. Turning off cancels managed children; the parent chat continues.'
              : 'Managed delegation is currently available on macOS and Windows.'
          }
          control={
            <SettingsSelect
              id="managed-delegation-mode"
              data-testid="settings-managed-delegation-mode"
              value={mode}
              disabled={!supported || saving}
              onChange={(event) => {
                void save({
                  managedDelegationMode: normalizeManagedDelegationMode(
                    event.target.value,
                  ),
                });
              }}
            >
              <option value="off">Off</option>
              <option value="explicit-only">Only when requested</option>
              <option value="proactive">When useful</option>
            </SettingsSelect>
          }
        >
          <p className="text-xs text-pretty fg-secondary">
            Children can read and search, and edit with explicit file
            permissions from the parent. Your approval settings still apply.
            Tasks share the current worktree unless isolation is requested.
          </p>
          {windows && (
            <p
              className="text-xs text-pretty fg-secondary"
              data-testid="settings-managed-delegation-windows-codex"
            >
              On Windows, Codex tasks run without the Codex sandbox and follow
              this chat&apos;s approval settings.
            </p>
          )}
        </SettingsRow>
        <SettingsRow
          label="Maximum concurrent subagents"
          htmlFor="managed-delegation-concurrency"
          description={
            <span data-testid="settings-managed-delegation-concurrency-help">
              {`Active managed subagents across the whole chat, including nested agents. Defaults to 5. Tasks over the limit wait their turn and start automatically. Changes apply to new tasks; running tasks continue. The application-wide limit is ${MAX_MANAGED_DELEGATION_CONCURRENCY}.`}
            </span>
          }
          control={
            <SettingsSelect
              id="managed-delegation-concurrency"
              data-testid="settings-managed-delegation-concurrency"
              value={maxConcurrent}
              disabled={!supported || saving}
              onChange={(event) => {
                void save({
                  managedDelegationMaxConcurrent: Number(event.target.value),
                });
              }}
            >
              {Array.from(
                { length: MAX_MANAGED_DELEGATION_CONCURRENCY },
                (_, i) => i + 1,
              ).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SettingsSelect>
          }
        />
        <SettingsRow
          label="Maximum delegation depth"
          htmlFor="managed-delegation-depth"
          description="Direct children are depth 1. Each delegation must explicitly allow its child to delegate further. Changes limit new tasks; running tasks continue."
          control={
            <SettingsSelect
              id="managed-delegation-depth"
              data-testid="settings-managed-delegation-depth"
              value={maxDepth}
              disabled={!supported || saving}
              onChange={(event) => {
                void save({
                  managedDelegationMaxDepth: Number(event.target.value),
                });
              }}
            >
              {Array.from(
                { length: MAX_MANAGED_DELEGATION_DEPTH },
                (_, i) => i + 1,
              ).map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? '1 (no nesting)' : value}
                </option>
              ))}
            </SettingsSelect>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
