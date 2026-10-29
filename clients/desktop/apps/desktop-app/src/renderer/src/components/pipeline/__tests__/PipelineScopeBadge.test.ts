import {
  getPipelineScopeBadgeLabel,
  getPipelineScopeBadgeTooltipLines,
} from '../pipeline-scope-badge-helpers';
import type { PipelineShareOwner } from '@canopy/desktop-shared/types/pipeline';

describe('getPipelineScopeBadgeLabel', () => {
  it('uses a neutral label for the private storage scope', () => {
    expect(getPipelineScopeBadgeLabel('private')).toBe('Shared');
  });

  it('renders Team for the team scope', () => {
    expect(getPipelineScopeBadgeLabel('team')).toBe('Team');
  });

  it('renders Organization for the organization scope', () => {
    expect(getPipelineScopeBadgeLabel('organization')).toBe('Organization');
  });

  it('falls back to Shared when shareScope is missing', () => {
    expect(getPipelineScopeBadgeLabel(undefined)).toBe('Shared');
  });
});

describe('getPipelineScopeBadgeTooltipLines', () => {
  it('returns no lines for the private storage scope (no tooltip)', () => {
    expect(getPipelineScopeBadgeTooltipLines('private', undefined)).toEqual([]);
  });

  it('returns no lines when shareScope is missing (neutral fallback)', () => {
    expect(getPipelineScopeBadgeTooltipLines(undefined, undefined)).toEqual([]);
  });

  it('returns team name and organization name for a team owner', () => {
    const owner: PipelineShareOwner = {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: {
        id: 'org-1',
        name: 'Acme',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    };
    expect(getPipelineScopeBadgeTooltipLines('team', owner)).toEqual([
      'Platform',
      'Acme',
    ]);
  });

  it('returns organization name for an organization owner', () => {
    const owner: PipelineShareOwner = {
      type: 'organization',
      id: 'org-1',
      name: 'Acme',
    };
    expect(getPipelineScopeBadgeTooltipLines('organization', owner)).toEqual([
      'Acme',
    ]);
  });

  it('falls back to "Team" when team owner is missing', () => {
    expect(getPipelineScopeBadgeTooltipLines('team', undefined)).toEqual([
      'Team',
    ]);
  });

  it('falls back to "Team" when team owner.name is empty', () => {
    const owner: PipelineShareOwner = {
      type: 'team',
      id: 'team-1',
      name: '',
      organization: {
        id: 'org-1',
        name: 'Acme',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
    };
    expect(getPipelineScopeBadgeTooltipLines('team', owner)).toEqual(['Team']);
  });

  it('falls back to "Organization" when organization owner is missing', () => {
    expect(
      getPipelineScopeBadgeTooltipLines('organization', undefined),
    ).toEqual(['Organization']);
  });

  it('falls back to "Organization" when organization owner.name is empty', () => {
    const owner: PipelineShareOwner = {
      type: 'organization',
      id: 'org-1',
      name: '',
    };
    expect(getPipelineScopeBadgeTooltipLines('organization', owner)).toEqual([
      'Organization',
    ]);
  });

  it('falls back to "Team" when owner type does not match the scope', () => {
    const orgOwner: PipelineShareOwner = {
      type: 'organization',
      id: 'org-1',
      name: 'Acme',
    };
    expect(getPipelineScopeBadgeTooltipLines('team', orgOwner)).toEqual([
      'Team',
    ]);
  });
});
