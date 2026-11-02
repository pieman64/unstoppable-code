import { normalizePreferences } from '../lib/preferences-store';
it('keeps Personal catalog enrollment off until affirmative consent', (): void => {
  const defaults = normalizePreferences({});
  expect(defaults.personalWorkspaceCatalogSync).toBe('off');
  for (const value of ['private', 'off', 'organization', true, undefined]) {
    const normalized = normalizePreferences({
      personalWorkspaceCatalogSync: value,
    });
    expect(normalized.personalWorkspaceCatalogSync).toBe(
      value === 'private' ? 'private' : 'off',
    );
  }
});
