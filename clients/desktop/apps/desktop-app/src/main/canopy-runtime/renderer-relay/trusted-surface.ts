import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import {
  isCurrentDesktopMainFrame,
  type DesktopAppWindow,
  type DesktopIpcEvent,
} from '../desktop-ipc-caller';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

export interface TrustedRelaySurface {
  surface: 'main' | 'app-advisor';
  window: DesktopAppWindow | null;
  url: string;
}

export function resolveTrustedRelaySurface(
  event: DesktopIpcEvent,
  surfaces: readonly TrustedRelaySurface[],
  grants: readonly CanopyCallerDescriptor['grants'][number][],
): { surface: TrustedRelaySurface['surface']; caller: CanopyCallerDescriptor } {
  const { sender, senderFrame: frame } = event;
  const trusted = surfaces.find(
    ({ window }) =>
      window !== null && !window.isDestroyed() && window.webContents === sender,
  );
  if (
    !isCurrentDesktopMainFrame(sender, frame) ||
    !trusted ||
    frame.url !== sender.getURL() ||
    !samePage(frame.url, trusted.url)
  ) {
    throw canopyPermissionDeniedError('Untrusted renderer relay surface.');
  }
  return {
    surface: trusted.surface,
    caller: {
      principalId: `local-desktop-renderer:${trusted.surface}`,
      clientInstanceId: `electron-web-contents:${sender.id}`,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: [...grants],
    },
  };
}

function samePage(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}
