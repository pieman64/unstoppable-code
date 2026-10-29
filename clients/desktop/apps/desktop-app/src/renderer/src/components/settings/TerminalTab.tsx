import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  TerminalPreset,
  TerminalPresetIcon,
  TerminalShellProfile,
  TerminalShellProfileId,
} from '@canopy/desktop-shared/types';
import {
  getTerminalPresetImageMaxFileBytes,
  isTerminalPresetImageDataUrl,
  isTerminalPresetImageMimeType,
  TERMINAL_PRESET_IMAGE_ACCEPT,
} from '@canopy/desktop-shared/lib/terminal-preset-images';
import {
  ImagePlus,
  PlusIcon,
  SyncIcon,
  TerminalBorderedIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  loadTerminalPanelPreferences,
  loadTerminalShellProfiles,
  setCachedTerminalPanelPreferences,
} from '@/lib/terminalShellProfiles';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Tooltip } from '@canopy/ui-shared/components/Tooltip';
import { Button, Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import {
  TerminalDefaultShellBadge,
  TERMINAL_DEFAULT_SHELL_TOOLTIP,
} from '@/components/terminal/TerminalDefaultShellBadge';
import { useTerminalPresetColorMode } from '@/hooks/useTerminalPresetColorMode';
import {
  resolveTerminalPresetImageDataUrl,
  type TerminalPresetColorMode,
} from '@/lib/terminalPresetIcons';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

interface ShellOption {
  id: TerminalShellProfileId;
  label: string;
  isDefault: boolean;
}

function presetIconPreview(preset: TerminalPreset): JSX.Element {
  if (preset.icon?.kind === 'image') {
    return (
      <span className="flex items-center gap-1">
        {preset.icon.lightDataUrl ? (
          <img
            src={preset.icon.lightDataUrl}
            alt="Light mode preset icon"
            data-testid="terminal-preset-image-light"
            className="h-6 w-6 rounded object-contain"
          />
        ) : null}
        {preset.icon.darkDataUrl ? (
          <img
            src={preset.icon.darkDataUrl}
            alt="Dark mode preset icon"
            data-testid="terminal-preset-image-dark"
            className="h-6 w-6 rounded object-contain"
          />
        ) : null}
      </span>
    );
  }
  if (preset.icon?.kind === 'character') {
    return <span className="text-base leading-none">{preset.icon.value}</span>;
  }
  return <TerminalBorderedIcon width={18} height={18} />;
}

/**
 * A file picker behind a settings button: the button opens the hidden input,
 * which keeps its own accessible name for the picked file.
 */
function PresetImageButton({
  inputLabel,
  onChange,
  children,
}: {
  inputLabel: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  children: ReactNode;
}): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        size={settingsButtonSize}
        variant="secondary"
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        tabIndex={-1}
        aria-label={inputLabel}
        accept={TERMINAL_PRESET_IMAGE_ACCEPT}
        onChange={onChange}
        className="sr-only"
      />
    </>
  );
}

/** One mode's image, a sub-row of the preset's "Image or SVG" row. */
function PresetImageModeRow({
  colorMode,
  configuredDataUrl,
  resolvedDataUrl,
  onChange,
}: {
  colorMode: TerminalPresetColorMode;
  configuredDataUrl?: string;
  resolvedDataUrl: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}): JSX.Element {
  const modeLabel = colorMode === 'light' ? 'Light' : 'Dark';
  return (
    <SettingsSubRow
      label={`${modeLabel} mode`}
      description={
        configuredDataUrl ? 'Configured' : 'Using the other mode image'
      }
      control={
        <>
          <img
            src={resolvedDataUrl}
            alt={`${modeLabel} mode preset icon preview`}
            data-testid={`terminal-preset-image-${colorMode}-preview`}
            className="h-7 w-7 shrink-0 rounded object-contain"
          />
          <PresetImageButton
            inputLabel={`${modeLabel} mode image`}
            onChange={onChange}
          >
            {configuredDataUrl ? 'Replace' : 'Set image'}
          </PresetImageButton>
        </>
      }
    />
  );
}

