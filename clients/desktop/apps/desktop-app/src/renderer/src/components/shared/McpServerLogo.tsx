import type { JSX, ReactNode } from 'react';
import {
  McpServerLogo as SharedMcpServerLogo,
  type McpServerLogoProps as SharedMcpServerLogoProps,
} from '@canopy/ui-shared/components';
import { useSafeRemoteImageUrl } from '@/lib/remote-image';
import { BrandLogo } from '@/components/BrandLogo';

export type McpServerLogoProps = Omit<
  SharedMcpServerLogoProps,
  'useRemoteLogo' | 'renderBrandMark'
>;

/**
 * Desktop host adapter for the shared MCP logo display core. It injects the
 * stateful IPC data-URL resolver and active brand renderer here so all desktop
 * callers retain their existing prop contract while `@canopy/ui-shared`
 * remains free of renderer, preload, and brand-runtime dependencies.
 */
export function McpServerLogo(props: McpServerLogoProps): JSX.Element {
  return (
    <SharedMcpServerLogo
      {...props}
      useRemoteLogo={useSafeRemoteImageUrl}
      renderBrandMark={(size): ReactNode => (
        <BrandLogo size={size} aria-hidden data-testid={props.fallbackTestId} />
      )}
    />
  );
}
