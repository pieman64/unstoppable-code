import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import type {
  ExistingShareFacts,
  ExistingShareOwner,
} from '../deriveExistingShare';
import {
  sharedResourceOrganizationName,
  sharedResourceProvenance,
  sharedWorkspaceTemplateProvenance,
} from '../sharedResourceProvenance';

// The server entry point must never load client components or hooks.
jest.mock('@canopy/ui-shared/components', () => {
  throw new Error('Provenance loaded the component barrel');
});
jest.mock('../ShareResourceDialog', () => {
  throw new Error('Provenance loaded the share dialog');
});
jest.mock('../ShareDialogFrame', () => {
  throw new Error('Provenance loaded the dialog frame');
});

const organizationOwner: ExistingShareOwner = {
  type: 'organization',
  id: 'acme',
  name: ' Acme ',
};
const teamOwner: ExistingShareOwner = {
  type: 'team',
  id: 'platform',
  name: 'Platform',
  organization: { id: 'acme', name: ' Acme ' },
};

describe('sharedResourceOrganizationName', () => {
  it('uses the owning organization, or a team’s parent organization', () => {
    expect(sharedResourceOrganizationName(organizationOwner, null)).toBe(
      'Acme',
    );
    expect(sharedResourceOrganizationName(teamOwner, null)).toBe('Acme');
  });

  it('suppresses Personal structurally, regardless of the organization name', () => {
    expect(
      sharedResourceOrganizationName(organizationOwner, {
        audience: 'organization',
        personal: true,
      }),
    ).toBeNull();
    expect(
      sharedResourceOrganizationName(
        { ...organizationOwner, name: 'Personal' },
        { audience: 'organization' },
      ),
    ).toBe('Personal');
  });

  it.each<ExistingShareOwner | null | undefined>([
    null,
    undefined,
    { type: 'organization', name: null },
    { type: 'organization', name: '' },
    { type: 'organization', name: ' \n\t ' },
    { type: 'team', name: 'Platform' },
    {
      type: 'team',
      name: 'Platform',
      organization: { id: 'acme', name: null },
    },
    { type: 'team', organization: { id: 'acme', name: null } },
    { type: 'team', organization: { id: 'acme', name: ' \t ' } },
    { type: 'user', name: 'Lena Park' },
    { type: 'system', name: 'Catalog' },
  ])(
    'omits missing organization facts without substituting another name: %p',
    (owner) => {
      expect(sharedResourceOrganizationName(owner, null)).toBeNull();
    },
  );
});

