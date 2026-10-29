import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { registerShareMembership } from './seeders/index.mjs';

const SKILL_ID = 'fa300900-0000-4000-8000-000000000021';

// A legacy team skill can still carry a public link pinned to older content.
// The team handoff must show and install the team's current skill.
test('a Team skill handoff resolves the scoped skill, not its stale public link', async () => {
  const apiKey = 'csk_can3009_scoped_skill_recipient';
  await registerShareMembership(apiKey);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'scoped-skill-recipient-'),
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
      globalThis.__scopedSkillRequests = [];
      const json = (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const at = '2026-10-02T00:00:00.000Z';
      globalThis.fetch = async (input, init) => {
        const { pathname } = new URL(String(input));
        if (pathname.includes(`/public-shares/skills/${id}`)) {
          globalThis.__scopedSkillRequests.push('public');
          return json({
            entity: 'skill',
            externalId: id,
            name: 'stale-public-skill',
            description: 'Published before the team updated it.',
            rawSkill:
              '---\nname: stale-public-skill\ndescription: Old.\n---\n\nOld.\n',
            contentHash: 'a'.repeat(64),
            dependencies: [],
            authorUsername: null,
            updatedAt: at,
          });
        }
        if (pathname.endsWith(`/skills/${id}`)) {
          globalThis.__scopedSkillRequests.push('scoped');
          return json({
            id,
            name: 'current-team-skill',
            description: 'What the team shares now.',
            rawSkill:
              '---\nname: current-team-skill\ndescription: Current.\n---\n\nCurrent.\n',
            contentHash: 'b'.repeat(64),
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
    }, SKILL_ID);
    await electronApp.evaluate(
      ({ app }, id) =>
        app.emit(
          'open-url',
          { preventDefault() {} },
          `canopy://share/skills/${id}?audience=TEAM`,
        ),
      SKILL_ID,
    );
    const landing = window.getByTestId('deep-link-share-landing');
    await expect(landing).toContainText('current-team-skill');
    await expect(landing).not.toContainText('stale-public-skill');
    expect(
      await electronApp.evaluate(() => globalThis.__scopedSkillRequests),
    ).not.toContain('public');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
