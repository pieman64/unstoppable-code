import { installDesktopCodeGraphResources } from '@canopy/desktop-shared/node/code-graph/resources';
import { connectExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';
import { serveCodeGraphReads } from '@canopy/code-graph/host/read-host';

export * from '@canopy/code-graph/host/read-host';

const channel = connectExecutionHostChannel();
if (channel) {
  installDesktopCodeGraphResources();
  serveCodeGraphReads(channel);
}
