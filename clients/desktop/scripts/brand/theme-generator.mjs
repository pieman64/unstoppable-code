import {
  defaultGeneratedThemeTuning,
  generatedThemeRecipeTuningKeys,
  generatedThemeTuningRanges,
  generateThemeFamily,
  parseCssColorToOklch,
} from './color-engine.generated.mjs';
import {
  buildThemeTokenGraph,
  generatedSemanticTokenNames,
} from './token-graph.mjs';

export const THEME_ENGINE_ID = 'ui-kit-v1';

export const THEME_RECIPE_DEFAULTS = Object.freeze({
  contrast: 1,
  neutralTint: 0.005,
  surfaceHue: 100,
  borderContrast: 0.5,
  darkAccentTone: 0,
  tuning: Object.freeze(
    Object.fromEntries(
      generatedThemeRecipeTuningKeys.map((key) => [
        key,
        defaultGeneratedThemeTuning[key],
      ]),
    ),
  ),
  radius: '12px',
});

const COMPATIBILITY_TOKEN_MAP = Object.freeze({
  bgBase: 'bg-base',
  bgCard: 'bg-primary',
  bgSecondary: 'bg-secondary',
  bgMuted: 'bg-muted',
  bgAccent: 'bg-accent',
  bgAccentSubtle: 'bg-accent-muted',
  bgDestructive: 'bg-destructive',
  bgDestructiveSubtle: 'bg-destructive-muted',
  bgSidebar: 'bg-depth',
  bgPopover: 'bg-secondary',
  bgSuccess: 'bg-positive',
  bgSuccessSubtle: 'bg-positive-muted',
  bgWarning: 'bg-attention',
  bgWarningSubtle: 'bg-attention-muted',
  bgInfo: 'bg-special',
  bgInfoSubtle: 'bg-special-muted',
  fgPrimary: 'fg-primary',
  fgSecondary: 'fg-secondary',
  fgEmphasis: 'fg-emphasis',
  border: 'line-base',
  ring: 'line-focus',
  shadowSm: 'shadow-surface-sm',
  shadowMd: 'shadow-surface-md',
  shadowLg: 'shadow-surface-lg',
  shadowXl: 'shadow-surface-xl',
  shadowFocus: 'effect-ring-focus',
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function finiteNumber(value, fallback, label) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
    throw new Error(`${label} must be a finite number`);
  }
  return resolved;
}

