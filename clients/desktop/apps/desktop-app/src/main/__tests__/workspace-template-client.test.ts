const mockRequest = jest.fn<Promise<{ shares: [] }>, [string]>();
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (url: string): Promise<{ shares: [] }> =>
    mockRequest(url),
  CanopyCloudClientError: class extends Error {},
}));
jest.mock('../canopy-cloud/public-share-client', () => ({
  getPublicWorkspaceTemplateSnapshot: jest.fn(),
}));
jest.mock('../pipelines/canopy-server-client', () => ({
  withPackageVersionNegotiation: jest.fn(),
}));
import { listWorkspaceTemplateShares } from '../canopy-cloud/workspace-template-client';

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ shares: [] });
});
it('forwards the server-derived author facet and search to the template list', async () => {
  await listWorkspaceTemplateShares({ createdBy: 'me', query: 'biology' });
  const url = new URL(mockRequest.mock.calls[0]?.[0] ?? '', 'https://test');
  expect(url.searchParams.get('createdBy')).toBe('me');
  expect(url.searchParams.get('q')).toBe('biology');
});
it('preserves the unfiltered request URL', async () => {
  await listWorkspaceTemplateShares();
  expect(mockRequest.mock.calls[0]?.[0]).not.toContain('?');
});
