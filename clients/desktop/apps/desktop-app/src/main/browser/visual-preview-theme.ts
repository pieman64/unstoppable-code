import { nativeTheme } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { THEME_NAMES } from '@canopy/desktop-shared/types';
import {
  sanitizeAgentVisualTheme,
  type AgentVisualTheme,
} from '@canopy/ui-shared/lib/agent-visual-html';
import { AGENT_VISUAL_THEME_DEFAULTS } from '@canopy/ui-shared/lib/agent-visual-theme-defaults';
import { readPreferencesFile } from '../lib/preferences-store';
import type { VisualAppearance } from './visual-preview-types';

function isThemeName(value: string): value is (typeof THEME_NAMES)[number] {
  return THEME_NAMES.some((name) => name === value);
}

export async function resolveVisualPreviewTheme(
  requested?: VisualAppearance,
): Promise<AgentVisualTheme> {
  let theme: (typeof THEME_NAMES)[number] = 'default';
  let appearance: VisualAppearance = nativeTheme.shouldUseDarkColors
    ? 'dark'
    : 'light';
  try {
    const preferences = await readPreferencesFile();
    if (isThemeName(preferences.theme)) theme = preferences.theme;
    if (preferences.colorMode !== 'system') appearance = preferences.colorMode;
  } catch {
    // The preview is optional; damaged or unavailable preferences use defaults.
  }
  appearance = requested ?? appearance;
  return sanitizeAgentVisualTheme({
    appearance,
    variables: (AGENT_VISUAL_THEME_DEFAULTS[BRAND.id] ??
      AGENT_VISUAL_THEME_DEFAULTS.canopy)[theme][appearance],
  });
}
