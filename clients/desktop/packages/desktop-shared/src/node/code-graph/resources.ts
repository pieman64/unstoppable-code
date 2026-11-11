import { installCodeGraphResourcesDirResolver } from '@canopy/code-graph/resources';
import { getBundledCodeGraphDir } from '@canopy/execution-engine/pipelines/config-paths';

/**
 * Points the engine's default `resourcesDir` at the desktop and CLI bundled
 * resources. Every desktop process that runs the engine (Electron main, the
 * code-graph utility processes, the CLI) calls this once at startup.
 */
export function installDesktopCodeGraphResources(): void {
  installCodeGraphResourcesDirResolver(getBundledCodeGraphDir);
}
