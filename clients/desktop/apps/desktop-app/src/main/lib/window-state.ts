import { screen } from 'electron';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { WindowBounds } from '@canopy/desktop-shared/types';

const MIN_WIDTH = 800;
const MIN_HEIGHT = 500;

export function validateWindowBounds(
  bounds: WindowBounds | null,
  options: { minWidth?: number; minHeight?: number } = {},
): WindowBounds | null {
  if (bounds === null) {
    return null;
  }

  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    return null;
  }

  const matchingDisplay = displays.find((display) => {
    const wa = display.workArea;
    return (
      bounds.x >= wa.x &&
      bounds.x < wa.x + wa.width &&
      bounds.y >= wa.y &&
      bounds.y < wa.y + wa.height
    );
  });

  // Wayland owns placement and can report (0, 0), outside GNOME's work
  // area below the top bar. Keep the saved size even when that origin (or
  // a disconnected monitor's coordinates) cannot identify a display.
  // X11 still restores meaningful positions; Wayland may ignore them.
  const targetDisplay =
    matchingDisplay ??
    (hostPlatformOperatingSystem() === 'linux'
      ? screen.getPrimaryDisplay()
      : null);

  if (!targetDisplay) {
    return null;
  }

  const wa = targetDisplay.workArea;
  const minWidth = options.minWidth ?? MIN_WIDTH;
  const minHeight = options.minHeight ?? MIN_HEIGHT;
  const width = Math.max(minWidth, Math.min(bounds.width, wa.width));
  const height = Math.max(minHeight, Math.min(bounds.height, wa.height));

  const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height));

  return { x, y, width, height };
}
