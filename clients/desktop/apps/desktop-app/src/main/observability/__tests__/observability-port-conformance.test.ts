// CAN-5096: chat turns, subagents, helpers, transcripts and usage events
// write through the agent ingest port, which the one desktop service
// satisfies with no change, so observability:load-history,
// observability:load-transcript and observability:load-usage-metrics read the
// same records.
import type { DesktopExecutionObservabilityIngest } from '../ingest';
import type { ObservabilityService } from '../service';
import { getExecutionObservabilityIngest } from '../ingest';

jest.mock(
  '../index',
  (): {
    getObservabilityService: () => object;
    __service: object;
  } => {
    const service = { id: 'service' };
    return { getObservabilityService: () => service, __service: service };
  },
);

describe('agent observability ingest port', () => {
  it('the desktop service satisfies the agent ingest port', () => {
    const asPort = (
      service: ObservabilityService,
    ): DesktopExecutionObservabilityIngest => service;
    expect(typeof asPort).toBe('function');
  });

  it('the port is the one service instance', () => {
    expect(getExecutionObservabilityIngest()).toBe(
      jest.requireMock<{ __service: object }>('../index').__service,
    );
  });
});
