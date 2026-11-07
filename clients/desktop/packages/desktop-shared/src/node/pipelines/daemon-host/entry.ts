import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { servePipelineHost } from './server';

// The daemon's pipeline host (CAN-5086): desktop-shared's executor in its own
// owned process tree, so a step that crashes Node ends only this host.

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
const os = hostOperatingSystem();
if (os !== 'darwin' && os !== 'linux')
  throw new Error('Daemon pipelines run on macOS and Linux only.');
const { supervision } = hostPlatformServices(
  createPlatformEndpointServices(os),
  {},
);
servePipelineHost({
  channel,
  inspectProcess: async (pid) => {
    const found = await supervision.inspectProcess({ pid });
    return found.state === 'running'
      ? { state: 'running', startIdentity: found.startIdentity }
      : { state: found.state };
  },
});