function normalizeTuning(value, label) {
  if (value !== undefined && !isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(
    generatedThemeRecipeTuningKeys.map((key) => {
      const resolved = finiteNumber(
        value?.[key],
        THEME_RECIPE_DEFAULTS.tuning[key],
        `${label}.${key}`,
      );
      const range = generatedThemeTuningRanges[key];
      return [key, Math.max(range.min, Math.min(range.max, resolved))];
    }),
  );
}

export function normalizeThemeRecipe(value, label = 'theme recipe') {
  if (!isRecord(value)) throw new Error(`${label} is required`);
  if (value.engine !== THEME_ENGINE_ID) {
    throw new Error(`${label}.engine must be "${THEME_ENGINE_ID}"`);
  }
  if (!isRecord(value.base)) {
    throw new Error(`${label}.base is required`);
  }

  const light = requiredString(value.base.light, `${label}.base.light`);
  const dark = requiredString(value.base.dark, `${label}.base.dark`);
  const parsedBase = parseCssColorToOklch(light);
  const hasVisibleBaseTint = parsedBase.c >= 0.001;
  const derivedNeutralTint = hasVisibleBaseTint
    ? Math.min(parsedBase.c, 0.045)
    : THEME_RECIPE_DEFAULTS.neutralTint;
  const derivedSurfaceHue = hasVisibleBaseTint
    ? parsedBase.h
    : THEME_RECIPE_DEFAULTS.surfaceHue;

  return {
    engine: THEME_ENGINE_ID,
    base: {
      lighter:
        typeof value.base.lighter === 'string' && value.base.lighter.trim()
          ? value.base.lighter.trim()
          : light,
      light,
      dark,
      darker:
        typeof value.base.darker === 'string' && value.base.darker.trim()
          ? value.base.darker.trim()
          : dark,
    },
    accent: requiredString(value.accent, `${label}.accent`),
    contrast: finiteNumber(
      value.contrast,
      THEME_RECIPE_DEFAULTS.contrast,
      `${label}.contrast`,
    ),
    neutralTint: finiteNumber(
      value.neutralTint,
      derivedNeutralTint,
      `${label}.neutralTint`,
    ),
    surfaceHue: finiteNumber(
      value.surfaceHue,
      derivedSurfaceHue,
      `${label}.surfaceHue`,
    ),
    borderContrast: finiteNumber(
      value.borderContrast,
      THEME_RECIPE_DEFAULTS.borderContrast,
      `${label}.borderContrast`,
    ),
    darkAccentTone: finiteNumber(
      value.darkAccentTone,
      THEME_RECIPE_DEFAULTS.darkAccentTone,
      `${label}.darkAccentTone`,
    ),
    tuning: normalizeTuning(value.tuning, `${label}.tuning`),
    radius:
      typeof value.radius === 'string' && value.radius.trim()
        ? value.radius.trim()
        : THEME_RECIPE_DEFAULTS.radius,
  };
}

function collectGenerationFailures(theme, mode) {
  const contrast = theme.contrastReport
    .filter((item) => !item.passes)
    .map((item) => `${mode}: ${item.foreground} on ${item.background}`);
  const nonText = theme.nonTextContrastReport
    .filter((item) => !item.passes)
    .map((item) => `${mode}: ${item.subject} on ${item.background}`);
  const gamut = theme.debug.gamutWarnings.map(
    (warning) => `${mode}: ${warning.token}`,
  );
  return { contrast, nonText, gamut };
}

function compatibilityTokens(graph, radius) {
  return Object.fromEntries([
    ...Object.entries(COMPATIBILITY_TOKEN_MAP).map(
      ([compatibilityName, semanticName]) => [
        compatibilityName,
        graph.semantic[semanticName],
      ],
    ),
    ['radius', radius],
  ]);
}

function modeOutput(theme, radius, options) {
  const graph = buildThemeTokenGraph(theme, radius, options);
  return {
    ...compatibilityTokens(graph, radius),
    ...graph,
  };
}

export function generateThemeFromRecipe(value, label = 'theme recipe') {
  const recipe = normalizeThemeRecipe(value, label);
  const family = generateThemeFamily(
    {
      neutralSeed: recipe.base.light,
      variantBaseSeeds: recipe.base,
      accent: recipe.accent,
      contrast: recipe.contrast,
      neutralTint: recipe.neutralTint,
      surfaceHue: recipe.surfaceHue,
    },
    {
      ...recipe.tuning,
      borderStrengthScale: recipe.borderContrast,
    },
  );

  const lightFailures = collectGenerationFailures(
    family.variants.light,
    'light',
  );
  const darkFailures = collectGenerationFailures(family.variants.dark, 'dark');
  const failures = {
    contrast: [...lightFailures.contrast, ...darkFailures.contrast],
    nonText: [...lightFailures.nonText, ...darkFailures.nonText],
    gamut: [...lightFailures.gamut, ...darkFailures.gamut],
  };
  const allFailures = [
    ...failures.contrast,
    ...failures.nonText,
    ...failures.gamut,
  ];
  if (allFailures.length > 0) {
    throw new Error(
      `${label} failed generated color checks:\n${allFailures
        .slice(0, 20)
        .map((failure) => `- ${failure}`)
        .join('\n')}`,
    );
  }

  const light = modeOutput(family.variants.light, recipe.radius);
  const dark = modeOutput(family.variants.dark, recipe.radius, {
    darkAccentTone: recipe.darkAccentTone,
  });

  return {
    recipe,
    swatch: {
      light: {
        background: light.semantic['bg-base'],
        accent: light.semantic['bg-accent'],
      },
      dark: {
        background: dark.semantic['bg-base'],
        accent: dark.semantic['bg-accent'],
      },
    },
    light,
    dark,
  };
}

export { generatedSemanticTokenNames };
