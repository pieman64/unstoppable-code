import type { JSX, SVGProps } from 'react';
import { BrightnessAutoIcon as AppCatalogBrightnessAutoIcon } from './AppIcons';

/**
 * Material Symbols "brightness_auto" glyph. Used by the chat interface mode
 * toggle to represent the hybrid "auto" mode (Canopy viewing, terminal
 * execution).
 */
export function BrightnessAutoIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return <AppCatalogBrightnessAutoIcon width="14" height="14" {...props} />;
}
