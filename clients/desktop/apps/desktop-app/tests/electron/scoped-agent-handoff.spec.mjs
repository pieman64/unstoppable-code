import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { registerShareMembership } from './seeders/index.mjs';

const AGENT_ID = 'fa300900-0000-4000-8000-000000000031';

// A legacy team Agent can still carry a public link pinned to older content.
// The team handoff must show the team's current Agent.
test('a Team Agent handoff resolves the scoped Agent, not its stale public link', async () => {
  const apiKey = 'csk_can3009_scoped_agent_recipient';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'scoped-agent-recipient-'),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.evaluate(
      (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
      apiKey,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await electronApp.evaluate((_electron, id) => {
      const originalFetch = globalThis.fetch;
      globalThis.__scopedAgentRequests = [];
      const json = (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const at = '2026-10-02T00:00:00.000Z';
      const agent = (name, instructions) => ({
        version: 1,
        id: 'agent-local-id',
        name,
        baseModel: 'sonnet',
        instructions,
        plugins: [],
      });
      globalThis.fetch = async (input, init) => {
        const { pathname } = new URL(String(input));
        if (pathname.includes(`/public-shares/agents/${id}`)) {
          globalThis.__scopedAgentRequests.push('public');
          return json({
            entity: 'agent',
            externalId: id,
            agent: agent('Stale Public Agent', 'Published before the update.'),
            contentHash: 'a'.repeat(64),
            authorUsername: null,
            updatedAt: at,
          });
        }
        if (pathname.endsWith(`/agents/${id}`)) {
          globalThis.__scopedAgentRequests.push('scoped');
          return json({
            id,
            agent: agent('Current Team Agent', 'What the team shares now.'),
            contentHash: 'b'.repeat(64),
            distributionMode: 'package',
            package: {
              version: 1,
              digest: `pp:v1:${'A'.repeat(43)}`,
              resources: [],
              environmentRequirements: [],
              totalFiles: 1,
              totalBytes: 12,
            },
            shareScope: 'team',
            owner: {
              type: 'team',
              id: 'team-1',
              name: 'Platform',
              organization: { id: 'org-1', name: 'Acme Robotics' },
            },
            createdBy: { id: 'creator', name: 'Creator', email: null },
            createdAt: at,
            updatedAt: at,
            canUpdate: false,
            canDelete: false,
            publicShare: null,
          });
        }
        return originalFetch(input, init);
      };
    }, AGENT_ID);
    await electronApp.evaluate(
      ({ app }, id) =>
        app.emit(
          'open-url',
          { preventDefault() {} },
          `canopy://share/agents/${id}?audience=TEAM`,
        ),
      AGENT_ID,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('Current Team Agent');
    await expect(landing).not.toContainText('Stale Public Agent');
    // The review stays light (CAN-3710): one Install and nothing written yet.
    await expect(landing.getByTestId('deep-link-share-install')).toBeVisible();
    await expect(
      landing.getByTestId('deep-link-share-package-summary'),
    ).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.__scopedAgentRequests),
    ).not.toContain('public');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
