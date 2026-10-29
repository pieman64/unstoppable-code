import { codexMarketplaceRootFromPath } from '../plugins/codex-marketplace-paths';

describe('codexMarketplaceRootFromPath', () => {
  it.each([
    ['/repo/.agents/plugins/marketplace.json', '/repo'],
    // Signed out, Codex lists the curated catalog from this sibling manifest.
    [
      '/codex/.tmp/plugins/.agents/plugins/api_marketplace.json',
      '/codex/.tmp/plugins',
    ],
    ['/repo/.claude-plugin/marketplace.json', '/repo'],
    ['/repo/.claude-plugin/other.json', '/repo'],
    // A `plugins` directory only marks the layout under `.agents`.
    ['/repo/plugins/marketplace.json', '/repo/plugins'],
    ['/repo/catalog/marketplace.json', '/repo/catalog'],
    ['/repo/.agents/plugins/../plugins/marketplace.json', '/repo'],
  ])('derives the checkout root of %s', (manifestPath, expectedRoot) => {
    expect(codexMarketplaceRootFromPath(manifestPath)).toBe(expectedRoot);
  });

  it.each([null, undefined, ''])('returns null for %p', (manifestPath) => {
    expect(codexMarketplaceRootFromPath(manifestPath)).toBeNull();
  });
});
