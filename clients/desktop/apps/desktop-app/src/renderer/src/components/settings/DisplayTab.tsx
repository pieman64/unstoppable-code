import { type JSX, useEffect, useRef, useState } from 'react';
import {
  THEME_NAMES,
  COLOR_MODES,
  WORKTREE_DIFF_STATS_STYLES,
  SCROLLBAR_BEHAVIORS,
  CHAT_ENRICHMENT_MODES,
  WORKSPACE_LAYOUT_MODES,
  type ChatEnrichmentMode,
  type PreferencesData,
  type WorktreeDiffStatsStyle,
  type ScrollbarBehavior,
  type ThemeName,
  type ColorMode,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from '@canopy/desktop-shared/lib/ui-scale';
import {
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
} from '@canopy/desktop-shared/constants/preferences';
import { applyScrollbarBehavior, applyTheme, applyUiScale } from '@/lib/theme';
import { brand } from '@/lib/brand';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { WORKSPACE_LAYOUT_MODE_COPY } from '@/lib/panels/layout-mode-copy';
import { AppearanceSelect, Button } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingsSelect,
} from './SettingsLayout';
import { SidebarStyleSettingsRow } from './SidebarStyleSettingsRow';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';
import { useNavigationStore } from '@/stores/navigationStore';

type ResolvedColorMode = Exclude<ColorMode, 'system'>;

function readCurrentColorMode(): ResolvedColorMode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

const VALID_THEME_SET = new Set<string>(THEME_NAMES);

function isThemeName(value: string): value is ThemeName {
  return VALID_THEME_SET.has(value);
}

function readCurrentTheme(): ThemeName {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && isThemeName(attr)) return attr;
  return 'default';
}

function readCurrentScale(): number {
  const attr = document.documentElement.getAttribute('data-ui-scale');
  if (attr) {
    const n = Number(attr);
    if (n >= 75 && n <= 200) return n;
  }
  return 100;
}

interface ThemeSwatchColors {
  light: { bg: string; accent: string };
  dark: { bg: string; accent: string };
}

const THEME_META: Record<
  ThemeName,
  { label: string; colors: ThemeSwatchColors }
> = {
  default: {
    label: brand.theme.default.label,
    colors: {
      light: {
        bg: brand.theme.default.swatch.light.background,
        accent: brand.theme.default.swatch.light.accent,
      },
      dark: {
        bg: brand.theme.default.swatch.dark.background,
        accent: brand.theme.default.swatch.dark.accent,
      },
    },
  },
  unstoppable: {
    label: 'Cobalt',
    colors: {
      light: { bg: '#F2F2F1', accent: '#0064FF' },
      dark: { bg: '#0B0B0B', accent: '#5F9DFF' },
    },
  },
  dusk: {
    label: 'Dusk',
    colors: {
      light: { bg: '#F5F5F4', accent: '#0F9226' },
      dark: { bg: '#141414', accent: '#47AF4E' },
    },
  },
  lime: {
    label: 'Lime',
    colors: {
      light: { bg: '#EBECE6', accent: '#8643FC' },
      dark: { bg: '#101010', accent: '#9D6EFF' },
    },
  },
  ocean: {
    label: 'Ocean',
    colors: {
      light: { bg: '#ECEFF2', accent: '#007FCE' },
      dark: { bg: '#2A2D2E', accent: '#009BF9' },
    },
  },
  retro: {
    label: 'Retro',
    colors: {
      light: { bg: '#F4F2EC', accent: '#C66100' },
      dark: { bg: '#1A1A18', accent: '#E1842E' },
    },
  },
  neo: {
    label: 'Neo',
    colors: {
      light: { bg: '#F9F7F9', accent: '#B730CB' },
      dark: { bg: '#0D0D0D', accent: '#D259E5' },
    },
  },
  forest: {
    label: 'Forest',
    colors: {
      light: { bg: '#EEF4F0', accent: '#009132' },
      dark: { bg: '#232724', accent: '#32B058' },
    },
  },
};

// The dropdown offers the whole supported range. Sourced from the shared
// module so the dropdown, the View-menu zoom items and `normalizePreferences`
// cannot drift apart.
const SCALE_MIN = UI_SCALE_MIN;
const SCALE_MAX = UI_SCALE_MAX;
const SCALE_STEP = UI_SCALE_STEP;

const SCROLLBAR_BEHAVIOR_META: Record<
  ScrollbarBehavior,
  { label: string; description: string }
