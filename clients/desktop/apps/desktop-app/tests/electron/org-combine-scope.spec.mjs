import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';
import {
  autoConversionDiagnostics,
  seedOrgCombineScope,
  prepareOrgCombineScope,
  observeOrgCombineReply,
  restoreOrgCombineReply,
  joinOrgCombineScope,
  orgCombineDestinationRow,
  ORG_COMBINE_ENV,
} from './orgCombineScopeFixture.mjs';

// Immutable reply, persisted ownership and create/claim counts, then the
// modal's navigation: it lands in the owning context (Org A, or Personal for a
// cross-organization combination) and selects the destination there.
for (const crossOrganization of [false, true]) {
  test(`CAN-3846 ${crossOrganization ? 'cross-organization' : 'same-organization'} join replies with persisted ownership after a completed pass`, async () => {
    test.setTimeout(180_000);
    const apiKey = `csk_can3846_${crossOrganization ? 'cross' : 'same'}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can3846-')),
    );
    const fixture = seedOrgCombineScope(userDataDir, crossOrganization);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: fixture.cloud,
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_COMBINE_ENV,
      }));
      const window = await prepareOrgCombineScope(
        electronApp,
        userDataDir,
        apiKey,
        fixture,
      );
      const before = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
        .activity;
      await observeOrgCombineReply(electronApp);
      const { reply, elapsedMs, visibleMs } = await joinOrgCombineScope(
        window,
        electronApp,
        fixture,
      );
      test.info().annotations.push({
        type: 'E2E join handler latency (not release-like)',
        description: `${elapsedMs} ms`,
      });
      test.info().annotations.push({
        type: 'E2E submit-to-modal-close latency (not release-like)',
        description: `${visibleMs} ms`,
      });
      const contextAtReply = await window.evaluate(() =>
        window.api.workspaceContext.get(),
      );
      await test.info().attach('reply-boundary-evidence', {
        body: JSON.stringify(
          {
            destinationWorkspaceId: reply.destinationWorkspaceId,
            owner: reply.destinationWorkspace.owner ?? null,
            context: contextAtReply.context,
            visibleRowsInCurrentScope: await orgCombineDestinationRow(
              window,
              reply,
            ).count(),
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      // Inspect the immutable reply before polling disk or waiting for a scan.
      if (crossOrganization)
        expect(reply.destinationWorkspace.owner).toBeUndefined();
      else
        expect(reply.destinationWorkspace.owner).toMatchObject({
          type: 'organization',
          organizationId: ORG_CONTEXT_A,
        });
      expect(reply.destinationWorkspace.temporary).toBe(true);
      expect(reply.createdTemporaryWorkspace).toBe(true);
      const directory = path.join(
        userDataDir,
        'workspaces',
        reply.destinationWorkspaceId,
      );
      const config = JSON.parse(
        readFileSync(path.join(directory, 'workspace.json'), 'utf8'),
      );
      expect(config.temporary).toBe(true);
      expect(config.owner).toEqual(reply.destinationWorkspace.owner);
      expect(reply.removedSourceWorktree).toBe(true);
      for (const [workspaceId, worktreeId] of [
        ['context-organization', 'org-feature'],
        [fixture.joinWorkspaceId, fixture.joinWorktreeId],
      ]) {
        const source = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'workspaces', workspaceId, 'worktrees.json'),
            'utf8',
          ),
        );
        expect(source.worktrees.map((tree) => tree.id)).not.toContain(
          worktreeId,
        );
        await expect(
          window.locator(
            `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${worktreeId}"]`,
          ),
        ).toHaveCount(0);
      }
      for (const mapping of [
        ...reply.repoMappings,
        ...reply.joinedWorktree.repoMappings,
      ]) {
        expect(
          readFileSync(path.join(mapping.newWorktreePath, 'README.md'), 'utf8'),
        ).toBe(readFileSync(path.join(mapping.repoPath, 'README.md'), 'utf8'));
      }
      const destination = orgCombineDestinationRow(window, reply);
      // No manual scope change: the modal switched before selecting.
      expect(contextAtReply.context).toEqual(
        crossOrganization
          ? { kind: 'personal' }
          : { kind: 'organization', organizationId: ORG_CONTEXT_A },
      );
      await expect(destination).toBeVisible();
      await expect(
        window.locator(
          `[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="${reply.destinationWorkspaceId}"][data-worktree-id="${reply.destinationWorktreeId}"]`,
        ),
      ).toHaveCount(1);
      await expectWorkspaceContext(
        window,
        crossOrganization ? 'personal' : ORG_CONTEXT_A,
      );
      const after = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
        .activity;
      if (crossOrganization) {
        await expect
          .poll(() => autoConversionDiagnostics(userDataDir))
          .toContainEqual({
            workspaceId: reply.destinationWorkspaceId,
            outcome: 'skipped',
            reason: 'repositories-span-organizations',
          });
        expect(after.orgMemberMultiRepoCreate ?? 0).toBe(
          before.orgMemberMultiRepoCreate ?? 0,
        );
        for (const id of fixture.heldIds)
          expect(after[`orgProjectClaim:${id}`] ?? 0).toBe(
            before[`orgProjectClaim:${id}`] ?? 0,
          );
        for (const org of [ORG_CONTEXT_A, ORG_CONTEXT_B]) {
          await selectWorkspaceContext(window, org);
          await expect(destination).toHaveCount(0);
        }
        await selectWorkspaceContext(window, 'personal');
        await expect(destination).toBeVisible();
      } else {
        const state = await (
          await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state/${apiKey}`)
        ).json();
        const definition = state.scenario.cloud.orgProjects[
          `org:${ORG_CONTEXT_A}`
        ].find((row) => row.id === config.owner.projectId);
        expect(definition).toBeDefined();
        expect(definition.repositoryProjectIds).toHaveLength(2);
        expect(definition.repositoryProjectIds).toEqual(fixture.heldIds);
        expect(
          after.orgMemberMultiRepoCreate -
            (before.orgMemberMultiRepoCreate ?? 0),
        ).toBe(1);
        expect(after[`orgProjectClaim:${config.owner.projectId}`]).toBe(1);
        await selectWorkspaceContext(window, 'personal');
        await expect(destination).toHaveCount(0);
        await selectWorkspaceContext(window, ORG_CONTEXT_B);
        await expect(destination).toHaveCount(0);
      }
    } finally {
      try {
        if (electronApp) {
          try {
            await restoreOrgCombineReply(electronApp);
          } finally {
            await closeCanopy(electronApp, userDataDir);
          }
        }
      } finally {
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    }
  });
}
