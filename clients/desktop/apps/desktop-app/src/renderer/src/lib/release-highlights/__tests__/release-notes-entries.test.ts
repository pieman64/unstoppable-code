/** @jest-environment jsdom */
const mockRead = jest.fn();
import { loadDesktopReleaseNotesEntries } from '../release-notes-entries';

beforeEach(() => {
  mockRead.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCloudReleaseNotes: mockRead,
      update: {
        getAppVersion: (): Promise<string> => Promise.resolve('v1.9.0'),
      },
    },
  });
});
afterEach(() => Reflect.deleteProperty(window, 'api'));

it('requests the installed stable version even when it is outside the newest history page', async () => {
  await loadDesktopReleaseNotesEntries();
  expect(mockRead).toHaveBeenCalledWith('1.9.0');
  await loadDesktopReleaseNotesEntries('1.8.0');
  expect(mockRead).toHaveBeenLastCalledWith('1.8.0');
});
it.each(['1.9.0-rc.1', 'internal-123', 'invalid'])(
  'does not request history for %s',
  async (version) => {
    expect(await loadDesktopReleaseNotesEntries(version)).toEqual([]);
    expect(mockRead).not.toHaveBeenCalled();
  },
);
