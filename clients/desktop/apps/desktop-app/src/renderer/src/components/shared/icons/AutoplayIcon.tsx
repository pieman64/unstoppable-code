import type { JSX } from 'react';

interface AutoplayIconProps {
  /** Icon size in pixels for both width and height. Defaults to 14. */
  size?: number;
  className?: string;
}

/**
 * Circular autoplay glyph used for persistent, automatic AI Credits routing.
 * Adapted from the Material Symbols autoplay SVG supplied for this UI.
 */
export function AutoplayIcon({
  size = 14,
  className = 'shrink-0',
}: AutoplayIconProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      className={className}
    >
      <path d="M408-312v-336l264 168-264 168Zm72 262q-109 0-203.5-52T120-244v110H48v-228h228v72h-99q51 78 130.5 123T480-122q116 0 209-67.5T821-366l70 16q-43 135-156 217.5T480-50ZM50-518q6-67 31-129t70-113l51 51q-33 42-54 90t-26 101H50Zm202-242-50-51q51-45 113-70.5T444-912v72q-53 6-101.5 27T252-760Zm456 0q-42-33-90.5-53.5T516-840v-72q68 5 130 30t113 70l-51 52Zm130 242q-6-53-26.5-101T758-709l52-52q44 51 70 113t31 130h-73Z" />
    </svg>
  );
}
