import {
  useCodexSpeedCapabilities,
  useCodexSpeedRouteCatalog,
} from '@/hooks/useCodexSpeedCapabilities';
import { codexSpeedConnectionStates } from '@/hooks/useCodexSpeedControl';
import { useCodexSpeedRoute } from '@/hooks/useCodexSpeedRoute';
import { useChatStore } from '@/stores/chatStore';
import {
  type CodexSpeed,
  DEFAULT_CODEX_SPEED,
  codexSpeedFastMode,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES } from '@canopy/desktop-shared/types';
import type { ReadCodexSpeedRouteRequest } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  type JSX,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';

import {
  CODEX_SPEED_CHOICES,
  CODEX_SPEED_HELP_URL,
  CODEX_SPEED_LABELS,
  CODEX_SPEED_USAGE_HELP,
} from '@canopy/ui-shared';
import {
  Button,
  ErrorState,
  ChoiceList,
  ChoiceListRow,
  Notice,
  TextLinkButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { RefreshIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  MULTI_AGENT_ROW_DESCRIPTORS,
  type MultiAgentField,
  saveMultiAgentPreference,
} from './codexTabHelpers';
import { IdleTimeoutMinutesRow } from './IdleTimeoutMinutesRow';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

/** The saved Codex default speed: exact speed, then the legacy booleans. */
function readDefaultSpeed(prefs: PreferencesData): CodexSpeed {
  return (
    readCodexSpeedRecord(
      prefs.providerModelConfigDefaults?.codex,
      prefs.codexFastModeDefaultEnabled,
    ) ?? DEFAULT_CODEX_SPEED
  );
}

interface CodexDefaultSpeedProps {
  speed: CodexSpeed;
  onChange: (speed: CodexSpeed) => void;
}

/**
 * Full speed picker for the Codex default. Every speed stays listed; Ultra
 * fast can be chosen only when the scoped `defaults` route projection is
 * native and a model on that connection offers it, and a saved choice stays
 * selected (with its reason) until the user changes it.
 */
function CodexDefaultSpeed({
  speed,
  onChange,
}: CodexDefaultSpeedProps): JSX.Element {
  const headingId = useId();
  const labelId = useId();

  const capabilities = useCodexSpeedCapabilities({ enabled: true });
  const candidate =
    capabilities.catalog?.models.find((model) =>
      model.tiers?.includes('ultrafast'),
    ) ?? capabilities.catalog?.models[0];
  const request = useMemo<ReadCodexSpeedRouteRequest>(
    () => ({
      context: { kind: 'defaults' },
      model: candidate?.model ?? null,
      modelSelection: 'explicit',
    }),
    [candidate?.model],
  );
  // The host's scoped projection of the default route; never the catalog.
  const route = useCodexSpeedRoute({ request });
  useCodexSpeedRouteCatalog(true, route.route?.routeProfile);
  const status = route.status === 'loading' ? 'loading' : capabilities.status;
  const states = codexSpeedConnectionStates(
    capabilities.catalog,
    status,
    route.route?.routeProfile,
  );
  const refreshing =
    status === 'loading' || capabilities.refreshing || route.refreshing;
  const refresh = async (): Promise<void> => {
    await Promise.all([capabilities.refresh(), route.refresh()]);
  };
  const refreshLabel = (
    <>
      <RefreshIcon size="sm" aria-hidden />
      <span>{refreshing ? 'Checking' : 'Check again'}</span>
    </>
  );
  return (
    <SettingsSection
      title="Speed"
      headingId={headingId}
      description={
        <>
          Each chat can change it for its next message. {CODEX_SPEED_USAGE_HELP}{' '}
          <TextLinkButton
            data-testid="settings-codex-speed-help"
            onClick={(): void => {
              void window.api.browser.openExternal({
                url: CODEX_SPEED_HELP_URL,
              });
            }}
          >
            Learn more
          </TextLinkButton>
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow
          label="Default speed"
          labelId={labelId}
          description="The speed new Codex chats request."
        >
          <ChoiceList
            kind="radio"
            aria-label="Default speed"
            data-testid="settings-codex-fast-mode-default"
          >
            {CODEX_SPEED_CHOICES.map((choice) => {
              const state = states[choice];
              return (
                <ChoiceListRow
                  key={choice}
                  kind="radio"
                  name="settings-codex-default-speed"
                  value={choice}
                  selected={speed === choice}
                  disabled={!state.selectable}
                  onClick={(): void => onChange(choice)}
                  data-testid={`settings-codex-speed-default-${choice}`}
                  trailing={
                    !state.selectable && state.shortReason
                      ? state.shortReason
                      : undefined
                  }
                >
                  {CODEX_SPEED_LABELS[choice]}
                </ChoiceListRow>
              );
            })}
          </ChoiceList>
        </SettingsRow>
        <SettingsRow
          label="Speed availability"
          description="Check which speeds your Codex connection offers now."
          control={
            <Button
              size="compact"
              variant="secondary"
              data-testid="settings-codex-speed-refresh"
              disabled={refreshing}
              onClick={(): void => {
                void refresh();
              }}
            >
              {refreshLabel}
            </Button>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
interface CodexSubagentLimitProps {
  value: number | null;
  onSave: (value: number | null) => void;
}

function CodexSubagentLimit({
  value,
  onSave,
}: CodexSubagentLimitProps): JSX.Element {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
    setInvalid(false);
  }, [value]);
  function commitLimit(): void {
    const next = draft.trim() === '' ? null : Number(draft);
    if (next !== null && (!Number.isSafeInteger(next) || next < 1)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next !== value) onSave(next);
  }
  return (
    <SettingsRow
      label="Maximum concurrent subagents"
      htmlFor="settings-codex-max-concurrent-subagents"
      description={
        <span id="settings-codex-subagent-limit-help">
          Per Codex session, not counting the primary agent. Leave blank for the
          Codex default.
        </span>
      }
      control={
        <SettingsTextField
          id="settings-codex-max-concurrent-subagents"
          data-testid="settings-codex-max-concurrent-subagents"
          type="number"
          width="sm"
          min={1}
          step={1}
          placeholder="Codex default"
          value={draft}
          aria-invalid={invalid}
          aria-describedby="settings-codex-subagent-limit-help"
          onChange={(event): void => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={commitLimit}
          onKeyDown={(event): void => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      }
    >
      {invalid && (
        <p role="alert" className="text-xs fg-destructive">
          Enter a whole number of 1 or more, or leave blank for the Codex
          default.
        </p>
      )}
    </SettingsRow>
  );
}

interface CodexMultiAgentSettingsProps {
  preferences: PreferencesData;
  onToggle: (field: MultiAgentField, value: boolean) => void;
  onLimitChange?: (value: number | null) => void;
}

export function CodexMultiAgentSettings({
  preferences,
  onToggle,
  onLimitChange,
}: CodexMultiAgentSettingsProps): JSX.Element {
  return (
    <SettingsSection
      title="Multi-agent"
      description="Let Codex delegate work to subagents, which may use more tokens. Changes apply from the next turn."
    >
      <SettingsGroup>
        {MULTI_AGENT_ROW_DESCRIPTORS.map((row) => (
          <SettingsRow
            key={row.field}
            label={row.title}
            htmlFor={row.testId}
            description={row.helperText}
            control={
              <ToggleSwitch
                id={row.testId}
                checked={preferences[row.field] ?? true}
                label={row.title}
                onChange={(next): void => {
                  onToggle(row.field, next);
                }}
                dataTestId={row.testId}
              />
            }
          />
        ))}
        {onLimitChange && (
          <CodexSubagentLimit
            value={preferences.codexMaxConcurrentSubagents ?? null}
            onSave={onLimitChange}
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function CodexTab(): JSX.Element {
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadPreferences = useCallback((): void => {
    setLoadError(null);
    setSaveError(null);
    void window.api
      .loadPreferences()
      .then((p: PreferencesData) => {
        setPrefs(p);
        setLoadError(null);
      })
      .catch(() => {
        setPrefs(null);
        setLoadError("Couldn't load Codex settings.");
      });
  }, []);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  function commit(clamped: number): void {
    if (!prefs) return;
    const previous = prefs;
    // Optimistically reflect the clamped value so the UI does not flicker
    // while the save round-trip is in flight.
    setPrefs({ ...prefs, codexAppServerIdleTimeoutMinutes: clamped });
    setSaveError(null);
    void window.api
      .savePreferences({
        codexAppServerIdleTimeoutMinutes: clamped,
      })
      .then((normalized: PreferencesData) => {
        setPrefs(normalized);
      })
      .catch(() => {
        setPrefs(previous);
        setSaveError('Could not save Codex settings.');
      });
  }

  const toggleMultiAgent = useCallback(
    (field: MultiAgentField, next: boolean): void => {
      setPrefs((current) => {
        if (!current) return current;
        return { ...current, [field]: next };
      });
      setSaveError(null);
      void saveMultiAgentPreference(field, next)
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
        })
        .catch(() => {
          // Roll the optimistic change back on failure.
          setPrefs((current) => {
            if (!current) return current;
            return { ...current, [field]: !next };
          });
          setSaveError('Could not save Codex settings.');
        });
    },
    [],
  );

  const saveSubagentLimit = useCallback(
    (value: number | null): void => {
      if (!prefs) return;
      const previous = prefs;
      setPrefs({ ...prefs, codexMaxConcurrentSubagents: value });
      setSaveError(null);
      void window.api
        .savePreferences({ codexMaxConcurrentSubagents: value })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
        })
        .catch(() => {
          setPrefs(previous);
          setSaveError('Could not save Codex settings.');
        });
    },
    [prefs],
  );

  const saveDefaultSpeed = useCallback(
    (speed: CodexSpeed): void => {
      if (!prefs) return;
      const previous = prefs;
      // The exact speed and its derived boolean are written together.
      const nextProviderDefaults = {
        ...(prefs.providerModelConfigDefaults ?? {}),
        codex: withCodexSpeed(prefs.providerModelConfigDefaults?.codex, speed),
      };
      setPrefs({
        ...prefs,
        providerModelConfigDefaults: nextProviderDefaults,
        codexFastModeDefaultEnabled: codexSpeedFastMode(speed),
      });
      useChatStore.getState().applyModelConfigDefaults(nextProviderDefaults);
      setSaveError(null);
      void window.api
        .savePreferences({ providerModelConfigDefaults: nextProviderDefaults })
        .then((normalized: PreferencesData) => {
          setPrefs(normalized);
          useChatStore
            .getState()
            .applyModelConfigDefaults(normalized.providerModelConfigDefaults);
        })
        .catch(() => {
          setPrefs(previous);
          useChatStore
            .getState()
            .applyModelConfigDefaults(previous.providerModelConfigDefaults);
          setSaveError('Could not save Codex settings.');
        });
    },
    [prefs],
  );

  if (loadError) {
    return (
      <SettingsPage title="Codex" dataTestId="settings-tab-codex">
        <ErrorState
          message={loadError}
          onRetry={loadPreferences}
          testId="settings-codex-load-error"
        />
      </SettingsPage>
    );
  }

  if (!prefs) {
    return (
      <SettingsPage title="Codex">
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Codex" dataTestId="settings-tab-codex">
      {saveError && (
        <Notice intent="destructive" data-testid="settings-codex-save-error">
          {saveError}
        </Notice>
      )}

      <CodexDefaultSpeed
        speed={readDefaultSpeed(prefs)}
        onChange={saveDefaultSpeed}
      />

      <SettingsSection title="App server">
        <SettingsGroup>
          <IdleTimeoutMinutesRow
            id="settings-codex-idle-timeout-minutes"
            description="Suspend idle Codex app-server processes after this long. Chat sessions are kept."
            minutes={
              Number.isFinite(prefs.codexAppServerIdleTimeoutMinutes)
                ? prefs.codexAppServerIdleTimeoutMinutes
                : DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES
            }
            onCommit={commit}
          />
        </SettingsGroup>
      </SettingsSection>

      <CodexMultiAgentSettings
        preferences={prefs}
        onToggle={toggleMultiAgent}
        onLimitChange={saveSubagentLimit}
      />
    </SettingsPage>
  );
}
