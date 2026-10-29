const mockService = {
  ensureStarted: jest.fn(),
  shutdown: jest.fn(),
};

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => mockService),
}));

import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { getDesktopIntegrationServer } from '../integration/desktop-integration-server';

describe('desktop-integration-server', () => {
  it('uses the consolidated MCP HTTP proxy service as the desktop integration server', () => {
    expect(getDesktopIntegrationServer()).toBe(mockService);
    expect(getMcpHttpProxyService).toHaveBeenCalledTimes(1);
  });
});