> = {
  system: {
    label: 'System',
    description: 'Derived from your system settings.',
  },
  always: {
    label: 'Always',
    description: 'Keep scrollbars visible whenever content can scroll.',
  },
  scroll: {
    label: 'While scrolling',
    description: 'Show during wheel or trackpad scrolling, then fade away.',
  },
  hover: {
    label: 'On hover',
    description: 'Show while hovering over a scrollable area.',
  },
  never: {
    label: 'Never',
    description: 'Keep scrollbars hidden without disabling scrolling.',
  },
};

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const WORKTREE_DIFF_STATS_STYLE_META: Record<
  WorktreeDiffStatsStyle,
  { label: string; description: string }
> = {
  short: {
    label: 'Short',
    description: 'Abbreviate large counts, such as 1,234 to 1k.',
  },
  complete: {
    label: 'Complete',
    description: 'Show every digit, such as 1,234.',
  },
};

function savePreference(patch: Partial<PreferencesData>): void {
  void window.api.savePreferences(patch).then(emitPreferencesUpdated);
}

const CHAT_ENRICHMENT_MODE_META: Record<
  ChatEnrichmentMode,
  { label: string; description: string }
> = {
  replace: {
    label: 'Replace',
    description:
      'Show titles and icons in chat, with previews on hover or focus.',
  },
  hover: {
    label: 'Hover',
    description:
      'Keep the original text and add links with previews on hover or focus.',
  },
  off: {
    label: 'Off',
    description: 'Keep the original text and links without enrichment.',
  },
};

type ChatEnrichmentProvider = 'linear' | 'github';
type ChatEnrichmentModes = Record<ChatEnrichmentProvider, ChatEnrichmentMode>;

const CHAT_ENRICHMENT_PROVIDERS: readonly {
  readonly provider: ChatEnrichmentProvider;
  readonly label: string;
  readonly patch: (mode: ChatEnrichmentMode) => Partial<PreferencesData>;
}[] = [
  {
    provider: 'linear',
    label: 'Linear',
    patch: (mode) => ({ linearChatEnrichmentMode: mode }),
  },
  {
    provider: 'github',
    label: 'GitHub',
    patch: (mode) => ({ githubChatEnrichmentMode: mode }),
  },
];

function readChatEnrichmentModes(
  preferences: PreferencesData,
): ChatEnrichmentModes {
  return {
    linear:
      preferences.linearChatEnrichmentMode ??
      DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    github:
      preferences.githubChatEnrichmentMode ??
      DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  };
}

/**
 * Per-provider modes backed by the saved preferences. A choice shows at once
 * and settles on the saved value; a failed save restores the last saved mode
 * and keeps its error until the next save of that provider. While a save is
 * pending, broadcasts for that provider only update the fallback, so an echo
 * of an earlier write cannot undo the newer choice. Every broadcast and
 * successful save bumps a version, so a mount load that answers after either
 * cannot replace the newer saved state.
 */
function useChatEnrichmentModes(): {
  readonly modes: ChatEnrichmentModes;
  readonly failed: Record<ChatEnrichmentProvider, boolean>;
  readonly choose: (
    provider: ChatEnrichmentProvider,
    patch: Partial<PreferencesData>,
    mode: ChatEnrichmentMode,
  ) => void;
} {
  const [modes, setModes] = useState<ChatEnrichmentModes>({
    linear: DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    github: DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  });
  const [failed, setFailed] = useState({ linear: false, github: false });
  const savedRef = useRef<ChatEnrichmentModes>(modes);
  const latestSaveRef = useRef({ linear: 0, github: 0 });
  const pendingSaveRef = useRef({ linear: 0, github: 0 });
  const savedVersionRef = useRef(0);

  // Rows with a pending save keep the choice until it settles.
  function applySaved(preferences: PreferencesData): void {
    const saved = readChatEnrichmentModes(preferences);
    savedRef.current = saved;
    setModes((current) => ({
      linear: pendingSaveRef.current.linear ? current.linear : saved.linear,
      github: pendingSaveRef.current.github ? current.github : saved.github,
    }));
  }

  useEffect(() => {
    const loadVersion = savedVersionRef.current;
    const unsubscribe =
      typeof window.api.onPreferencesSynced === 'function'
        ? window.api.onPreferencesSynced((preferences) => {
            savedVersionRef.current++;
            applySaved(preferences);
          })
        : undefined;
    void window.api.loadPreferences().then(
      (preferences) => {
        if (savedVersionRef.current === loadVersion) applySaved(preferences);
      },
      // Keep the defaults; the next broadcast or save supplies saved modes.
      () => {},
    );
    return unsubscribe;
  }, []);

  function choose(
    provider: ChatEnrichmentProvider,
    patch: Partial<PreferencesData>,
    mode: ChatEnrichmentMode,
  ): void {
    const save = ++latestSaveRef.current[provider];
    pendingSaveRef.current[provider] = save;
    setFailed((current) => ({ ...current, [provider]: false }));
    setModes((current) => ({ ...current, [provider]: mode }));
    const settle = (failedSave: boolean): void => {
      if (pendingSaveRef.current[provider] !== save) return;
      pendingSaveRef.current[provider] = 0;
      setModes((current) => ({
        ...current,
        [provider]: savedRef.current[provider],
      }));
      setFailed((current) => ({ ...current, [provider]: failedSave }));
    };
    void window.api.savePreferences(patch).then(
      (preferences) => {
        // Saves commit in order, so every success is the newest saved state.
        savedVersionRef.current++;
        settle(false);
        applySaved(preferences);
        emitPreferencesUpdated(preferences);
      },
      () => settle(true),
    );
  }

  return { modes, failed, choose };
}

