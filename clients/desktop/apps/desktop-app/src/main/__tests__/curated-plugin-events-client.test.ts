const mockRequestCanopyCloudJson = jest.fn();
const mockRequestCanopyCloudNoContent = jest.fn<
  void,
  [path: string, init: RequestInit]
>();

jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
    Promise.resolve(mockRequestCanopyCloudJson(...args)),
  requestCanopyCloudNoContent: (...args: unknown[]): Promise<void> =>
    Promise.resolve(mockRequestCanopyCloudNoContent(...args)),
}));

import { reportCuratedPluginInstalled } from '../plugins/curated-plugin-events';

describe('curated plugin event client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('posts JSON through the no-content client and accepts a 204 response', async () => {
    const occurredAt = new Date('2026-08-13T10:00:00.000Z');

    await expect(
      reportCuratedPluginInstalled('docs-plugin', occurredAt),
    ).resolves.toBe(true);

    expect(mockRequestCanopyCloudNoContent).toHaveBeenCalledTimes(1);
    const [requestPath, request] =
      mockRequestCanopyCloudNoContent.mock.calls[0];
    expect(requestPath).toMatch(/^\/api\/v1\/[^/]+\/plugins\/curated\/events$/);
    expect(request).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(typeof request.body).toBe('string');
    if (typeof request.body !== 'string') {
      throw new TypeError('Expected a JSON request body');
    }
    expect(JSON.parse(request.body)).toMatchObject({
      curatedPluginKey: 'docs-plugin',
      eventType: 'INSTALLED',
      occurredAt: occurredAt.toISOString(),
    });
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  });
});
