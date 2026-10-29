import * as protocol from '../index';

/**
 * Rail 1 — no canonical share prefix may claim the `/s/*` segment.
 *
 * CAN-2232 ceded `/s/*` at the `unstoppable.ai` apex to the e-commerce
 * storefront, which serves site search there. CAN-2293 then minted
 * `PIPELINE_SHARE_PATH_PREFIX = '/s/pipelines'` — a brand-new canonical share
 * surface on a segment Canopy no longer owns — and nothing in CI objected: the
 * owned-routes drift check only reads the `app/` tree, and the path was claimed
 * by a `next.config.ts` rewrite rather than by a route.
 *
 * This test closes that hole from the protocol side, deliberately. Root
 * `jest.config.js` `roots` includes `<rootDir>/packages`, so it runs under
 * `npm test` and fires for an agent editing only `packages/protocol` — the exact
 * path CAN-2293 took.
 *
 * The scan is name-driven so future prefixes are covered with no edit here.
 *
 * See `docs/web-reserved-paths.md`.
 */
const DOC_POINTER =
  'See docs/web-reserved-paths.md — `/s/*` is storefront-owned; a new share surface belongs under `/share/*`.';

interface SharePrefixExport {
  name: string;
  value: string;
}

function collectSharePathPrefixes(): SharePrefixExport[] {
  const collected: SharePrefixExport[] = [];
  for (const [name, value] of Object.entries(protocol)) {
    if (!/_SHARE_PATH_PREFIX$/.test(name)) {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    collected.push({ name, value });
  }
  return collected;
}

const SHARE_PATH_PREFIXES = collectSharePathPrefixes();

describe('share path prefixes', () => {
  it('enumerates exactly the known share prefixes', () => {
    // Anti-vacuous guard: without this, a rename of the export suffix would
    // make every assertion below pass by scanning nothing at all.
    //
    // Pins the NAMES rather than a non-zero count. A count guard only catches
    // total evaporation — renaming ONE constant off the `_SHARE_PATH_PREFIX`
    // convention drops it from the scan while the survivors keep the count
    // above zero, which is precisely how a new prefix would slip the rule.
    //
    // Adding a share prefix is expected to fail this line, and should: the
    // author updates it here and in the matching `apps/web` proxy rail, which
    // is step 3 of the checklist in docs/web-reserved-paths.md.
    expect(SHARE_PATH_PREFIXES.map(({ name }) => name).sort()).toEqual([
      'AGENT_SHARE_PATH_PREFIX',
      'AUTOMATION_SHARE_PATH_PREFIX',
      'COLLECTION_SHARE_PATH_PREFIX',
      'DIGEST_SHARE_PATH_PREFIX',
      'LEGACY_BLUEPRINT_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_AGENT_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_AUTOMATION_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_COLLECTION_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_PIPELINE_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_PLUGIN_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_SKILL_SHARE_PATH_PREFIX',
      'LEGACY_PUBLIC_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX',
      'LEGACY_SKILL_SHARE_PATH_PREFIX',
      'LEGACY_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX',
      'PIPELINE_SHARE_PATH_PREFIX',
      'PLUGIN_SHARE_PATH_PREFIX',
      'SKILL_SHARE_PATH_PREFIX',
      'WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX',
    ]);
  });

  it('exports every share path prefix as an absolute path', () => {
    const violations = SHARE_PATH_PREFIXES.filter(
      ({ value }) => !value.startsWith('/'),
    ).map(({ name, value }) => `${name} = '${value}'`);

    expect(violations).toEqual([]);
  });

  it('never mints a canonical share prefix under the storefront-owned /s segment', () => {
    // First-segment comparison, NOT `startsWith('/s')` — `/share/...` also
    // starts with `/s` and is the correct destination, so a prefix match would
    // reject exactly the shape this rule is steering toward.
    const violations = SHARE_PATH_PREFIXES.filter(
      ({ name, value }) =>
        !name.includes('LEGACY') && value.split('/')[1] === 's',
    ).map(({ name, value }) => `${name} = '${value}'`);

    expect({ violations, rule: DOC_POINTER }).toEqual({
      violations: [],
      rule: DOC_POINTER,
    });
  });
});
