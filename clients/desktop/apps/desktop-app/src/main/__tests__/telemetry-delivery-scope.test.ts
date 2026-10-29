import { resolveTelemetryDeliveryTarget } from '../services/telemetry-delivery-scope';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// CAN-3515: activity counts only in the scope that owns the work. The owner is
// the only input that picks an organization; nothing here knows about, or can
// be influenced by, the sidebar selection.
describe('resolveTelemetryDeliveryTarget', () => {
  it.each(['organization', 'team'] as const)(
    'delivers org-owned work to its owner at %s scope',
    (preferredScope) => {
      expect(
        resolveTelemetryDeliveryTarget({
          preferredScope,
          ownerOrganizationId: ORG_A,
          explicitOrganizationId: null,
        }),
      ).toEqual({
        scope: preferredScope,
        organizationId: ORG_A,
        ownerRoute: true,
      });
    },
  );

  it.each(['organization', 'team'] as const)(
    'keeps Personal work private even when the member shares at %s scope',
    (preferredScope) => {
      expect(
        resolveTelemetryDeliveryTarget({
          preferredScope,
          ownerOrganizationId: null,
          explicitOrganizationId: null,
        }),
      ).toEqual({ scope: 'private', organizationId: null, ownerRoute: true });
    },
  );

  it.each([ORG_A, null])(
    'honors a private preference for any owner (%s)',
    (ownerOrganizationId) => {
      expect(
        resolveTelemetryDeliveryTarget({
          preferredScope: 'private',
          ownerOrganizationId,
          explicitOrganizationId: null,
        }),
      ).toEqual({ scope: 'private', organizationId: null, ownerRoute: true });
    },
  );

  it('routes an explicit shared-container anchor to the chosen organization without making it the owner route', () => {
    expect(
      resolveTelemetryDeliveryTarget({
        preferredScope: 'organization',
        ownerOrganizationId: null,
        explicitOrganizationId: ORG_B,
      }),
    ).toEqual({
      scope: 'organization',
      organizationId: ORG_B,
      ownerRoute: false,
    });
  });

  it('treats an explicit anchor that names the owner as the owner route', () => {
    expect(
      resolveTelemetryDeliveryTarget({
        preferredScope: 'organization',
        ownerOrganizationId: ORG_A,
        explicitOrganizationId: ORG_A,
      }),
    ).toEqual({
      scope: 'organization',
      organizationId: ORG_A,
      ownerRoute: true,
    });
  });

  it('keeps an explicit anchor private when the member shares privately', () => {
    expect(
      resolveTelemetryDeliveryTarget({
        preferredScope: 'private',
        ownerOrganizationId: null,
        explicitOrganizationId: ORG_B,
      }),
    ).toEqual({ scope: 'private', organizationId: null, ownerRoute: true });
  });
});
