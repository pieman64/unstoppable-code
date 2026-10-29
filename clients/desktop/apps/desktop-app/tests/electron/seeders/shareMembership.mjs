import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './registerScenario.mjs';

/**
 * Organization and team membership for share-dialog specs.
 *
 * Share dialogs disable Team and Organization when the signed-in account
 * belongs to no organization, and Team alone when it belongs to no team. The
 * mock's default account reports neither, so a spec that shares to a team or
 * organization registers this membership for its API key first. It stays
 * opt-in, rather than the mock default, because organization membership also
 * turns on organization context elsewhere in the app.
 */

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

export const SHARE_MEMBERSHIP_ORGANIZATION = {
  id: '44444444-4444-4444-8444-444444444441',
  name: 'Acme Robotics',
  role: 'MEMBER',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

export const SHARE_MEMBERSHIP_TEAM = {
  id: '55555555-5555-4555-8555-555555555551',
  name: 'Platform',
  organization: {
    id: SHARE_MEMBERSHIP_ORGANIZATION.id,
    name: SHARE_MEMBERSHIP_ORGANIZATION.name,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

/**
 * Register share membership for `apiKey`. By default the account belongs to
 * one organization with one team; pass `{ teams: [] }` for an organization
 * member with no team, or `{ organizations: [], teams: [] }` for a solo user.
 *
 * @param {string} apiKey the key the spec signs in with
 * @param {{ organizations?: object[], teams?: object[], baseUrl?: string, scenario?: object }} [options]
 *   `scenario` merges extra scenario fields for the same key
 */
export async function registerShareMembership(apiKey, options = {}) {
  const {
    organizations = [SHARE_MEMBERSHIP_ORGANIZATION],
    teams = [SHARE_MEMBERSHIP_TEAM],
    baseUrl = DEFAULT_MOCK_BASE_URL,
    scenario = {},
  } = options;
  return registerScenario(baseUrl, apiKey, {
    ...scenario,
    cloud: { ...(scenario.cloud ?? {}), organizations, teams },
  });
}