function ChatEnrichmentSection(): JSX.Element {
  const { modes, failed, choose } = useChatEnrichmentModes();
  return (
    <SettingsSection
      title="Chat area data enrichment"
      dataTestId="chat-enrichment-section"
    >
      <SettingsGroup>
        {CHAT_ENRICHMENT_PROVIDERS.map(({ provider, label, patch }) => {
          const id = `settings-${provider}-chat-enrichment-mode`;
          return (
            <SettingsRow
              key={provider}
              label={label}
              htmlFor={id}
              dataTestId={`${provider}-chat-enrichment-row`}
              control={
                <SettingsSelect
                  id={id}
                  aria-label={`${label} chat enrichment`}
                  value={modes[provider]}
                  onChange={(event) => {
                    const next = CHAT_ENRICHMENT_MODES.find(
                      (mode) => mode === event.target.value,
                    );
                    if (next) choose(provider, patch(next), next);
                  }}
                  data-testid={id}
                >
                  {CHAT_ENRICHMENT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {CHAT_ENRICHMENT_MODE_META[mode].label}
                    </option>
                  ))}
                </SettingsSelect>
              }
            >
              {failed[provider] ? (
                <p role="alert" className="text-xs fg-destructive">
                  Could not save this setting. Try again.
                </p>
              ) : null}
            </SettingsRow>
          );
        })}
        <SettingsRow
          label="How it works"
          dataTestId="chat-enrichment-how-it-works"
          description={
            <ul className="space-y-1">
              {CHAT_ENRICHMENT_MODES.map((mode) => (
                <li key={mode}>
                  <span className="font-medium fg-primary">
                    {CHAT_ENRICHMENT_MODE_META[mode].label}
                  </span>
                  {' — '}
                  {CHAT_ENRICHMENT_MODE_META[mode].description}
                </li>
              ))}
            </ul>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

export function DisplayTab(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [theme, setTheme] = useState<ThemeName>(readCurrentTheme);
  const [colorMode, setColorMode] = useState<ColorMode>(readCurrentColorMode);
  const [systemColorMode, setSystemColorMode] =
    useState<ResolvedColorMode>(readCurrentColorMode);
  const [worktreeDiffStatsStyle, setWorktreeDiffStatsStyle] =
    useState<WorktreeDiffStatsStyle>('short');
  const [scrollbarBehavior, setScrollbarBehavior] =
    useState<ScrollbarBehavior>('system');
  const [uiScale, setUiScale] = useState(readCurrentScale);
  // Newest `uiScale` this component wrote and has not seen echoed back.
  const inFlightScaleRef = useRef<number | null>(null);
  const [defaultLayoutMode, setDefaultLayoutMode] =
    useState<WorkspaceLayoutMode>('advanced');
  // The default for new worktrees. Every worktree keeps its own mode, with
  // or without early access.
  const workspaceLayoutMode = defaultLayoutMode;
  const [workspaceLayoutSaveError, setWorkspaceLayoutSaveError] = useState<
    string | null
  >(null);

  useEffect(() => {
    void window.api.loadPreferences().then((prefs) => {
      setTheme(prefs.theme);
      setColorMode(prefs.colorMode);
      setWorktreeDiffStatsStyle(prefs.worktreeDiffStatsStyle ?? 'short');
      setScrollbarBehavior(prefs.scrollbarBehavior ?? 'system');
      setUiScale(prefs.uiScale);
      setDefaultLayoutMode(prefs.workspaceDefaultLayoutMode);
      applyTheme(prefs.theme, prefs.colorMode);
      applyScrollbarBehavior(prefs.scrollbarBehavior);
      applyUiScale(prefs.uiScale);
    });
  }, []);

  useEffect(() => {
    if (typeof window.api.onPreferencesSynced !== 'function') {
      return undefined;
    }
    // The dropdown is not the only writer of `uiScale`: the View menu's Zoom
    // In / Zoom Out / Actual Size items step the same preference, and main
    // broadcasts every save. Without this the dropdown would keep showing the
    // value it loaded on mount while the window around it was already
    // zoomed. `applyUiScale` is not called here — the broadcast follows a
    // commit that main has already applied to every window, and the
    // renderer's own zoom watcher republishes `data-ui-scale` from it.
    return window.api.onPreferencesSynced((preferences) => {
      // ...but an echo of our own in-flight write must not fight the latest selection.
      // Every scale choice saves, main commits saves one at a time behind an
      // atomic file write and broadcasts each back to every window including
      // this one, so choosing 100 then 130 produces a stream of stale values
      // (105, 110, ...) while the selected value is already past them. Applying those
      // would replace the newest selection with an older value.
      // Ignore broadcasts until one carries the newest value we wrote: that
      // one means main has caught up, and anything after it is a genuine
      // external change. A lost save re-arms the gate on the next move.
      if (inFlightScaleRef.current !== null) {
        if (preferences.uiScale === inFlightScaleRef.current) {
          inFlightScaleRef.current = null;
        }
        return;
      }
      setUiScale(preferences.uiScale);
    });
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemColorMode = (): void => {
      setSystemColorMode(mediaQuery.matches ? 'dark' : 'light');
    };
    updateSystemColorMode();
    mediaQuery.addEventListener('change', updateSystemColorMode);
    return (): void => {
      mediaQuery.removeEventListener('change', updateSystemColorMode);
    };
  }, []);

  function handleThemeChange(next: ThemeName): void {
    setTheme(next);
    applyTheme(next, colorMode);
    savePreference({ theme: next });
  }

  function handleColorModeChange(next: ColorMode): void {
    setColorMode(next);
    applyTheme(theme, next);
    savePreference({ colorMode: next });
  }

  function handleScaleChange(next: number): void {
    inFlightScaleRef.current = next;
    setUiScale(next);
    applyUiScale(next);
    savePreference({ uiScale: next });
  }

  function handleWorktreeDiffStatsStyleChange(
    next: WorktreeDiffStatsStyle,
  ): void {
    setWorktreeDiffStatsStyle(next);
    savePreference({ worktreeDiffStatsStyle: next });
  }

  function handleWorkspaceLayoutModeChange(next: WorkspaceLayoutMode): void {
    if (next === workspaceLayoutMode) return;
    setWorkspaceLayoutSaveError(null);
    const previous = defaultLayoutMode;
    setDefaultLayoutMode(next);
    void window.api
      .savePreferences({ workspaceDefaultLayoutMode: next })
      .catch(() => {
        setDefaultLayoutMode(previous);
        setWorkspaceLayoutSaveError("Couldn't save project layout setting.");
      });
  }

  function handleScrollbarBehaviorChange(next: ScrollbarBehavior): void {
    setScrollbarBehavior(next);
    applyScrollbarBehavior(next);
    savePreference({ scrollbarBehavior: next });
  }

  const scrollbarMeta = SCROLLBAR_BEHAVIOR_META[scrollbarBehavior];
  return (
    <SettingsPage title="Display" dataTestId="settings-tab-display">
      <SettingsSection title="Appearance">
        <SettingsGroup>
          <SettingsRow
            label="Color mode"
            description={
              colorMode === 'system'
                ? 'Follows your system setting.'
                : undefined
            }
            control={
              <AppearanceSelect
                label="Color mode"
                value={colorMode}
                onChange={handleColorModeChange}
                testId="settings-color-mode-select"
                options={COLOR_MODES.map((mode) => ({
                  value: mode,
                  label: COLOR_MODE_LABELS[mode],
                  testId: `color-mode-${mode}`,
                }))}
              />
            }
          />
          <SettingsRow
            label="Theme"
            description="The color palette for the interface."
            control={
              <AppearanceSelect
                label="Theme"
                value={theme}
                onChange={handleThemeChange}
                testId="settings-theme-select"
                options={THEME_NAMES.map((name) => {
                  const meta = THEME_META[name];
                  const swatch =
                    meta.colors[
                      colorMode === 'system' ? systemColorMode : colorMode
                    ];
                  return {
                    value: name,
                    label: meta.label,
                    testId: `theme-swatch-${name}`,
                    // Each dot uses the represented theme's accent color.
                    preview: (
                      <span
                        aria-hidden="true"
                        data-testid={`theme-color-dot-${name}`}
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: swatch.accent }}
                      />
                    ),
                  };
                })}
              />
            }
          />
          <SidebarStyleSettingsRow />
          <SettingsRow
            label="Interface scale"
            description="The overall size of the interface."
            control={
              <>
                {uiScale !== 100 ? (
                  <Button
                    size={settingsButtonSize}
                    variant="ghost"
                    onClick={() => handleScaleChange(100)}
                    data-testid="settings-ui-scale-reset"
                  >
                    Reset
                  </Button>
                ) : null}
                <AppearanceSelect
                  label="Interface scale"
                  value={String(uiScale)}
                  onChange={(value) => handleScaleChange(Number(value))}
                  testId="settings-ui-scale-select"
                  options={Array.from(
                    { length: (SCALE_MAX - SCALE_MIN) / SCALE_STEP + 1 },
                    (_, index) => {
                      const scale = SCALE_MIN + index * SCALE_STEP;
                      return {
                        value: String(scale),
                        label: `${scale}%`,
                        testId: `settings-ui-scale-option-${scale}`,
                      };
                    },
                  )}
                />
              </>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingsGroup>
          {/* Keep customization available from Display as well as More. */}
          <SettingsRow
            label="Sidebar items"
            description="Choose which pages the sidebar shows and in what order."
            control={
              <Button
                size={settingsButtonSize}
                variant="secondary"
                data-testid="settings-customize-sidebar"
                onClick={() => {
                  const navigation = useNavigationStore.getState();
                  navigation.closeSettings();
                  navigation.requestCustomizeSidebar();
                }}
              >
                Customize…
              </Button>
            }
          />
          <SettingsRow
            label="Project layout"
            description={
              <>
                {WORKSPACE_LAYOUT_MODE_COPY[workspaceLayoutMode].description}{' '}
                Used for new worktrees and work entries.
              </>
            }
            control={
              <SettingsSegmentedControl
                label="Project layout"
                value={workspaceLayoutMode}
                onChange={handleWorkspaceLayoutModeChange}
                options={WORKSPACE_LAYOUT_MODES.map((mode) => ({
                  value: mode,
                  label: WORKSPACE_LAYOUT_MODE_COPY[mode].label,
                  dataTestId: `workspace-layout-default-${mode}`,
                }))}
              />
            }
          >
            {workspaceLayoutSaveError && (
              <p role="alert" className="text-xs fg-destructive">
                {workspaceLayoutSaveError}
              </p>
            )}
          </SettingsRow>
          <SettingsRow
            label="Scrollbars"
            htmlFor="settings-scrollbar-behavior"
            description={scrollbarMeta.description}
            dataTestId="scrollbar-behavior-row"
            control={
              <SettingsSelect
                id="settings-scrollbar-behavior"
                value={scrollbarBehavior}
                onChange={(event) => {
                  const next = SCROLLBAR_BEHAVIORS.find(
                    (behavior) => behavior === event.target.value,
                  );
                  if (next) handleScrollbarBehaviorChange(next);
                }}
                data-testid="settings-scrollbar-behavior"
              >
                {SCROLLBAR_BEHAVIORS.map((behavior) => (
                  <option key={behavior} value={behavior}>
                    {SCROLLBAR_BEHAVIOR_META[behavior].label}
                  </option>
                ))}
              </SettingsSelect>
            }
          />
          <SettingsRow
            label="Worktree diff stats"
            description={
              WORKTREE_DIFF_STATS_STYLE_META[worktreeDiffStatsStyle].description
            }
            dataTestId="worktree-diff-stats-section"
            control={
              <SettingsSegmentedControl
                label="Worktree diff stats"
                value={worktreeDiffStatsStyle}
                onChange={handleWorktreeDiffStatsStyleChange}
                options={WORKTREE_DIFF_STATS_STYLES.map((style) => ({
                  value: style,
                  label: WORKTREE_DIFF_STATS_STYLE_META[style].label,
                  dataTestId: `worktree-diff-stats-style-${style}`,
                }))}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <ChatEnrichmentSection />
    </SettingsPage>
  );
}
