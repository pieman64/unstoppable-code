import { describeLoadError, summarizeLoadErrors } from '../summarizeLoadErrors';

const NOT_CONFIGURED = 'Canopy Cloud base URL is not configured.';
const IPC_NOT_CONFIGURED = (channel: string): string =>
  `Error invoking remote method '${channel}': CanopyCloudClientError: ${NOT_CONFIGURED}`;

describe('describeLoadError', () => {
  it('strips the IPC wrapper and error class name', () => {
    expect(
      describeLoadError(
        "Error invoking remote method 'skills:list': TypeError: Disk full",
      ),
    ).toBe('Disk full.');
  });

  it('says a missing Cloud configuration in plain words', () => {
    expect(describeLoadError(IPC_NOT_CONFIGURED('skills:shared-list'))).toMatch(
      /Cloud isn't set up in this build\.$/,
    );
  });
});

describe('summarizeLoadErrors', () => {
  it('returns nothing without errors', () => {
    expect(summarizeLoadErrors([])).toBeNull();
  });

  it('names every source that failed for one reason in a single sentence', () => {
    const summary = summarizeLoadErrors([
      { source: 'Shared pipelines', message: NOT_CONFIGURED },
      {
        source: 'Shared skills',
        message: IPC_NOT_CONFIGURED('skills:shared-list'),
      },
      {
        source: 'Shared collections',
        message: IPC_NOT_CONFIGURED('collections:shared-list'),
      },
      {
        source: 'Shared automations',
        message: IPC_NOT_CONFIGURED('automations:shared:list'),
      },
      {
        source: 'Shared agents',
        message: IPC_NOT_CONFIGURED('agents:shared:list'),
      },
      { source: 'Shared plugins', message: NOT_CONFIGURED },
    ]);
    expect(summary?.title).toBe(
      "Couldn't load shared pipelines, skills, collections, automations, agents, and plugins.",
    );
    expect(summary?.message).toMatch(/Cloud isn't set up in this build\.$/);
    expect(summary?.message).not.toMatch(/invoking|ClientError|base URL/);
  });

  it('groups sources by reason when the reasons differ', () => {
    const summary = summarizeLoadErrors([
      { source: 'Shared skills', message: NOT_CONFIGURED },
      { source: 'Shared collections', message: NOT_CONFIGURED },
      { source: 'MCP servers', message: 'Error: Permission denied' },
    ]);
    expect(summary?.title).toBe(
      "Couldn't load shared skills, shared collections, and MCP servers.",
    );
    expect(summary?.message).toMatch(
      /^Shared skills and collections: .*Cloud isn't set up in this build\. MCP servers: Permission denied\.$/,
    );
  });
});
