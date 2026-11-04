import {
  combinedCodeGraphBuildState,
  isDaemonCodeGraphRouteEligible,
  type DaemonCodeGraphRouteInput,
} from '../daemon-code-graph-route';

const ELIGIBLE: DaemonCodeGraphRouteInput = {
  platform: 'darwin',
  experimentEnabled: true,
  context: { localWindow: true },
  daemonLatched: false,
};

describe('daemon code-graph route eligibility (CAN-5089)', () => {
  it('routes a request from a local window on macOS and Linux', () => {
    expect(isDaemonCodeGraphRouteEligible(ELIGIBLE)).toBe(true);
    expect(
      isDaemonCodeGraphRouteEligible({ ...ELIGIBLE, platform: 'linux' }),
    ).toBe(true);
  });

  it.each<[string, Partial<DaemonCodeGraphRouteInput>]>([
    ['the experiment is off', { experimentEnabled: false }],
    ['the host is Windows (CAN-5091)', { platform: 'win32' }],
    ['the host is unknown', { platform: null }],
    ['the remote-control bridge sent it', { context: { localWindow: false } }],
    [
      'it is not a renderer request (Portal, agents and every other caller)',
      { context: undefined },
    ],
    ['the daemon is latched unreachable', { daemonLatched: true }],
  ])('keeps the request in process when %s', (_reason, change) => {
    expect(isDaemonCodeGraphRouteEligible({ ...ELIGIBLE, ...change })).toBe(
      false,
    );
  });
});

describe('combined build state', () => {
  it('reports the busier of the two hosts', () => {
    expect(combinedCodeGraphBuildState('idle', 'idle')).toBe('idle');
    expect(combinedCodeGraphBuildState('idle', 'queued')).toBe('queued');
    expect(combinedCodeGraphBuildState('running', 'queued')).toBe('running');
    expect(combinedCodeGraphBuildState('queued', 'running')).toBe('running');
  });
});
