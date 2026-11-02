const mockRead = jest.fn();
const mockRequest = jest.fn();
jest.mock('../collection-store', () => ({
  get readCollectionConfig(): typeof mockRead {
    return mockRead;
  },
}));
jest.mock('../../canopy-cloud/client', () => ({
  get requestCanopyCloudJson(): typeof mockRequest {
    return mockRequest;
  },
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => false,
}));
import {
  createSharedCollection,
  updateSharedCollection,
} from '../canopy-server-client';

describe('collection sharing source guard with Teams disabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockResolvedValue({
      collection: { mcpServers: [{ serverId: 'linear', configId: 'private' }] },
    });
  });
  it.each(['create', 'update'])(
    'rejects an MCP-backed source before %s reaches the server',
    async (operation) => {
      const request = {
        sourceCollectionId: 'local',
        rawCollection: '{}',
        shareScope: 'private' as const,
      };
      const result =
        operation === 'create'
          ? createSharedCollection(request)
          : updateSharedCollection({ ...request, collectionId: 'remote' });
      await expect(result).rejects.toThrow(
        'Collections containing MCP servers cannot be shared.',
      );
      // Classified, so the share envelope keeps this sentence instead of
      // replacing it with the generic non-Cloud failure copy.
      await expect(result).rejects.toMatchObject({
        name: 'ShareOperationError',
        kind: 'unavailable',
      });
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );
});
