import type { DesktopBrandRuntime } from '@canopy/protocol/brand';

export function linuxUpdateCopy(
  brand: Pick<DesktopBrandRuntime, 'displayName'> &
    Partial<Pick<DesktopBrandRuntime, 'id'>>,
  flavor?: string,
): {
  apt: { command: string; introduction: string; bootstrap: string } | null;
  downloadLabel: string;
  manual: string;
  unsupported: string;
  unavailable: string;
  authentication: string;
  verification: string;
} {
  // Keep this browser-safe policy aligned with the public APT build contract.
  // Missing brand identity/flavor retains the original manual-download API.
  const apt =
    brand.id === 'unstoppable-code' && flavor === 'stable'
      ? {
          command: 'sudo apt update && sudo apt upgrade',
          introduction: `Update ${brand.displayName} with APT. Run in your terminal:`,
          bootstrap:
            'If this installation predates APT repository support, install the current official .deb once more to set up the repository.',
        }
      : null;
  return {
    apt,
    downloadLabel: apt ? 'Reinstall Linux package' : 'Download Linux update',
    manual: apt
      ? `${apt.introduction} ${apt.command}. ${apt.bootstrap}`
      : `Linux updates must be installed manually. Download ${brand.displayName} from the official site and verify its published checksum before installing with your package manager.`,
    unsupported: `Linux update checks require an installed x64 or arm64 .deb package of ${brand.displayName}. Other packages and architectures are not supported.`,
    unavailable: `${brand.displayName} Linux updates are unavailable. Check your connection and try again. A verified .deb release for this architecture may not be published for this channel yet.`,
    authentication: `Connect GitHub in Settings > Account to check internal or RC Linux releases of ${brand.displayName}.`,
    verification: apt
      ? 'For the reinstall fallback, download the official Linux .deb matching your installed architecture. Verify its published checksum before installing with your package manager. The app never installs updates or requests administrator access.'
      : 'Download the Linux .deb matching your installed architecture from the official site. Verify its published checksum before installing with your package manager. The app never installs updates or requests administrator access.',
  };
}
