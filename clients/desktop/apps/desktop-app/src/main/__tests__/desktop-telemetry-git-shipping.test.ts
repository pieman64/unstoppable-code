import {
  isDesktopPostHogOperationCaptureEnabled,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import { recordPostHogShippingMilestone } from '../lib/anonymous-id';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  recordGitCommitTelemetry,
  recordPullRequestOpenedTelemetry,
  recordPullRequestMergedTelemetry,
} from '../lib/desktop-telemetry';

jest.mock('../lib/anonymous-id', () => ({
  recordPostHogShippingMilestone: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));
jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn((seed: string) => seed),
}));
jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  isDesktopPostHogOperationCaptureEnabled: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
let clock = Date.now();
const input = {
  projectId: 'secret-project-fixture',
  flow: 'commit' as const,
  repoCount: 2,
};
beforeEach(() => {
  jest.clearAllMocks();
  clock += 60000;
  jest.spyOn(Date, 'now').mockReturnValue(clock);
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(true);
  jest.mocked(recordPostHogShippingMilestone).mockResolvedValue(true);
  jest.mocked(readAllSidebarItems).mockResolvedValue({ version: 1, items: [] });
});

it.each([
  [recordGitCommitTelemetry, 'canopy.git_commit', 'commit'],
  [
    recordPullRequestOpenedTelemetry,
    'canopy.pull_request_open',
    'pull_request',
  ],
  [recordPullRequestMergedTelemetry, 'canopy.pull_request_merge', 'merge'],
] as const)(
  'records confirmed outcomes without internal identity (%s)',
  async (record, name, kind) => {
    record({ ...input, source: 'chat' });
    await flush();
    expect(recordPostHogShippingMilestone).toHaveBeenCalledWith(kind);
    expect(startDesktopOperation).toHaveBeenCalledTimes(1);
    expect(succeedDesktopOperation).toHaveBeenCalledTimes(1);
    const call: unknown = jest.mocked(succeedDesktopOperation).mock.calls[0];
    const opaqueKey: unknown = expect.any(String);
    expect(call).toEqual([
      name,
      {
        operationKey: opaqueKey,
        context: {
          source: 'chat',
          flow: 'commit',
          repo_count: 2,
          workspace_type: 'unknown',
          is_install_first: true,
        },
      },
    ]);
    expect(jest.mocked(startDesktopOperation).mock.calls[0]).toEqual(call);
    expect(JSON.stringify(call)).not.toContain(input.projectId);
    expect(
      JSON.stringify(
        jest.mocked(createDesktopInstrumentationOperationKey).mock.calls,
      ),
    ).not.toContain(input.projectId);
  },
);

it('gives same-tick outcomes distinct opaque keys and defaults invalid attribution to manual', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1);
  try {
    recordGitCommitTelemetry(input);
    recordGitCommitTelemetry({ ...input, source: 'private-invalid-source' });
    await flush();
    const calls = jest.mocked(succeedDesktopOperation).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.operationKey).not.toBe(calls[1][1]?.operationKey);
    for (const [, options] of calls)
      expect(options?.context?.source).toBe('manual');
  } finally {
    jest.restoreAllMocks();
  }
});

it.each([0, -1, 1.5, NaN, Infinity])(
  'rejects invalid repo count %s without claiming',
  async (repoCount) => {
    recordGitCommitTelemetry({ ...input, repoCount });
    await flush();
    expect(recordPostHogShippingMilestone).not.toHaveBeenCalled();
    expect(succeedDesktopOperation).not.toHaveBeenCalled();
  },
);

it('rejects unbounded flows and permits reserved pipeline attribution', async () => {
  recordGitCommitTelemetry({ ...input, flow: 'private-flow' as never });
  await flush();
  expect(recordPostHogShippingMilestone).not.toHaveBeenCalled();
  recordGitCommitTelemetry({ ...input, source: 'pipeline' });
  await flush();
  expect(
    jest.mocked(succeedDesktopOperation).mock.calls[0][1]?.context?.source,
  ).toBe('pipeline');
});

it('does not claim or emit when capture is disabled', async () => {
  jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
  recordGitCommitTelemetry(input);
  await flush();
  expect(recordPostHogShippingMilestone).not.toHaveBeenCalled();
  expect(succeedDesktopOperation).not.toHaveBeenCalled();
});

it('projects only workspace type from local metadata', async () => {
  jest.mocked(readAllSidebarItems).mockResolvedValue({
    version: 1,
    items: [
      {
        id: input.projectId,
        name: 'secret-workspace',
        type: 'single-repo',
        repoPath: '/secret/repo',
        color: 'red',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
    ],
  });
  recordGitCommitTelemetry(input);
  await flush();
  expect(
    jest.mocked(succeedDesktopOperation).mock.calls[0][1]?.context,
  ).toEqual({
    source: 'manual',
    flow: 'commit',
    repo_count: 2,
    workspace_type: 'single-repo',
    is_install_first: true,
  });
});

it('uses unknown workspace type on lookup failure and keeps recording', async () => {
  jest.mocked(readAllSidebarItems).mockRejectedValue(new Error('private-path'));
  recordGitCommitTelemetry(input);
  await flush();
  expect(
    jest.mocked(succeedDesktopOperation).mock.calls[0][1]?.context
      ?.workspace_type,
  ).toBe('unknown');
});

it('rechecks consent after the workspace lookup before claiming', async () => {
  jest.mocked(readAllSidebarItems).mockImplementationOnce(() => {
    jest.mocked(isDesktopPostHogOperationCaptureEnabled).mockReturnValue(false);
    return Promise.resolve({ version: 1, items: [] });
  });
  recordGitCommitTelemetry(input);
  await flush();
  expect(recordPostHogShippingMilestone).not.toHaveBeenCalled();
  expect(succeedDesktopOperation).not.toHaveBeenCalled();
});

it('omits only the first flag when metadata is unavailable', async () => {
  jest
    .mocked(recordPostHogShippingMilestone)
    .mockRejectedValue(new Error('secret-path'));
  recordGitCommitTelemetry(input);
  await flush();
  expect(
    jest.mocked(succeedDesktopOperation).mock.calls[0][1]?.context,
  ).toEqual({
    source: 'manual',
    flow: 'commit',
    repo_count: 2,
    workspace_type: 'unknown',
  });
});

it('isolates scheduler, gate and capture exceptions from the caller', async () => {
  const scheduling = jest
    .spyOn(global, 'setImmediate')
    .mockImplementationOnce(() => {
      throw new Error('scheduler');
    });
  expect(() => recordGitCommitTelemetry(input)).not.toThrow();
  scheduling.mockRestore();
  jest
    .mocked(isDesktopPostHogOperationCaptureEnabled)
    .mockImplementationOnce(() => {
      throw new Error('gate');
    });
  expect(() => recordGitCommitTelemetry(input)).not.toThrow();
  await flush();
  jest.mocked(startDesktopOperation).mockImplementationOnce(() => {
    throw new Error('capture');
  });
  expect(() => recordGitCommitTelemetry(input)).not.toThrow();
  await flush();
});