/** The presets header row's hint: how many presets the list holds. */
function presetCountLabel(count: number): string {
  if (count === 0) return 'No presets yet';
  return `${String(count)} preset${count === 1 ? '' : 's'}`;
}

export function TerminalTab(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const colorMode = useTerminalPresetColorMode();
  const [profiles, setProfiles] = useState<TerminalShellProfile[]>([]);
  const [disabledShells, setDisabledShells] = useState<
    TerminalShellProfileId[]
  >([]);
  const [presets, setPresets] = useState<TerminalPreset[]>([]);
  const [draft, setDraft] = useState<TerminalPreset | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void Promise.all([
      loadTerminalShellProfiles(),
      loadTerminalPanelPreferences(),
    ]).then(([nextProfiles, preferences]) => {
      if (canceled) return;
      setProfiles(nextProfiles);
      setDisabledShells(preferences.disabledTerminalShellProfileIds);
      setPresets(preferences.terminalPresets);
      setLoaded(true);
    });
    return (): void => {
      canceled = true;
    };
  }, []);

  const shellOptions = useMemo<ShellOption[]>(() => {
    return profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      isDefault: profile.isDefault,
    }));
  }, [profiles]);

  const defaultShellProfileId =
    shellOptions.find((option) => option.isDefault)?.id ?? 'default';

  const persist = async (
    nextDisabledShells: TerminalShellProfileId[],
    nextPresets: TerminalPreset[],
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await window.api.savePreferences({
        disabledTerminalShellProfileIds: nextDisabledShells,
        terminalPresets: nextPresets,
      });
      setDisabledShells(saved.disabledTerminalShellProfileIds);
      setPresets(saved.terminalPresets);
      setCachedTerminalPanelPreferences(saved);
      return true;
    } catch {
      setError('Could not save Terminal settings. Try again.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleShellToggle = (
    profileId: TerminalShellProfileId,
    enabled: boolean,
  ): void => {
    const next = enabled
      ? disabledShells.filter((id) => id !== profileId)
      : Array.from(new Set([...disabledShells, profileId]));
    setDisabledShells(next);
    void persist(next, presets);
  };

  const startAddPreset = (): void => {
    setDraft({
      id: crypto.randomUUID(),
      name: '',
      terminalProfileId: defaultShellProfileId,
      command: '',
      enabled: true,
    });
  };

  const handleSavePreset = (): void => {
    if (!draft || !draft.name.trim() || !draft.command.trim()) return;
    const normalized = {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
    };
    const next = presets.some((preset) => preset.id === normalized.id)
      ? presets.map((preset) =>
          preset.id === normalized.id ? normalized : preset,
        )
      : [...presets, normalized];
    void persist(disabledShells, next).then((saved) => {
      if (saved) setDraft(null);
    });
  };

  const handleImage = (
    event: ChangeEvent<HTMLInputElement>,
    targetMode: TerminalPresetColorMode,
  ): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!isTerminalPresetImageMimeType(file.type)) {
      setError('Preset icons must be PNG, JPEG, GIF, WebP, or SVG images.');
      return;
    }
    if (file.size > getTerminalPresetImageMaxFileBytes(file.type)) {
      setError('Preset icons must be smaller than 1 MB after encoding.');
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = (): void => {
      if (!isTerminalPresetImageDataUrl(reader.result)) {
        setError('Could not read this preset icon. Try a different image.');
        return;
      }
      const dataUrl = reader.result;
      setDraft((current) =>
        current
          ? {
              ...current,
              icon: {
                ...(current.icon?.kind === 'image'
                  ? current.icon
                  : { kind: 'image' as const }),
                [targetMode === 'light' ? 'lightDataUrl' : 'darkDataUrl']:
                  dataUrl,
              },
            }
          : current,
      );
    };
    reader.readAsDataURL(file);
  };

  const handleSwapImages = (): void => {
    setDraft((current) => {
      if (
        current?.icon?.kind !== 'image' ||
        !current.icon.lightDataUrl ||
        !current.icon.darkDataUrl
      ) {
        return current;
      }
      return {
        ...current,
        icon: {
          kind: 'image',
          lightDataUrl: current.icon.darkDataUrl,
          darkDataUrl: current.icon.lightDataUrl,
        },
      };
    });
  };

  const draftImage = draft?.icon?.kind === 'image' ? draft.icon : undefined;
  const draftLightImage = resolveTerminalPresetImageDataUrl(
    draftImage,
    'light',
  );
  const draftDarkImage = resolveTerminalPresetImageDataUrl(draftImage, 'dark');

  return (
    <SettingsPage
      title="Terminal"
      description="Choose the shells and command presets available when opening a Terminal panel."
      dataTestId="settings-tab-terminal"
    >
      <SettingsSection
        title="Shells"
        description="Show or hide shells detected on this computer."
        dataTestId="terminal-settings-shells"
      >
        <SettingsGroup>
          {shellOptions.map((option) => {
            const switchId = `terminal-shell-switch-${option.id}`;
            return (
              <SettingsRow
                key={option.id}
                label={option.label}
                htmlFor={switchId}
                dataTestId={`terminal-shell-option-${option.id}`}
                control={
                  <>
                    {option.isDefault ? (
                      <Tooltip label={TERMINAL_DEFAULT_SHELL_TOOLTIP}>
                        <TerminalDefaultShellBadge
                          testId="terminal-shell-default-badge"
                          focusable
                        />
                      </Tooltip>
                    ) : null}
                    <ToggleSwitch
                      id={switchId}
                      checked={!disabledShells.includes(option.id)}
                      label={`${option.label} shell`}
                      dataTestId={`terminal-shell-toggle-${option.id}`}
                      disabled={!loaded || saving}
                      onChange={(next) => handleShellToggle(option.id, next)}
                    />
                  </>
                }
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Presets"
        description="Open a selected shell and immediately run a default command."
        dataTestId="terminal-settings-presets"
      >
        <SettingsGroup>
          <SettingsRow
            label="Saved presets"
            description={presetCountLabel(presets.length)}
            control={
              <Button
                size={settingsButtonSize}
                variant="secondary"
                data-testid="terminal-preset-add"
                onClick={startAddPreset}
                disabled={draft !== null || saving}
              >
                <PlusIcon width={14} height={14} />
                Add preset
              </Button>
            }
          />
          {presets.map((preset) => (
            <div
              key={preset.id}
              data-testid={`terminal-preset-${preset.id}`}
              className="flex items-center gap-3"
            >
              <div className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-md bg-muted px-1 fg-secondary">
                {presetIconPreview(preset)}
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                {/* The name flips the preset's switch; the command below stays
                    selectable text. */}
                <label
                  htmlFor={`terminal-preset-switch-${preset.id}`}
                  className="block truncate text-s font-medium fg-primary"
                >
                  {preset.name}
                </label>
                <div
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} truncate font-mono text-xs fg-secondary`}
                >
                  {preset.command}
                </div>
              </div>
              <Button
                size={settingsButtonSize}
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...preset,
                    terminalProfileId:
                      preset.terminalProfileId === 'default'
                        ? defaultShellProfileId
                        : preset.terminalProfileId,
                  })
                }
              >
                Edit
              </Button>
              <ToggleSwitch
                id={`terminal-preset-switch-${preset.id}`}
                checked={preset.enabled}
                label={`${preset.name} preset`}
                dataTestId={`terminal-preset-toggle-${preset.id}`}
                disabled={saving}
                onChange={(enabled) => {
                  const next = presets.map((entry) =>
                    entry.id === preset.id ? { ...entry, enabled } : entry,
                  );
                  setPresets(next);
                  void persist(disabledShells, next);
                }}
              />
              <Button
                size={settingsButtonSize}
                variant="ghost"
                iconOnly
                aria-label={`Remove ${preset.name}`}
                disabled={saving}
                onClick={() => {
                  const next = presets.filter(
                    (entry) => entry.id !== preset.id,
                  );
                  setPresets(next);
                  void persist(disabledShells, next);
                }}
              >
                <TrashIcon width={14} height={14} />
              </Button>
            </div>
          ))}
        </SettingsGroup>

        {draft ? (
          <SettingsGroup dataTestId="terminal-preset-editor">
            <SettingsRow
              label="Name"
              htmlFor="terminal-preset-name"
              control={
                <SettingsTextField
                  id="terminal-preset-name"
                  width="md"
                  aria-label="Preset name"
                  value={draft.name}
                  maxLength={64}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Custom TUI"
                />
              }
            />
            <SettingsRow
              label="Shell"
              htmlFor="terminal-preset-shell"
              control={
                <SettingsSelect
                  id="terminal-preset-shell"
                  aria-label="Shell"
                  value={draft.terminalProfileId}
                  onChange={(event) => {
                    const selected = shellOptions.find(
                      (option) => option.id === event.target.value,
                    );
                    if (!selected) return;
                    setDraft({
                      ...draft,
                      terminalProfileId: selected.id,
                    });
                  }}
                >
                  {shellOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </SettingsSelect>
              }
            />
            <SettingsRow
              label="Command"
              htmlFor="terminal-preset-command"
              description="Runs in the shell when the terminal opens."
            >
              <SettingsTextField
                mono
                id="terminal-preset-command"
                width="full"
                aria-label="Command"
                value={draft.command}
                maxLength={4000}
                onChange={(event) =>
                  setDraft({ ...draft, command: event.target.value })
                }
                placeholder="npm run dev"
              />
            </SettingsRow>
            <SettingsRow
              label="Icon"
              htmlFor="terminal-preset-icon-character"
              description="A character, or an image or SVG."
              control={
                <>
                  <SettingsTextField
                    id="terminal-preset-icon-character"
                    width="xs"
                    aria-label="Icon character"
                    value={
                      draft.icon?.kind === 'character' ? draft.icon.value : ''
                    }
                    maxLength={16}
                    onChange={(event) => {
                      const value = event.target.value;
                      const icon: TerminalPresetIcon | undefined = value
                        ? { kind: 'character', value }
                        : undefined;
                      setDraft({ ...draft, icon });
                    }}
                    placeholder="★"
                  />
                  {!draftImage ? (
                    <PresetImageButton
                      inputLabel="Image or SVG"
                      onChange={(event) => handleImage(event, colorMode)}
                    >
                      <ImagePlus width={14} height={14} />
                      Image or SVG
                    </PresetImageButton>
                  ) : null}
                </>
              }
            />
            {draftImage && draftLightImage && draftDarkImage ? (
              <SettingsRow
                label="Image or SVG"
                description="A missing mode reuses the configured image."
                dataTestId="terminal-preset-images"
                control={
                  draftImage.lightDataUrl && draftImage.darkDataUrl ? (
                    <Tooltip label="Swap light and dark images">
                      <Button
                        size={settingsButtonSize}
                        variant="ghost"
                        iconOnly
                        aria-label="Swap light and dark preset images"
                        onClick={handleSwapImages}
                      >
                        <SyncIcon width={14} height={14} />
                      </Button>
                    </Tooltip>
                  ) : null
                }
              >
                <PresetImageModeRow
                  colorMode="light"
                  configuredDataUrl={draftImage.lightDataUrl}
                  resolvedDataUrl={draftLightImage}
                  onChange={(event) => handleImage(event, 'light')}
                />
                <PresetImageModeRow
                  colorMode="dark"
                  configuredDataUrl={draftImage.darkDataUrl}
                  resolvedDataUrl={draftDarkImage}
                  onChange={(event) => handleImage(event, 'dark')}
                />
              </SettingsRow>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size={settingsButtonSize}
                variant="ghost"
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button
                size={settingsButtonSize}
                variant="primary"
                onClick={handleSavePreset}
                disabled={saving || !draft.name.trim() || !draft.command.trim()}
              >
                Save preset
              </Button>
            </div>
          </SettingsGroup>
        ) : null}
      </SettingsSection>
      {error ? <Notice intent="destructive">{error}</Notice> : null}
    </SettingsPage>
  );
}
