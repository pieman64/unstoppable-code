import type { WorkspaceContextOrganization } from '@canopy/desktop-shared/types';
import { buildOrganizationPageCommands } from '../paletteCommands';
import {
  buildAccountOrganizationPageItems,
  buildSettingItems,
} from '../paletteProviders';

const mockOpenAccountOrganizationPage = jest.fn<
  'settings' | 'web',
  [unknown]
>();
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openAccountOrganizationPage: (route: unknown): 'settings' | 'web' =>
    mockOpenAccountOrganizationPage(route),
}));

const PERSONAL_ORG = '44444444-4444-4444-8444-444444444444';
const ACME = '11111111-1111-4111-8111-111111111111';

function acme(
  role: WorkspaceContextOrganization['role'],
): WorkspaceContextOrganization {
  return { id: ACME, name: 'Acme', role };
}

beforeEach(() => mockOpenAccountOrganizationPage.mockReset());

describe('buildAccountOrganizationPageItems', () => {
  it('opens each route and closes the palette', async () => {
    const items = buildAccountOrganizationPageItems([
      { route: { scope: 'account', page: 'billing' }, label: 'AI Credits' },
      { route: { scope: 'organizations' }, label: 'Organizations' },
    ]);
    expect(items.map((item) => [item.id, item.title, item.subtitle])).toEqual([
      ['setting-route:/account/billing', 'AI Credits', 'Settings'],
      ['setting-route:/organization', 'Organizations', 'Settings'],
    ]);
    expect(await items[1]?.execute()).toEqual({ closePalette: true });
    expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
      scope: 'organizations',
    });
  });

  it('never shares an id with a local settings section', () => {
    const local = buildSettingItems([{ key: 'account', label: 'Account' }]);
    const hosted = buildAccountOrganizationPageItems([
      { route: { scope: 'account', page: 'account' }, label: 'Account' },
    ]);
    expect(local[0]?.id).not.toBe(hosted[0]?.id);
  });
});

describe('buildOrganizationPageCommands', () => {
  const titles = (
    ...args: Parameters<typeof buildOrganizationPageCommands>
  ): string[] =>
    buildOrganizationPageCommands(...args).map((command) => command.title);

  it('offers nothing while disabled', () => {
    expect(
      titles(
        false,
        {
          context: { kind: 'organization', organizationId: ACME },
          organizations: [acme('OWNER')],
        },
        PERSONAL_ORG,
      ),
    ).toEqual([]);
  });

  it('offers Personal its Timeline and Statistics', () => {
    expect(
      titles(
        true,
        { context: { kind: 'personal' }, organizations: [] },
        PERSONAL_ORG,
      ),
    ).toEqual(['Open Personal Timeline', 'Open Personal Statistics']);
  });

  it('offers nothing for Personal until its organization is known', () => {
    expect(
      titles(true, { context: { kind: 'personal' }, organizations: [] }, null),
    ).toEqual([]);
  });

  it.each([
    ['OWNER', true],
    ['ADMIN', true],
    ['MEMBER', false],
  ] as const)('gives an %s Statistics: %p', (role, statistics) => {
    expect(
      titles(
        true,
        {
          context: { kind: 'organization', organizationId: ACME },
          organizations: [acme(role)],
        },
        PERSONAL_ORG,
      ),
    ).toEqual([
      'Open Acme Timeline',
      ...(statistics ? ['Open Acme Statistics'] : []),
      'Open Acme Members',
      'Open Acme Settings',
    ]);
  });

  it('offers nothing for an organization that is not a membership', () => {
    expect(
      titles(
        true,
        {
          context: { kind: 'organization', organizationId: ACME },
          organizations: [],
        },
        PERSONAL_ORG,
      ),
    ).toEqual([]);
  });

  it('opens the organization page and masks the organization name', async () => {
    const [feed] = buildOrganizationPageCommands(
      true,
      {
        context: { kind: 'organization', organizationId: ACME },
        organizations: [acme('MEMBER')],
      },
      PERSONAL_ORG,
    );
    expect(feed?.namesProject).toBe(true);
    expect(await feed?.execute()).toEqual({ closePalette: true });
    expect(mockOpenAccountOrganizationPage).toHaveBeenCalledWith({
      scope: 'organization',
      organizationId: ACME,
      page: 'feed',
    });
    expect(
      new Set(
        buildOrganizationPageCommands(
          true,
          {
            context: { kind: 'organization', organizationId: ACME },
            organizations: [acme('OWNER')],
          },
          PERSONAL_ORG,
        ).map((command) => command.commandKey),
      ).size,
    ).toBe(4);
  });
});
