import { type JSX, type ReactNode, useEffect, useId, useState } from 'react';
import { isWakeLockSupportedPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  BYTES_PER_GIB,
  DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
  DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS,
} from '@canopy/desktop-shared/constants/preferences';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { pt } from '@/lib/platform-text';
import { brandText } from '@/lib/brand';
import { ToggleSwitch } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';
import { MemoryReportRow } from './MemoryDiagnosticsRows';

const MAX_CONFIGURABLE_LIMIT = 100;
const MIN_MEMORY_THRESHOLD_GIB = 0.25;
const MAX_MEMORY_THRESHOLD_GIB = 1024;
const MIN_MEMORY_THRESHOLD_GAP_BYTES = BYTES_PER_GIB / 4;

function normalizeLimitInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(MAX_CONFIGURABLE_LIMIT, Math.max(1, parsed));
}

function bytesToGibInput(bytes: number): number {
  return Number((bytes / BYTES_PER_GIB).toFixed(2));
}

function normalizeGibInput(value: string, fallbackBytes: number): number {
  const parsed = Number.parseFloat(
    value || String(bytesToGibInput(fallbackBytes)),
  );
  if (!Number.isFinite(parsed)) {
    return fallbackBytes;
  }
  const normalized = Math.min(
    MAX_MEMORY_THRESHOLD_GIB,
    Math.max(MIN_MEMORY_THRESHOLD_GIB, parsed),
  );
  return Math.round(normalized * BYTES_PER_GIB);
}

interface SwitchRowProps {
  checked: boolean;
  label: string;
  description: ReactNode;
  testId: string;
  onChange: (checked: boolean) => void;
  /** `SettingsSubRow`s for the settings this switch turns on. */
  children?: ReactNode;
}

