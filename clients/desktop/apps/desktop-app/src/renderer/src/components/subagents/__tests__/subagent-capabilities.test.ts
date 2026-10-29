import { subagentViewerCapabilitiesFrom } from '../subagent-capabilities';
import { createDesktopCapabilities } from '@/client/ipc-canopy-client';

describe('subagent viewer capabilities', () => {
  it('enables workflow viewing and stopping on desktop', () => {
    expect(
      subagentViewerCapabilitiesFrom(createDesktopCapabilities('darwin')),
    ).toEqual({
      stop: true,
      messaging: true,
      worktreeDetails: true,
      nativeInterrupt: true,
      openWorkflow: true,
      stopWorkflow: true,
    });
  });
});
