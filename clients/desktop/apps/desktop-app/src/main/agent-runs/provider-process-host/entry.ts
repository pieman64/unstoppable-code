import { connectExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';
import { serveProviderProcessHost } from './host';

const channel = connectExecutionHostChannel();
if (channel) serveProviderProcessHost(channel);
