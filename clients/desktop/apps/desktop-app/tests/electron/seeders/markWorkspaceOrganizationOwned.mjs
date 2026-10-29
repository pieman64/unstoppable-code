import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Make an already-seeded workspace owned by an organization (CAN-3463).
 *
 * AI Credits spill only onto the pool of the organization that owns the work,
 * so a spec asserting org-pool coverage needs a chat whose workspace names that
 * org as its persisted owner. Only `workspace.json`'s `owner` changes; the ids
 * after the organization id are fixed placeholders.
 * @param {string} userDataDir
 * @param {string} workspaceId
 * @param {string} organizationId
 * @returns {void}
 */
export function markWorkspaceOrganizationOwned(
  userDataDir,
  workspaceId,
  organizationId,
) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  writeJson(filePath, {
    ...config,
    owner: {
      type: 'organization',
      organizationId,
      projectId: '99999999-9999-4999-8999-999999999991',
      instanceId: '99999999-9999-4999-8999-999999999992',
      bindingGeneration: 0,
    },
  });
}
