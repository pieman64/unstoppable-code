import {
  processCodexMcpLauncherIo,
  runCodexMcpStdioLauncher as runLauncher,
} from '@canopy/core-platform/codex-mcp-launcher';

/** The CLI's hidden launcher (until CAN-4117 PR2): ids from argv[3] and argv[4]. */
export function runCodexMcpStdioLauncher(): Promise<number> {
  return runLauncher(
    { capabilityId: process.argv[3] ?? '', routeId: process.argv[4] ?? '' },
    processCodexMcpLauncherIo(),
  );
}