describe('sharedResourceProvenance', () => {
  it('derives the ticket fixture from resource ownership', () => {
    expect(
      sharedResourceProvenance(
        { owner: organizationOwner, shareScope: 'organization' },
        ' Lena Park ',
        'selected-personal-org',
      ),
    ).toEqual({
      author: 'Lena Park',
      organizationName: 'Acme',
      audience: { audience: 'organization' },
    });
  });

  it('keeps the team audience and uses its parent organization', () => {
    expect(
      sharedResourceProvenance(
        { owner: teamOwner, shareScope: 'team' },
        'Lena',
      ),
    ).toEqual({
      author: 'Lena',
      organizationName: 'Acme',
      audience: { audience: 'team', teamName: 'Platform' },
    });
  });

  it('omits the Personal organization without comparing its display name', () => {
    expect(
      sharedResourceProvenance(
        { owner: organizationOwner, shareScope: 'organization' },
        'Lena',
        'acme',
      ),
    ).toEqual({
      author: 'Lena',
      organizationName: null,
      audience: { audience: 'organization', personal: true },
    });
  });

  it.each(['team', 'organization'] as const)(
    'retains ownership when a %s share also has a public link',
    (shareScope) => {
      expect(
        sharedResourceProvenance(
          {
            owner: shareScope === 'team' ? teamOwner : organizationOwner,
            shareScope,
            publicShare: { upToDate: false },
          },
          'Lena',
        ),
      ).toEqual({
        author: 'Lena',
        organizationName: 'Acme',
        audience: { audience: 'public' },
      });
    },
  );

  it('does not invent an audience for private or incomplete facts', () => {
    expect(sharedResourceProvenance({}, null)).toEqual({
      author: null,
      organizationName: null,
      audience: null,
    });
    expect(
      sharedResourceProvenance({ owner: organizationOwner }, 'Lena'),
    ).toEqual({ author: 'Lena', organizationName: 'Acme', audience: null });
    expect(sharedResourceProvenance({ shareScope: 'team' }, null)).toEqual({
      author: null,
      organizationName: null,
      audience: { audience: 'team' },
    });
  });

  it.each([null, undefined, '', ' \t\n '])(
    'omits a blank author: %p',
    (author) => {
      expect(sharedResourceProvenance({}, author).author).toBeNull();
    },
  );

  it.each([
    [{ name: ' Lena ', email: 'lena@example.test' }, 'Lena'],
    [{ name: null, email: ' lena@example.test ' }, 'lena@example.test'],
    [{ name: '', email: 'lena@example.test' }, null],
    [{ name: ' \t ', email: 'lena@example.test' }, null],
    [{ name: null, email: null }, null],
  ])(
    'normalizes the author selected with the web nullish fallback: %p',
    (createdBy, author) => {
      expect(
        sharedResourceProvenance({}, createdBy.name ?? createdBy.email).author,
      ).toBe(author);
    },
  );

  it('preserves punctuation and markup-like values as serializable text', () => {
    const facts: ExistingShareFacts = {
      owner: { ...organizationOwner, name: ' <Acme & Co.> ' },
      shareScope: 'organization',
    };
    const provenance = sharedResourceProvenance(facts, ' <b>Lena · Park</b> ');
    expect(JSON.parse(JSON.stringify(provenance))).toEqual({
      author: '<b>Lena · Park</b>',
      organizationName: '<Acme & Co.>',
      audience: { audience: 'organization' },
    });
    expect(facts.owner?.name).toBe(' <Acme & Co.> ');
  });
});

describe('sharedWorkspaceTemplateProvenance', () => {
  const template: Pick<
    WorkspaceTemplateShareSummary,
    'audience' | 'owner' | 'createdBy'
  > = {
    audience: 'TEAM',
    owner: {
      type: 'team',
      id: 'platform',
      name: 'Platform',
      organization: { id: 'acme', name: ' Acme ' },
    },
    createdBy: { id: 'lena', name: ' Lena Park ' },
  };

  it('maps the team audience and derives its parent organization', () => {
    expect(sharedWorkspaceTemplateProvenance(template)).toEqual({
      author: 'Lena Park',
      organizationName: 'Acme',
      audience: { audience: 'team', teamName: 'Platform', personal: false },
    });
  });

  it('maps organization and Personal audiences with the existing identity context', () => {
    const organizationTemplate = {
      ...template,
      audience: 'ORGANIZATION',
      owner: { type: 'organization', id: 'acme', name: ' Acme ' },
    } as const;
    expect(sharedWorkspaceTemplateProvenance(organizationTemplate)).toEqual({
      author: 'Lena Park',
      organizationName: 'Acme',
      audience: { audience: 'organization', personal: false },
    });
    expect(
      sharedWorkspaceTemplateProvenance(organizationTemplate, 'acme'),
    ).toEqual({
      author: 'Lena Park',
      organizationName: null,
      audience: { audience: 'organization', personal: true },
    });
  });

  it('maps public templates without removing their ownership', () => {
    expect(
      sharedWorkspaceTemplateProvenance({ ...template, audience: 'PUBLIC' }),
    ).toEqual({
      author: 'Lena Park',
      organizationName: 'Acme',
      audience: { audience: 'public', personal: false },
    });
  });

  it('preserves a missing team name and never substitutes a different owner kind', () => {
    expect(
      sharedWorkspaceTemplateProvenance({
        ...template,
        owner: {
          type: 'team',
          id: 'platform',
          name: null,
          organization: { id: 'acme', name: null },
        },
        createdBy: { id: 'lena', name: null },
      }),
    ).toEqual({
      author: null,
      organizationName: null,
      audience: { audience: 'team', personal: false },
    });
    expect(
      sharedWorkspaceTemplateProvenance({
        ...template,
        owner: { type: 'organization', id: 'acme', name: 'Acme' },
      }).audience,
    ).toEqual({ audience: 'team', personal: false });
  });
});