/** One on/off setting: a switch on the row's trailing edge. */
function SwitchRow({
  checked,
  label,
  description,
  testId,
  onChange,
  children,
}: SwitchRowProps): JSX.Element {
  const id = useId();
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={description}
      control={
        <ToggleSwitch
          id={id}
          checked={checked}
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

interface LimitRowProps {
  checked: boolean;
  label: string;
  description: string;
  value: number;
  defaultValue: number;
  inputTestId: string;
  checkboxTestId: string;
  onToggle: (enabled: boolean) => void;
  onChange: (value: number) => void;
}

/**
 * A cap turned on by its switch. The cap itself is a sub-row inside the
 * switch's row, disabled while the switch is off.
 */
function LimitRow({
  checked,
  label,
  description,
  value,
  defaultValue,
  inputTestId,
  checkboxTestId,
  onToggle,
  onChange,
}: LimitRowProps): JSX.Element {
  const inputId = useId();
  return (
    <SwitchRow
      checked={checked}
      label={label}
      description={description}
      testId={checkboxTestId}
      onChange={onToggle}
    >
      <SettingsSubRow
        label="Maximum"
        htmlFor={inputId}
        control={
          <SettingsTextField
            id={inputId}
            type="number"
            width="xs"
            min={1}
            max={MAX_CONFIGURABLE_LIMIT}
            value={checked ? value : defaultValue}
            disabled={!checked}
            onChange={(event) =>
              onChange(normalizeLimitInput(event.target.value, defaultValue))
            }
            data-testid={inputTestId}
          />
        }
      />
    </SwitchRow>
  );
}

interface MemoryThresholdRowProps {
  label: string;
  description?: string;
  value: number;
  testId: string;
  onChange: (value: string) => void;
}

/** A memory threshold in GiB. */
function MemoryThresholdRow({
  label,
  description,
  value,
  testId,
  onChange,
}: MemoryThresholdRowProps): JSX.Element {
  const id = useId();
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={description}
      control={
        <>
          <SettingsTextField
            id={id}
            type="number"
            width="xs"
            min={MIN_MEMORY_THRESHOLD_GIB}
            max={MAX_MEMORY_THRESHOLD_GIB}
            step={0.25}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            data-testid={testId}
          />
          <span className="text-xs fg-secondary">GiB</span>
        </>
      }
    />
  );
}

export function PerformanceTab(): JSX.Element {
  const [maxActiveChatTurns, setMaxActiveChatTurns] = useState<number | null>(
    DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  );
  const [maxActivePipelineExecutions, setMaxActivePipelineExecutions] =
    useState<number | null>(DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS);
  const [memoryPressureGuardEnabled, setMemoryPressureGuardEnabled] = useState(
    DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  );
  const [
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    setBypassCodexAppServerIdleTimeoutUnderCriticalPressure,
  ] = useState(
    DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  );
  const [
    memoryPressureWarningThresholdBytes,
    setMemoryPressureWarningThresholdBytes,
  ] = useState(DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES);
  const [
    memoryPressureCriticalThresholdBytes,
    setMemoryPressureCriticalThresholdBytes,
  ] = useState(DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES);
  const [
    keepSystemAwakeWhileAgentsActive,
    setKeepSystemAwakeWhileAgentsActive,
  ] = useState(true);
  const [showDiagnosticsPill, setShowDiagnosticsPill] = useState(true);
  const [memoryDiagnosticsEnabled, setMemoryDiagnosticsEnabled] =
    useState(false);
  // Main turns the service on only when the save commits, so a report
  // requested before then would be refused as disabled.
  const [pendingMemoryDiagnosticsSaves, setPendingMemoryDiagnosticsSaves] =
    useState(0);
  const supportsWakeLock = isWakeLockSupportedPlatform(window.platform);
  const wakeLockDescription = pt({
    default: `Prevents idle sleep while ${brandText.appName} has active chat turns or pipeline runs. The display can still lock and sleep. Choosing Sleep, forced shutdown, or critical battery may still suspend the device.`,
    darwin: `Prevents idle sleep while ${brandText.appName} has active chat turns or pipeline runs. The display can still lock and sleep. Closing the lid or choosing Sleep may still suspend the Mac depending on macOS power settings.`,
    win32: `Prevents idle sleep while ${brandText.appName} has active chat turns or pipeline runs. The display can still lock and sleep. Choosing Sleep, hibernation, forced shutdown, or critical battery may still suspend Windows.`,
  });

  function applyPreferences(prefs: PreferencesData): void {
    setMaxActiveChatTurns(prefs.maxActiveChatTurns);
    setMaxActivePipelineExecutions(prefs.maxActivePipelineExecutions);
    setMemoryPressureGuardEnabled(prefs.memoryPressureGuardEnabled);
    setBypassCodexAppServerIdleTimeoutUnderCriticalPressure(
      prefs.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    );
    setMemoryPressureWarningThresholdBytes(
      prefs.memoryPressureWarningThresholdBytes,
    );
    setMemoryPressureCriticalThresholdBytes(
      prefs.memoryPressureCriticalThresholdBytes,
    );
    setKeepSystemAwakeWhileAgentsActive(prefs.keepSystemAwakeWhileAgentsActive);
    setShowDiagnosticsPill(prefs.showDiagnosticsPill);
    setMemoryDiagnosticsEnabled(prefs.memoryDiagnosticsEnabled);
  }

  async function savePreferences(
    preferences: Partial<PreferencesData>,
  ): Promise<PreferencesData> {
    const prefs = await window.api.savePreferences(preferences);
    applyPreferences(prefs);
    return prefs;
  }

  function refreshPreferencesAfterFailure(): void {
    void window.api
      .loadPreferences()
      .then(applyPreferences)
      .catch(() => {
        // Preferences errors are surfaced elsewhere; keep the last rendered
        // state if the recovery read also fails.
      });
  }

  useEffect(() => {
    void window.api
      .loadPreferences()
      .then(applyPreferences)
      .catch(() => {
        setMaxActiveChatTurns(DEFAULT_MAX_ACTIVE_CHAT_TURNS);
        setMaxActivePipelineExecutions(DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS);
        setMemoryPressureGuardEnabled(DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED);
        setBypassCodexAppServerIdleTimeoutUnderCriticalPressure(
          DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
        );
        setMemoryPressureWarningThresholdBytes(
          DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
        );
        setMemoryPressureCriticalThresholdBytes(
          DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
        );
        setKeepSystemAwakeWhileAgentsActive(true);
        setShowDiagnosticsPill(true);
        setMemoryDiagnosticsEnabled(false);
      });
  }, []);

  return (
    <SettingsPage title="Performance" dataTestId="settings-tab-performance">
      <SettingsSection
        title="Concurrency limits"
        description={
          <>
            Limit how much new work {brandText.appName} starts at once during
            heavy sessions. Memory pressure guards keep running when these caps
            are off.
          </>
        }
      >
        <SettingsGroup>
          <LimitRow
            checked={maxActiveChatTurns !== null}
            label="Limit active chat turns"
            description="Caps the chat turns that can be running or queued at the same time."
            value={maxActiveChatTurns ?? DEFAULT_MAX_ACTIVE_CHAT_TURNS}
            defaultValue={DEFAULT_MAX_ACTIVE_CHAT_TURNS}
            checkboxTestId="settings-limit-active-chat-turns"
            inputTestId="settings-max-active-chat-turns"
            onToggle={(enabled) => {
              const nextValue = enabled ? DEFAULT_MAX_ACTIVE_CHAT_TURNS : null;
              setMaxActiveChatTurns(nextValue);
              void savePreferences({ maxActiveChatTurns: nextValue }).catch(
                refreshPreferencesAfterFailure,
              );
            }}
            onChange={(nextValue) => {
              setMaxActiveChatTurns(nextValue);
              void savePreferences({ maxActiveChatTurns: nextValue }).catch(
                refreshPreferencesAfterFailure,
              );
            }}
          />

          <LimitRow
            checked={maxActivePipelineExecutions !== null}
            label="Limit active pipeline executions"
            description="Caps the pipeline runs that can be active or starting at the same time."
            value={
              maxActivePipelineExecutions ??
              DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS
            }
            defaultValue={DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS}
            checkboxTestId="settings-limit-active-pipelines"
            inputTestId="settings-max-active-pipelines"
            onToggle={(enabled) => {
              const nextValue = enabled
                ? DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS
                : null;
              setMaxActivePipelineExecutions(nextValue);
              void savePreferences({
                maxActivePipelineExecutions: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
            onChange={(nextValue) => {
              setMaxActivePipelineExecutions(nextValue);
              void savePreferences({
                maxActivePipelineExecutions: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
          />
        </SettingsGroup>
      </SettingsSection>

      {supportsWakeLock && (
        <SettingsSection title="Sleep">
          <SettingsGroup>
            <SwitchRow
              checked={keepSystemAwakeWhileAgentsActive}
              label="Keep system awake while agents are running"
              description={wakeLockDescription}
              testId="settings-keep-system-awake"
              onChange={(nextValue) => {
                setKeepSystemAwakeWhileAgentsActive(nextValue);
                void savePreferences({
                  keepSystemAwakeWhileAgentsActive: nextValue,
                }).catch(refreshPreferencesAfterFailure);
              }}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection
        title="Memory pressure guard"
        description="Memory thresholds for resource diagnostics and guarded starts."
      >
        <SettingsGroup>
          <MemoryThresholdRow
            label="Warning at"
            value={bytesToGibInput(memoryPressureWarningThresholdBytes)}
            testId="settings-memory-pressure-warning-gib"
            onChange={(input) => {
              const nextWarningBytes = Math.min(
                normalizeGibInput(
                  input,
                  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
                ),
                memoryPressureCriticalThresholdBytes -
                  MIN_MEMORY_THRESHOLD_GAP_BYTES,
              );
              const nextValue = Math.max(1, Math.round(nextWarningBytes));
              setMemoryPressureWarningThresholdBytes(nextValue);
              void savePreferences({
                memoryPressureWarningThresholdBytes: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
          />

          <MemoryThresholdRow
            label="Critical at"
            description="Blocks new chat turns and pipeline runs while the guard below is on."
            value={bytesToGibInput(memoryPressureCriticalThresholdBytes)}
            testId="settings-memory-pressure-critical-gib"
            onChange={(input) => {
              const nextCriticalBytes = Math.max(
                normalizeGibInput(
                  input,
                  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
                ),
                memoryPressureWarningThresholdBytes +
                  MIN_MEMORY_THRESHOLD_GAP_BYTES,
              );
              const nextValue = Math.round(nextCriticalBytes);
              setMemoryPressureCriticalThresholdBytes(nextValue);
              void savePreferences({
                memoryPressureCriticalThresholdBytes: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
          />

          <SwitchRow
            checked={memoryPressureGuardEnabled}
            label="Block new work at critical memory pressure"
            description={
              <>
                When off, {brandText.appName} still measures and reports memory
                pressure but does not stop new guarded work from starting.
              </>
            }
            testId="settings-memory-pressure-guard-enabled"
            onChange={(nextValue) => {
              setMemoryPressureGuardEnabled(nextValue);
              void savePreferences({
                memoryPressureGuardEnabled: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
          />

          <SwitchRow
            checked={bypassCodexAppServerIdleTimeoutUnderCriticalPressure}
            label="Bypass app server idle timeout under critical pressure"
            description="Codex app servers are closed more aggressively under critical memory pressure instead of waiting for the idle timeout, freeing memory sooner."
            testId="settings-bypass-codex-idle-timeout-under-critical-pressure"
            onChange={(nextValue) => {
              setBypassCodexAppServerIdleTimeoutUnderCriticalPressure(
                nextValue,
              );
              void savePreferences({
                bypassCodexAppServerIdleTimeoutUnderCriticalPressure: nextValue,
              }).catch(refreshPreferencesAfterFailure);
            }}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsGroup>
          <SwitchRow
            checked={showDiagnosticsPill}
            label="Show diagnostics pill in sidebar"
            description="Live CPU and memory usage, directly above Settings. Memory guards keep running when it is hidden."
            testId="settings-show-diagnostics-pill"
            onChange={(nextValue) => {
              setShowDiagnosticsPill(nextValue);
              void savePreferences({ showDiagnosticsPill: nextValue })
                .then((prefs) => {
                  emitPreferencesUpdated(prefs);
                })
                .catch(refreshPreferencesAfterFailure);
            }}
          />

          <SwitchRow
            checked={memoryDiagnosticsEnabled}
            label="Memory diagnostics"
            description={
              <>
                While on, {brandText.appName} samples its memory use and saves a
                snapshot automatically if it gets close to its memory limit.
                This has almost no cost, and reports stay on this computer.
              </>
            }
            testId="settings-memory-diagnostics"
            onChange={(nextValue) => {
              setMemoryDiagnosticsEnabled(nextValue);
              setPendingMemoryDiagnosticsSaves((count) => count + 1);
              void savePreferences({ memoryDiagnosticsEnabled: nextValue })
                .then((prefs) => {
                  emitPreferencesUpdated(prefs);
                })
                .catch(refreshPreferencesAfterFailure)
                .finally(() => {
                  setPendingMemoryDiagnosticsSaves((count) => count - 1);
                });
            }}
          />
          <MemoryReportRow
            enabled={memoryDiagnosticsEnabled}
            saving={pendingMemoryDiagnosticsSaves > 0}
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
