type TestContext = { baseUrl: string; apiKey: string };
const mockEnabled = jest.fn<boolean, []>();
const mockContext = jest.fn<Promise<TestContext>, []>();
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockEnabled } => ({
    isEnabled: mockEnabled,
  }),
}));
jest.mock('../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError,
    resolveCanopyCloudCredentialContext: (): Promise<TestContext> =>
      mockContext(),
  };
});
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => 'https://app.example.test',
}));
import { loadCloudReleaseNotes } from '../canopy-cloud/release-notes';
import { CanopyCloudClientError } from '../canopy-cloud/client';
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const originalFetch = globalThis.fetch;
const entries = [
  {
    version: '1.9.0',
    releasedOn: '2026-01-01',
    highlights: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
  },
];
const context = {
  baseUrl: 'https://app.example.test',
  apiKey: 'fixture-secret',
};
beforeEach(() => {
  mockEnabled.mockReset().mockReturnValue(true);
  mockContext.mockReset().mockResolvedValue(context);
  mockFetch
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ schemaVersion: 1, entries })),
    );
  globalThis.fetch = mockFetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
it('denies a direct IPC-backed read while off without looking up credentials', async () => {
  mockEnabled.mockReturnValue(false);
  expect(await loadCloudReleaseNotes('1.9.0')).toEqual([]);
  expect(mockContext).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});
it.each([null, {}, '1.9.0-rc.1', 'internal-1', 'https://evil.test', 'garbage'])(
  'rejects invalid or nonstable versions: %p',
  async (value) => {
    expect(await loadCloudReleaseNotes(value)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
it('authenticates only to the configured origin and retains bounded nonredirecting reads', async () => {
  expect(await loadCloudReleaseNotes('1.9.0')).toEqual(entries);
  expect(mockFetch).toHaveBeenCalledWith(
    'https://app.example.test/api/v1/release-notes?version=1.9.0',
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer fixture-secret',
      },
    }),
  );
});
it('allows the server to evaluate an unsigned viewer when there is no local account', async () => {
  mockContext.mockRejectedValue(
    new CanopyCloudClientError('missing-api-key', 'not connected'),
  );
  expect(await loadCloudReleaseNotes('1.9.0')).toEqual(entries);
  expect(mockFetch.mock.calls[0]?.[1]?.headers).toEqual({
    Accept: 'application/json',
  });
});
it('discards data when the account changes during the request', async () => {
  mockContext
    .mockResolvedValueOnce(context)
    .mockResolvedValue({ ...context, apiKey: 'another-account' });
  expect(await loadCloudReleaseNotes('1.9.0')).toBeNull();
});
it('discards data when rollout is disabled during the request', async () => {
  mockFetch.mockImplementation(() => {
    mockEnabled.mockReturnValue(false);
    return Promise.resolve(Response.json({ schemaVersion: 1, entries }));
  });
  expect(await loadCloudReleaseNotes('1.9.0')).toBeNull();
});
it('fails closed on a refused server read or malformed response', async () => {
  mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
  expect(await loadCloudReleaseNotes('1.9.0')).toBeNull();
  mockFetch.mockResolvedValueOnce(
    Response.json({ schemaVersion: 99, entries }),
  );
  expect(await loadCloudReleaseNotes('1.9.0')).toBeNull();
});
