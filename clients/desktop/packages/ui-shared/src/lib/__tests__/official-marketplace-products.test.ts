import { MCP_BRAND_LOGOS } from '../mcp-brand-logos';
import {
  OFFICIAL_MARKETPLACE_PRODUCT_NAMES,
  OPENAI_PLUGIN_MARKETPLACE_ID,
  officialProductLogoKey,
  officialProductVendor,
  pluginDisplayAuthor,
} from '../official-marketplace-products';

const OFFICIAL = OPENAI_PLUGIN_MARKETPLACE_ID;

describe('officialProductLogoKey', () => {
  it('resolves the whole Microsoft 365 family to one product mark', () => {
    // `outlook-calendar` was mapped and its siblings were not, so Outlook
    // Email, SharePoint and Teams sat on a monogram beside a marked sibling.
    expect(
      ['outlook-calendar', 'outlook-email', 'sharepoint', 'teams'].map((name) =>
        officialProductLogoKey(OFFICIAL, { name }),
      ),
    ).toEqual([
      'microsoft-365',
      'microsoft-365',
      'microsoft-365',
      'microsoft-365',
    ]);
  });

  it('only names keys the app actually ships a mark for', () => {
    // A typo here degrades silently to a monogram rather than failing, so the
    // table is checked against the asset map. Iterating the table itself, not
    // a copy of it, is what lets this catch an entry added later.
    const unresolved = OFFICIAL_MARKETPLACE_PRODUCT_NAMES.filter((name) => {
      const key = officialProductLogoKey(OFFICIAL, { name });
      // An entry may credit a vendor without shipping a mark; only a key that
      // is present has to resolve.
      return key !== undefined && MCP_BRAND_LOGOS[key] === undefined;
    });

    expect(OFFICIAL_MARKETPLACE_PRODUCT_NAMES.length).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });

  it('refuses to identify products outside the official feed', () => {
    // The impersonation guard: a plugin merely NAMED `github` is not GitHub.
    expect(
      officialProductLogoKey('community-marketplace', { name: 'github' }),
    ).toBeUndefined();
    expect(
      officialProductLogoKey(undefined, { name: 'github' }),
    ).toBeUndefined();
  });
});

describe('pluginDisplayAuthor', () => {
  it('credits the product vendor when the publisher credited itself', () => {
    expect(
      pluginDisplayAuthor(OFFICIAL, { name: 'teams', author: 'OpenAI' }),
    ).toBe('Microsoft');
    expect(
      pluginDisplayAuthor(OFFICIAL, { name: 'gmail', author: 'OpenAI' }),
    ).toBe('Google');
    // The feed also uses this spelling for the plugins it authors.
    expect(
      pluginDisplayAuthor(OFFICIAL, {
        name: 'sharepoint',
        author: 'OpenAI Codex',
      }),
    ).toBe('Microsoft');
  });

  it("leaves OpenAI's own products credited to OpenAI", () => {
    expect(
      pluginDisplayAuthor(OFFICIAL, {
        name: 'codex-security',
        author: 'OpenAI',
      }),
    ).toBe('OpenAI');
  });

  it("never overwrites a vendor's own claim about itself", () => {
    // More precise than the product name the table carries, so it wins.
    expect(
      pluginDisplayAuthor(OFFICIAL, {
        name: 'linear',
        author: 'Linear Orbit, Inc',
      }),
    ).toBe('Linear Orbit, Inc');
    expect(
      pluginDisplayAuthor(OFFICIAL, {
        name: 'canva',
        author: 'Canva Pty Ltd.',
      }),
    ).toBe('Canva Pty Ltd.');
  });

  it('credits a vendor even when no bundled mark ships for it', () => {
    // Zotero has no mark in the app, but its listing is still OpenAI's wrapper
    // around Zotero's product.
    expect(
      pluginDisplayAuthor(OFFICIAL, { name: 'zotero', author: 'OpenAI' }),
    ).toBe('Zotero');
    expect(
      officialProductLogoKey(OFFICIAL, { name: 'zotero' }),
    ).toBeUndefined();
  });

  it('passes through an unknown product and an absent author', () => {
    expect(
      pluginDisplayAuthor(OFFICIAL, { name: 'game-studio', author: 'OpenAI' }),
    ).toBe('OpenAI');
    expect(pluginDisplayAuthor(OFFICIAL, { name: 'teams' })).toBeUndefined();
  });

  it('identifies only listed products, never inherited object members', () => {
    // The table is a plain object indexed by a feed-supplied name. A listing
    // named `constructor` resolved to `Object`, so anything reachable through
    // its prototype chain — here a polluted `Object.prototype` — became that
    // listing's vendor and mark.
    const pollution = { vendor: 'Polluted', logoKey: 'polluted' };
    // Non-enumerable, so nothing that iterates objects while the test runs —
    // Jest formatting a failure, say — trips over the injected keys.
    for (const [key, value] of Object.entries(pollution)) {
      Object.defineProperty(Object.prototype, key, {
        value,
        configurable: true,
      });
    }
    try {
      expect(
        pluginDisplayAuthor(OFFICIAL, {
          name: 'constructor',
          author: 'OpenAI',
        }),
      ).toBe('OpenAI');
      expect(
        officialProductLogoKey(OFFICIAL, { name: 'constructor' }),
      ).toBeUndefined();
    } finally {
      for (const key of Object.keys(pollution)) {
        Reflect.deleteProperty(Object.prototype, key);
      }
    }
  });

  it('does not lend vendor attribution outside the official feed', () => {
    expect(
      pluginDisplayAuthor('community-marketplace', {
        name: 'teams',
        author: 'OpenAI',
      }),
    ).toBe('OpenAI');
  });
});

describe('officialProductVendor', () => {
  it('reports only the correction, so callers can tell it apart', () => {
    // `undefined` means "keep what the feed said" rather than "no author".
    expect(
      officialProductVendor(OFFICIAL, { name: 'teams', author: 'OpenAI' }),
    ).toBe('Microsoft');
    expect(
      officialProductVendor(OFFICIAL, {
        name: 'linear',
        author: 'Linear Orbit, Inc',
      }),
    ).toBeUndefined();
  });
});
