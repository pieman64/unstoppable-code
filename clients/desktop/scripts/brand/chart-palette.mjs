import Color from 'colorjs.io';

/**
 * Canopy's chart palette policy.
 *
 * UI-Kit builds its six `categorical-*` colors from the accent and the intent
 * hues at one tone. That suits a swatch picker, but not a chart: the hues
 * change with the theme, a theme whose accent matches a status hue repeats a
 * hue (see swatch-palette.mjs), and green, orange, and red collapse together
 * for readers with red-green color blindness.
 *
 * `chart-categorical-*` is therefore bound to fixed steps of the engine's own
 * primitive scales, in one hue order for every theme and both appearances, so
 * a series keeps its hue when the theme or appearance changes. The steps were
 * chosen by search to pass `evaluateChartPalette` against every bundled
 * theme's surface. Change them only by rerunning that search; the generator
 * refuses a palette that fails.
 */
export const CHART_CATEGORICAL_PRIMITIVES = Object.freeze({
  light: Object.freeze([
    'blue-600',
    'orange-500',
    'pink-600',
    'cyan-500',
    'green-500',
    'purple-500',
  ]),
  dark: Object.freeze([
    'blue-400',
    'orange-400',
    'pink-500',
    'cyan-350',
    'green-400',
    'purple-350',
  ]),
});

/**
 * Distances are Euclidean in OKLab, times 100. The color-blind distance is
 * the smaller of the protan and deutan simulations.
 */
export const CHART_PALETTE_LIMITS = Object.freeze({
  // Marks of even weight: none near the surface, none glowing in dark.
  lightness: Object.freeze({ light: [0.43, 0.77], dark: [0.48, 0.67] }),
  // Below this a hue reads as gray.
  minChroma: 0.1,
  // WCAG non-text contrast against the page.
  minSurfaceContrast: 3,
  minColorBlindDistance: 8,
  minDistance: 15,
  // The first slots hold in any combination (scatter plots, maps); later
  // slots only promise to differ from their neighbors (lines, bars, stacks).
  freeCombinationSlots: 3,
});

// Machado, Oliveira and Fernandes (2009), severity 1, on linear sRGB.
const COLOR_BLIND_MATRICES = Object.freeze({
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
});

function oklabOfLinear(coords) {
  return new Color('srgb-linear', coords).to('oklab').coords;
}

function simulate(linear, matrix) {
  return matrix.map((row) =>
    Math.min(
      1,
      Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]),
    ),
  );
}

function describe(value) {
  const color = new Color(value);
  const linear = color.to('srgb-linear').coords;
  const [lightness, chroma] = color.to('oklch').coords;
  return {
    lightness,
    chroma,
    luminance: color.to('srgb').luminance,
    normal: oklabOfLinear(linear),
    protan: oklabOfLinear(simulate(linear, COLOR_BLIND_MATRICES.protan)),
    deutan: oklabOfLinear(simulate(linear, COLOR_BLIND_MATRICES.deutan)),
  };
}

function distance(left, right) {
  return (
    100 * Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])
  );
}

function contrast(left, right) {
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/**
 * Check an ordered categorical palette against a surface. Returns the reasons
 * it fails, empty when it passes, and the measured margins.
 */
export function evaluateChartPalette(colors, surface, mode) {
  const limits = CHART_PALETTE_LIMITS;
  const [minLightness, maxLightness] = limits.lightness[mode];
  const surfaceLuminance = new Color(surface).to('srgb').luminance;
  const slots = colors.map(describe);
  const failures = [];
  const metrics = {
    surfaceContrast: Infinity,
    neighborDistance: Infinity,
    neighborColorBlindDistance: Infinity,
    freeDistance: Infinity,
    freeColorBlindDistance: Infinity,
  };

  slots.forEach((slot, index) => {
    const name = `slot ${index + 1} (${colors[index]})`;
    if (slot.lightness < minLightness || slot.lightness > maxLightness) {
      failures.push(
        `${name} lightness ${slot.lightness.toFixed(3)} is outside ${minLightness}–${maxLightness}`,
      );
    }
    if (slot.chroma < limits.minChroma) {
      failures.push(`${name} chroma ${slot.chroma.toFixed(3)} reads as gray`);
    }
    const ratio = contrast(slot.luminance, surfaceLuminance);
    metrics.surfaceContrast = Math.min(metrics.surfaceContrast, ratio);
    if (ratio < limits.minSurfaceContrast) {
      failures.push(
        `${name} contrast ${ratio.toFixed(2)} against ${surface} is below ${limits.minSurfaceContrast}`,
      );
    }
  });

  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const neighbors = right === left + 1;
      const free = right < limits.freeCombinationSlots;
      if (!neighbors && !free) continue;
      const normal = distance(slots[left].normal, slots[right].normal);
      const colorBlind = Math.min(
        distance(slots[left].protan, slots[right].protan),
        distance(slots[left].deutan, slots[right].deutan),
      );
      if (neighbors) {
        metrics.neighborDistance = Math.min(metrics.neighborDistance, normal);
        metrics.neighborColorBlindDistance = Math.min(
          metrics.neighborColorBlindDistance,
          colorBlind,
        );
      }
      if (free) {
        metrics.freeDistance = Math.min(metrics.freeDistance, normal);
        metrics.freeColorBlindDistance = Math.min(
          metrics.freeColorBlindDistance,
          colorBlind,
        );
      }
      const pair = `slots ${left + 1} and ${right + 1} (${colors[left]}, ${colors[right]})`;
      if (normal < limits.minDistance) {
        failures.push(
          `${pair} are ${normal.toFixed(1)} apart, below ${limits.minDistance}`,
        );
      }
      if (colorBlind < limits.minColorBlindDistance) {
        failures.push(
          `${pair} are ${colorBlind.toFixed(1)} apart under red-green color blindness, below ${limits.minColorBlindDistance}`,
        );
      }
    }
  }
  return { failures, metrics };
}
