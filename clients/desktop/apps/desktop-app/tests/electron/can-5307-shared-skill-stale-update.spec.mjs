import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';

for (const scope of ['team', 'organization']) {
  test(`CAN-5307: ${scope} copies update through review without another alias`, async () => {
    test.setTimeout(180_000);
    const id = 'fa530700-0000-4000-8000-000000000001';
    const name = 'platform-pr-review';
    const key = `csk_can5307_${scope}`;
    const revision = (version) => {
      const rawSkill = `---\nname: ${name}\ndescription: Review pull requests.\n---\n\nVersion ${version}.\n`;
      return {
        id,
        name,
        rawSkill,
        description: 'Review pull requests.',
        contentHash: createHash('sha256').update(rawSkill).digest('hex'),
        shareScope: scope,
        owner:
          scope === 'team'
            ? {
                type: 'team',
                id: '7c1e5b0d-3f4a-4a8e-9c2d-1e6f7a8b9c0d',
                name: 'Platform',
                organization: { id: ORG_CONTEXT_A, name: 'Acme' },
              }
            : { type: 'organization', id: ORG_CONTEXT_A, name: 'Acme' },
        createdBy: { id: 'lena', name: 'Lena Park', email: null },
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: `2026-10-29T00:00:0${version}.000Z`,
        canUpdate: false,
        canDelete: false,
        publicShare: null,
      };
    };
    const publish = (version) =>
      registerScenario(DEFAULT_MOCK_BASE_URL, key, {
        cloud: {
          organizations: ORG_CONTEXT_ORGANIZATIONS,
          sharedSkills: [revision(version)],
        },
      });
    await publish(1);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `can5307-${scope}-`),
    );
    seedOrgContextScoping(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, key);
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      // Force the first file claim to fail after main publishes its receipt.
      // Once the filesystem is restored, opening the review must permit retry.
      const skillsRoot = path.join(userDataDir, 'skills');
      const backup = `${skillsRoot}-retry-backup`;
      const hadSkills = existsSync(skillsRoot);
      if (hadSkills) renameSync(skillsRoot, backup);
      writeFileSync(skillsRoot, 'blocked');
      try {
        const failure = await window.evaluate(
          async ({ id, name, rawSkill }) => {
            try {
              await window.skills.writeRawSkill({
                skillName: name,
                rawSkill,
                sourceRemoteId: id,
              });
              return null;
            } catch (error) {
              return String(error);
            }
          },
          revision(1),
        );
        expect(failure).toBeTruthy();
        const state = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'resource-install-receipts.json'),
            'utf8',
          ),
        );
        expect(
          Object.values(state.byAccount)
            .flat()
            .find((row) => row.remoteId === id).localResourceIds,
        ).toEqual([]);
      } finally {
        unlinkSync(skillsRoot);
        if (hadSkills) renameSync(backup, skillsRoot);
        else mkdirSync(skillsRoot);
      }
      const open = () =>
        electronApp.evaluate(
          ({ app }, url) => app.emit('open-url', { preventDefault() {} }, url),
          `canopy://share/skills/${id}?audience=${scope.toUpperCase()}`,
        );
      const read = () =>
        window.evaluate(
          (localName) => window.skills.readRawSkill(`custom:app/${localName}`),
          name,
        );
      const aliases = () =>
        window.evaluate(async (remoteId) => {
          const { installedCopyIds } = await window.skills.getShared(remoteId);
          return installedCopyIds;
        }, id);
      const review = window.getByTestId('deep-link-share-landing');
      await open();
      await review.getByTestId('deep-link-share-install').click();
      await expect(review).toHaveCount(0, { timeout: 30_000 });
      expect(await read()).toBe(revision(1).rawSkill);
      // Package dependencies share provenance, but are not copies of the primary.
      // Seed the package receipt seam; unit coverage exercises its actual writer.
      const receiptFile = path.join(
        userDataDir,
        'resource-install-receipts.json',
      );
      const receipts = JSON.parse(readFileSync(receiptFile, 'utf8'));
      const receipt = Object.values(receipts.byAccount)
        .flat()
        .find((row) => row.remoteId === id);
      const dependencyName = 'a-dependency';
      const dependencyBytes =
        '---\nname: a-dependency\n---\nDependency instructions.\n';
      const source = readdirSync(skillsRoot).find((entry) =>
        existsSync(path.join(skillsRoot, entry, name, 'SKILL.md')),
      );
      expect(source).toBeTruthy();
      const dependencyDir = path.join(skillsRoot, source, dependencyName);
      mkdirSync(dependencyDir, { recursive: true });
      const dependencyFile = path.join(dependencyDir, 'SKILL.md');
      writeFileSync(dependencyFile, dependencyBytes);
      receipt.localResourceRoles = {
        [`custom:app/${name}`]: 'primary',
        [`custom:app/${dependencyName}`]: 'dependency',
      };
      receipt.localResourceIds.push(`custom:app/${dependencyName}`);
      receipt.localContentHashes[`custom:app/${dependencyName}`] = createHash(
        'sha256',
      )
        .update(dependencyBytes)
        .digest('hex');
      writeFileSync(receiptFile, JSON.stringify(receipts));
      await publish(2);
      // The installed source link opens the shared page, whose Update opens the same review.
      await window.getByTestId('installed-share-source-link').click();
      await expect(
        window.getByTestId('shared-skill-detail-update'),
      ).toBeVisible();
      await expect(
        window.getByTestId('shared-skill-detail-installed-status'),
      ).toContainText(name);
      await window.getByTestId('shared-skill-detail-update').click();
      await expect(review.getByTestId('deep-link-share-update')).toBeVisible();
      expect(await read()).toBe(revision(1).rawSkill);
      await review.getByTestId('deep-link-share-update').click();
      await expect(review).toHaveCount(0);
      expect(await read()).toBe(revision(2).rawSkill);
      expect(readFileSync(dependencyFile, 'utf8')).toBe(dependencyBytes);
      expect(await aliases()).toEqual([`custom:app/${name}`]);
      await expect(window.getByTestId('skill-update-notice')).toHaveCount(0);
      await publish(3);
      await open();
      await expect(review.getByTestId('deep-link-share-update')).toBeVisible();
      await review.getByTestId('deep-link-share-kebab').click();
      await expect(window.getByTestId('deep-link-share-manage')).toBeVisible();
      await expect(
        window.getByTestId('deep-link-share-uninstall'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      await expect(review).toHaveCount(0);
      expect(await read()).toBe(revision(2).rawSkill);
      // Edit through the actual managed editor boundary, then cancel and confirm replacement.
      await window.evaluate(async (localName) => {
        const result = await window.skills.saveCustomSkill({
          name: localName,
          originalName: localName,
          description: 'My edits',
          body: '# My edit',
        });
        if (!result.success) throw new Error(result.error);
      }, name);
      const edited = await read();
      await open();
      await review.getByTestId('deep-link-share-update').click();
      await expect(
        window.getByTestId('deep-link-share-replace-dialog'),
      ).toBeVisible();
      await window.getByTestId('deep-link-share-replace-cancel').click();
      expect(await read()).toBe(edited);
      await review.getByTestId('deep-link-share-update').click();
      await window.getByTestId('deep-link-share-replace-confirm').click();
      await expect(review).toHaveCount(0);
      expect(await read()).toBe(revision(3).rawSkill);
      expect(await aliases()).toEqual([`custom:app/${name}`]);
      await open();
      await review.getByTestId('deep-link-share-kebab').click();
      await window.getByTestId('deep-link-share-uninstall').click();
      await window.getByTestId('deep-link-share-uninstall-confirm').click();
      await expect(review.getByTestId('deep-link-share-install')).toBeVisible();
      // Reopening must re-read authoritative state, not turn deliberate removal into recovery.
      await window.keyboard.press('Escape');
      await open();
      await expect(review.getByTestId('deep-link-share-install')).toBeEnabled();
      await expect(review.getByTestId('deep-link-share-retry')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, key);
    }
  });
}
