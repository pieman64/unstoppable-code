import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { COPILOT_BUILTIN_MCP_SERVERS } from '@canopy/desktop-shared/node/copilot/session-policy';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { buildCopilotMcpServers } from '../copilot/mcp-servers';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

describe('buildCopilotMcpServers', () => {
  const server = { type: 'http', url: 'https://mcp.example' };

  beforeEach(() => {
    jest.mocked(logMainProcessWarn).mockClear();
  });

  it('selects a user server by its configured name', () => {
    expect(
      buildCopilotMcpServers({
        definitions: { selected: server },
        cwd: '/workspace',
      }),
    ).toEqual({
      selected: {
        type: 'http',
        url: 'https://mcp.example',
        headers: {},
        tools: ['*'],
      },
    });
  });

  it.each([
    cursorCanopyMcpServerNames('default').main,
    cursorCanopyMcpServerNames('default').ui,
    cursorCanopyMcpServerNames('app-advisor').main,
  ])('rejects a user server named %s', (name) => {
    expect(() =>
      buildCopilotMcpServers({
        definitions: { [name]: server },
        cwd: '/workspace',
      }),
    ).toThrow(`MCP server ${name} uses a reserved name.`);
  });

  it.each(COPILOT_BUILTIN_MCP_SERVERS)(
    'leaves out a server named %s and keeps the others',
    (name) => {
      expect(
        buildCopilotMcpServers({
          definitions: { [name]: server, selected: server },
          cwd: '/workspace',
        }),
      ).toEqual({
        selected: {
          type: 'http',
          url: 'https://mcp.example',
          headers: {},
          tools: ['*'],
        },
      });
      expect(logMainProcessWarn).toHaveBeenCalledWith(
        '[copilot-mcp-servers]',
        `Skipped MCP server ${name}: Copilot reserves this name for a built-in server.`,
      );
    },
  );

  it.each(COPILOT_BUILTIN_MCP_SERVERS)(
    'ignores a disabled server named %s',
    (name) => {
      expect(
        buildCopilotMcpServers({
          definitions: { [name]: { ...server, enabled: false } },
          cwd: '/workspace',
        }),
      ).toEqual({});
      expect(logMainProcessWarn).not.toHaveBeenCalled();
    },
  );
});
