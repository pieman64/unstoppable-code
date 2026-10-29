import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import { readWorkspaceScriptCommands } from '../workspace-script-config';
import { readWorkspaceConfig } from '../workspace-persistence';

jest.mock('../workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<WorkspaceConfigFile>, [string]>();
  return { readWorkspaceConfig };
});

const mockedRead = jest.mocked(readWorkspaceConfig);

function config(scripts: WorkspaceConfigFile['scripts']): WorkspaceConfigFile {
  return { version: 1, type: 'single-repo', repos: [], scripts };
}

describe('readWorkspaceScriptCommands', () => {
  beforeEach(() => jest.clearAllMocks());

  it('flattens string + ScriptDefinition entries to commands and drops null tombstones', async () => {
    mockedRead.mockResolvedValue(
      config({
        setup: 'npm ci',
        launch: { command: 'npm run dev', timeoutSeconds: 60 },
        teardown: null,
      }),
    );
    await expect(readWorkspaceScriptCommands('ws-1')).resolves.toEqual({
      setup: 'npm ci',
      launch: 'npm run dev',
    });
  });
});
