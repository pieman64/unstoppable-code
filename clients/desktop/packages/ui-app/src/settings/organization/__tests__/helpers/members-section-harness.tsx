import type { JSX, ReactNode } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import {
  createTestSettingsHost,
  TestSettingsHost,
  type TestSettingsHostOptions,
} from '../../../__tests__/helpers/test-settings-host';
import {
  OrganizationSettingsSlotsProvider,
  type OrganizationAddCardModalProps,
  type OrganizationSeatChargeSlot,
  type OrganizationSeatQuote,
  type OrganizationSettingsSlots,
} from '../../organization-settings-slots';

/** A minimal organization detail for the Members and page shell tests. */
export function buildOrganizationDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

/** A seat quote; the defaults are a chargeable $15 seat on a saved Visa. */
export function seatQuote(
  overrides: Partial<OrganizationSeatQuote> = {},
): OrganizationSeatQuote {
  return {
    chargeRequired: true,
    amountUsd: 15,
    minimumApplied: false,
    periodEndsAt: '2026-07-31T00:00:00.000Z',
    daysRemaining: 15,
    hasPaymentMethod: true,
    card: { brand: 'visa', last4: '4242' },
    ...overrides,
  };
}

/**
 * The real card modal mounts Stripe Elements; the dialog only needs to know
 * it rendered and that saving reports back.
 */
function FakeAddCardModal({
  onSaved,
}: OrganizationAddCardModalProps): JSX.Element {
  return (
    <button data-testid="add-member-payment-method-modal" onClick={onSaved}>
      Save fixture card
    </button>
  );
}

/** The web seat-charge slot with a stubbed quote read. */
export function seatChargeSlot(
  getSeatQuote: OrganizationSeatChargeSlot['getSeatQuote'],
  options: { readonly canAddCard?: boolean } = {},
): OrganizationSeatChargeSlot {
  return {
    getSeatQuote,
    canAddCard: options.canAddCard ?? true,
    AddCardModal: FakeAddCardModal,
  };
}

export interface OrganizationTestHostProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly slots?: OrganizationSettingsSlots;
  readonly host?: Omit<TestSettingsHostOptions, 'client'>;
  readonly children: ReactNode;
}

/** A settings test host plus the organization slots a test supplies. */
export function OrganizationTestHost({
  client,
  slots = {},
  host,
  children,
}: OrganizationTestHostProps): JSX.Element {
  return (
    <TestSettingsHost host={createTestSettingsHost({ ...host, client }).host}>
      <OrganizationSettingsSlotsProvider slots={slots}>
        {children}
      </OrganizationSettingsSlotsProvider>
    </TestSettingsHost>
  );
}
