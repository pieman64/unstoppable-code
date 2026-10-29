const hasGraphMock = jest.fn(() => false);

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    hasGraph: hasGraphMock,
  }),
}));

const isCoworkWorkspaceMock = jest.fn<boolean, [string]>(() => false);

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean => isCoworkWorkspaceMock(id),
}));

const isCodeGraphAvailableForWorkspaceMock = jest.fn<boolean, [string]>(
  () => true,
);

jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (workspaceId: string): boolean =>
    isCodeGraphAvailableForWorkspaceMock(workspaceId),
}));

import { buildCodeGraphAvailabilityPrompt } from '../lib/code-graph-availability-prompt';

describe('buildCodeGraphAvailabilityPrompt', () => {
  beforeEach(() => {
    hasGraphMock.mockReset();
    hasGraphMock.mockReturnValue(false);
    isCoworkWorkspaceMock.mockReset();
    isCoworkWorkspaceMock.mockReturnValue(false);
    isCodeGraphAvailableForWorkspaceMock.mockReset();
    isCodeGraphAvailableForWorkspaceMock.mockReturnValue(true);
  });

  it('returns a one-line nudge mentioning GetCodeGraphContext when a graph exists', () => {
    hasGraphMock.mockReturnValue(true);

    const prompt = buildCodeGraphAvailabilityPrompt('proj-1', 'wt-1');

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('GetCodeGraphContext');
    expect(prompt).toContain('QueryCodeGraph or SearchCodeGraph');
    expect(prompt).toContain('including in subagents');
    expect(prompt?.includes('\n')).toBe(false);
    expect(hasGraphMock).toHaveBeenCalledWith('proj-1', 'wt-1');
  });

  it('returns undefined when no graph has been built yet', () => {
    hasGraphMock.mockReturnValue(false);

    const prompt = buildCodeGraphAvailabilityPrompt('proj-1', 'wt-1');

    expect(prompt).toBeUndefined();
    expect(hasGraphMock).toHaveBeenCalledWith('proj-1', 'wt-1');
  });

  it('returns undefined when code graphs are disabled for the project', () => {
    isCodeGraphAvailableForWorkspaceMock.mockReturnValue(false);
    hasGraphMock.mockReturnValue(true);

    const prompt = buildCodeGraphAvailabilityPrompt('proj-1', 'wt-1', {
      liveAvailable: true,
      toolsAdvertised: true,
    });

    expect(prompt).toBeUndefined();
    expect(isCodeGraphAvailableForWorkspaceMock).toHaveBeenCalledWith('proj-1');
    expect(hasGraphMock).not.toHaveBeenCalled();
  });

  it('returns undefined for cowork projects without calling hasGraph', () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    hasGraphMock.mockReturnValue(true);

    const prompt = buildCodeGraphAvailabilityPrompt('standalone-chat', 'home');

    expect(prompt).toBeUndefined();
    expect(hasGraphMock).not.toHaveBeenCalled();
  });
});
