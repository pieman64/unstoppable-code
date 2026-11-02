import type * as ConfigPaths from '@canopy/desktop-shared/pipelines/config-paths';
import { installCodeGraphResourcesDirResolver } from '@canopy/code-graph/resources';

// Desktop hosts install the bundled resources directory at startup (CAN-5072);
// suites get the same directory without loading config-paths eagerly.
installCodeGraphResourcesDirResolver(() =>
  jest
    .requireActual<
      typeof ConfigPaths
    >('@canopy/desktop-shared/pipelines/config-paths')
    .getBundledCodeGraphDir(),
);
