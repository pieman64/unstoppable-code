import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { useNavigationStore } from '@/stores/navigationStore';
import { MarketplaceSkillDetail } from '../MarketplaceSkillDetail';

interface LandingContentProps {
  heading?: ReactNode;
  headerTitle?: string;
  onInstall?: () => void;
}

const mockLandingContent = jest.fn(
  ({ heading }: LandingContentProps): ReactNode => heading ?? null,
);

jest.mock('../usePublicShareLanding', () => ({
  usePublicShareLanding: jest.fn(() => ({})),
}));
jest.mock('../MarketplaceSkillDetailBody', () => ({
  MarketplaceSkillDetailBody: (props: LandingContentProps): ReactNode =>
    mockLandingContent(props),
}));

function renderDetail(
  props: Partial<Parameters<typeof MarketplaceSkillDetail>[0]> = {},
): string {
  return renderToString(
    <MarketplaceSkillDetail
      externalId="2f0c9a1e-4b3d-5f6a-8c2e-1d5b7a9e0c4f"
      name="Writing guide"
      onClose={jest.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockLandingContent.mockClear();
});

// CAN-4261: the shared detail header like every Customize detail: one title,
// no Back (the breadcrumb leads out), and the body adds no title of its own.
it('uses the shared detail header with one visible title and no Back', () => {
  const html = renderDetail();

  expect(html).toContain('aria-labelledby="plugins-entry-detail-title"');
  expect(html).toContain('data-testid="plugins-entry-detail-header"');
  expect(html.match(/<h[1-6]\b/g)).toHaveLength(1);
  expect(html).not.toContain('plugins-entry-detail-back');
  const body = mockLandingContent.mock.calls[0]?.[0];
  expect(body?.heading).toBeUndefined();
  expect(body?.headerTitle).toBe('Writing guide');
});

it('hides a Share the catalog skill cannot use', () => {
  const html = renderDetail({
    shareAction: { status: 'blocked', reason: 'Already public.' },
  });
  expect(html).not.toContain('plugins-entry-detail-share');
});

it('opens the shared install review instead of installing in the page', () => {
  useNavigationStore.setState({ pendingShareInstall: undefined });
  renderDetail();

  mockLandingContent.mock.calls[0]?.[0]?.onInstall?.();

  expect(useNavigationStore.getState().pendingShareInstall).toEqual({
    link: {
      entity: 'skill',
      externalId: '2f0c9a1e-4b3d-5f6a-8c2e-1d5b7a9e0c4f',
      intent: 'install',
    },
    origin: 'in-app',
  });
});
