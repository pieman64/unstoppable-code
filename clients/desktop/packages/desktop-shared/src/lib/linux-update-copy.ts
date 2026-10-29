import type { DesktopBrandRuntime } from '@canopy/protocol/brand';

export function linuxUpdateCopy(
  brand: Pick<DesktopBrandRuntime, 'displayName'>,
): {
  manual: string;
  unsupported: string;
  unavailable: string;
  authentication: string;
  verification: string;
} {
  return {
    manual: `Linux updates must be installed manually. Download ${brand.displayName} from the official site and verify its published checksum before installing with your package manager.`,
    unsupported: `Linux update checks require an installed x64 or arm64 .deb package of ${brand.displayName}. Other packages and architectures are not supported.`,
    unavailable: `${brand.displayName} Linux updates are unavailable. Check your connection and try again. A verified .deb release for this architecture may not be published for this channel yet.`,
    authentication: `Connect GitHub in Settings > Account to check internal or RC Linux releases of ${brand.displayName}.`,
    verification:
      'Download the Linux .deb matching your installed architecture from the official site. Verify its published checksum before installing with your package manager. The app never installs updates or requests administrator access.',
  };
}
