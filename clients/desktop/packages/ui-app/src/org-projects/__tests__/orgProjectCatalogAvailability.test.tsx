/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { WorkspaceContextOrganizationRole } from '@canopy/protocol/workspace-context';
import {
  isOrgProjectCatalogKnownEmpty,
  shouldWithholdOrgProjectCatalog,
  useOrgProjectCatalogWithheld,
  type OrgProjectCatalogWithholdingInput,
} from '../orgProjectCatalogAvailability';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ORG = 'org-a';

function project(
  id: string,
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    id,
    organizationId: ORG,
    name: id,
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: `${id}-repo`,
      providerRepoId: id,
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: false,
    preference: 'FOLLOW_DEFAULTS',
    listed: false,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
    ...overrides,
  };
}

describe('isOrgProjectCatalogKnownEmpty', () => {
  const current = {
    organizationId: ORG,
    stale: false,
    unauthorized: false,
    loadFailed: false,
  };

  it('is empty only for a current read with nothing addable', () => {
    expect(isOrgProjectCatalogKnownEmpty({ ...current, projects: [] })).toBe(
      true,
    );
    expect(
      isOrgProjectCatalogKnownEmpty({
        ...current,
        projects: [
          project('archived', { state: 'ARCHIVED' }),
          project('chats', { purpose: 'default-chats' }),
          project('no-use', {
            capabilities: { use: false, administer: false, manageCloud: false },
          }),
          project('other-org', { organizationId: 'org-b' }),
        ],
      }),
    ).toBe(true);
  });

  it('is not empty with an addable project, whatever this device has', () => {
    // No added ids are an input: a project already here still counts.
    expect(
      isOrgProjectCatalogKnownEmpty({
        ...current,
        projects: [project('payments', { listed: true })],
      }),
    ).toBe(false);
  });

  it.each([
    ['unresolved', { projects: undefined }],
    ['stale', { projects: [], stale: true }],
    ['unauthorized', { projects: [], unauthorized: true }],
    ['failed', { projects: [], loadFailed: true }],
  ])('never establishes emptiness from %s data', (_label, overrides) => {
    expect(isOrgProjectCatalogKnownEmpty({ ...current, ...overrides })).toBe(
      false,
    );
  });
});

describe('shouldWithholdOrgProjectCatalog', () => {
  it.each<
    [WorkspaceContextOrganizationRole | undefined, boolean, boolean, boolean]
  >([
    ['MEMBER', true, true, true],
    ['MEMBER', true, false, false],
    ['MEMBER', false, true, false],
    ['ADMIN', true, true, false],
    ['OWNER', true, true, false],
    [undefined, true, true, false],
  ])(
    'role %s, empty %s, alternatives %s withholds: %s',
    (role, knownEmpty, otherOptionsAvailable, expected) => {
      expect(
        shouldWithholdOrgProjectCatalog({
          role,
          knownEmpty,
          otherOptionsAvailable,
        }),
      ).toBe(expected);
    },
  );
});

describe('useOrgProjectCatalogWithheld', () => {
  let container: HTMLDivElement;
  let root: Root;
  let withheld: boolean | null = null;

  function Probe(props: OrgProjectCatalogWithholdingInput): null {
    withheld = useOrgProjectCatalogWithheld(props);
    return null;
  }

  const member: OrgProjectCatalogWithholdingInput = {
    sessionKey: 'open-1:org-a:0',
    knownEmpty: true,
    role: 'MEMBER',
    otherOptionsAvailable: true,
  };

  function render(input: Partial<OrgProjectCatalogWithholdingInput>): boolean {
    act(() => root.render(<Probe {...member} {...input} />));
    if (withheld === null) throw new Error('not rendered');
    return withheld;
  }

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    withheld = null;
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('keeps a withheld tile withheld when a refresh adds projects', () => {
    expect(render({})).toBe(true);
    expect(render({ knownEmpty: false })).toBe(true);
  });

  it('starts over on close, reopen, and a new organization or account', () => {
    expect(render({})).toBe(true);
    expect(render({ sessionKey: null, knownEmpty: false })).toBe(false);
    expect(render({ sessionKey: 'open-2:org-a:0', knownEmpty: false })).toBe(
      false,
    );
    expect(render({ sessionKey: 'open-2:org-a:0' })).toBe(true);
    expect(render({ sessionKey: 'open-2:org-b:0', knownEmpty: false })).toBe(
      false,
    );
    expect(render({ sessionKey: 'open-2:org-b:1' })).toBe(true);
    expect(render({ sessionKey: 'open-2:org-b:2', knownEmpty: false })).toBe(
      false,
    );
  });

  it('clears when the role is no longer a known member', () => {
    expect(render({})).toBe(true);
    expect(render({ role: undefined, knownEmpty: false })).toBe(false);
    expect(render({ role: 'MEMBER', knownEmpty: false })).toBe(false);
    expect(render({})).toBe(true);
    expect(render({ role: 'ADMIN' })).toBe(false);
  });

  it('clears when no other option remains, and reapplies when one returns', () => {
    expect(render({})).toBe(true);
    expect(render({ otherOptionsAvailable: false })).toBe(false);
    expect(render({ otherOptionsAvailable: true })).toBe(true);
    expect(render({ otherOptionsAvailable: false, knownEmpty: false })).toBe(
      false,
    );
    expect(render({ otherOptionsAvailable: true, knownEmpty: false })).toBe(
      false,
    );
  });

  it('never withholds a catalog that was not known empty', () => {
    expect(render({ knownEmpty: false })).toBe(false);
  });
});
