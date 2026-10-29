import Color from 'colorjs.io';

/**
 * Canopy's swatch policy for `categorical-1` to `categorical-6`.
 *
 * UI-Kit sets swatch 1 to the theme accent, swatches 2 to 5 to the status
 * hues (green, orange, red, purple), and swatch 6 to the accent hue plus 76
 * degrees. A theme whose accent is green, orange, or purple, or whose sixth
 * hue lands on a status hue, therefore shows the same color twice: green
 * accents repeat swatch 2, and retro, lime, neo, and ocean each repeat one or
 * two others.
 *
 * The token graph keeps every swatch the engine produced except a later
 * swatch that duplicates an earlier one. That swatch takes the first
 * replacement family that no other swatch uses, at the step nearest its own
 * lightness that clears every other swatch by `replacementDistance` and still
 * passes its contrast checks. The order is fixed, so a theme gets the same
 * replacement hue in light and dark. Generation fails when no family clears
 * the others.
 *
 * Distances are Euclidean in OKLab, times 100, in normal vision. Unlike the
 * chart series, swatches are not checked for color-blind readers: they always
 * appear with a name or an icon.
 */
export const SWATCH_POLICY = Object.freeze({
  // Closer than this, two swatches read as the same color.
  duplicateDistance: 5,
  // A replacement must clear every other swatch by at least this much.
  replacementDistance: 12,
  // How far a replacement's OKLCH lightness may move from the swatch it
  // replaces, so white glyphs on swatches keep the same contrast.
  lightnessTolerance: 0.08,
  // Sky blue first, then pink: the two primitive hues the engine never uses
  // for a status swatch.
  replacementFamilies: Object.freeze(['cyan', 'pink']),
});

export function swatchDistance(left, right) {
  return 100 * new Color(left).deltaEOK(new Color(right));
}

export function swatchLightness(value) {
  return new Color(value).to('oklch').coords[0];
}

/** Pairs of swatches closer than the duplicate distance. */
export function findDuplicateSwatches(colors) {
  const duplicates = [];
  for (let left = 0; left < colors.length; left += 1) {
    for (let right = left + 1; right < colors.length; right += 1) {
      const distance = swatchDistance(colors[left], colors[right]);
      if (distance < SWATCH_POLICY.duplicateDistance) {
        duplicates.push({ left: left + 1, right: right + 1, distance });
      }
    }
  }
  return duplicates;
}
