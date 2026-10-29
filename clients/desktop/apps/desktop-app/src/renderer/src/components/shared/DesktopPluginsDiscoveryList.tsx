import type { JSX } from 'react';
import {
  PluginsDiscoveryList as SharedPluginsDiscoveryList,
  type PluginsDiscoveryListProps,
} from '@canopy/ui-shared/components';
import { McpServerLogo } from './McpServerLogo';

export type { PluginsDiscoveryListProps };
export type {
  PluginsDiscoverySection,
  PluginsDiscoverySectionId,
} from '@canopy/ui-shared/components';

/** Desktop adapter that preserves remote-logo and active-brand rendering. */
export function PluginsDiscoveryList(
  props: PluginsDiscoveryListProps,
): JSX.Element {
  return (
    <SharedPluginsDiscoveryList
      {...props}
      showPipelineSources
      McpServerLogoComponent={McpServerLogo}
    />
  );
}
