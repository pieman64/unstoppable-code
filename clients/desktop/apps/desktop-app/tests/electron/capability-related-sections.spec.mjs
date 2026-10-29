import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, discardWorkflowEditIfOpen } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

const SKILL_SOURCE_ID = 'github:example:skills';
const SKILL_NAME = 'review-navigator';
const UNRELATED_SKILL = 'pipeline-navigator';
// The detail header titles a skill by its title-cased display name.
const SKILL_TITLE = 'Review Navigator';
const UNRELATED_SKILL_TITLE = 'Pipeline Navigator';
const PLUGIN_NAME = 'gamma-tool';
const SOURCE_ID = 'can2382-review-source';
const SIBLING_ID = 'can2382-review-sibling';

function pipelineYaml({
  name,
  description,
  skillName,
  pluginName,
  collectionName = 'Review Tools',
}) {
  const defaults = [];
  if (skillName) {
    defaults.push(
      '      - type: skill',
      '        source:',
      '          type: github',
      '          repo: example/skills',
      `        skill_name: ${skillName}`,
      '        required: true',
    );
  }
  if (pluginName) {
    defaults.push(
      '      - type: claude_plugin',
      '        marketplace:',
      '          type: github',
      '          repo: demo/market',
      `        plugin_name: ${pluginName}`,
    );
  }
  return [
    `name: ${name}`,
    `description: ${description}`,
    'on: dispatch',
    ...(defaults.length
      ? [
          'plugin_collections:',
          '  - id: review_tools',
          `    name: ${collectionName}`,
          '    defaults:',
          ...defaults,
        ]
      : []),
    'jobs:',
    '  main:',
    '    steps:',
    '      - run: echo review',
    '',
  ].join('\n');
}

function seedPipeline(userDataDir, pipeline) {
  seedStoredPipeline({
    userDataDir,
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    yaml: pipeline.yaml,
  });
}

function seedInstalledSkillSource(userDataDir) {
  const lock = { version: 2, skills: {} };
  for (const [name, description] of [
    [SKILL_NAME, 'Review pipeline changes.'],
    [UNRELATED_SKILL, 'Navigate pipeline definitions.'],
  ]) {
    lock.skills[`${SKILL_SOURCE_ID}/${name}`] = {
      sourceId: SKILL_SOURCE_ID,
      source: 'example/skills',
      sourceType: 'github',
      sourceUrl: 'https://github.com/example/skills',
      skillPath: name,
      skillFolderHash: `can2382-${name}`,
      installedAt: '2026-07-14T10:00:00.000Z',
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    const skillDir = path.join(userDataDir, 'skills', SKILL_SOURCE_ID, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
      'utf8',
    );
  }
  writeFileSync(
    path.join(userDataDir, 'skills', 'skills-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
    'utf8',
  );
}

function seedShareablePluginCache(userDataDir) {
  const pluginCachePath = path.join(userDataDir, 'plugin-cache', PLUGIN_NAME);
  mkdirSync(pluginCachePath, { recursive: true });
  seedPluginsCache({
    userDataDir,
    installedPluginCachePaths: { [PLUGIN_NAME]: pluginCachePath },
  });
  const cachePath = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  cache.marketplaces[0].sourceUrl = 'https://github.com/demo/market';
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

/** The open skill detail page's title. */
function skillDetailTitle(window) {
  return window.locator('#skill-detail-modal-title');
}

async function openPipelineSettings(window, app, pipelineId) {
  await app.openPipelinesPage();
  await app.openWorkflowsLibraryRow(
    app.workflowsLibraryPipelineRow(pipelineId),
  );
  await window.getByTestId('pipeline-editor-settings-toggle').click();
}

test('skill, plugin, and pipeline details expose related entries and empty states', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-links-'));
  seedShareablePluginCache(userDataDir);
  seedInstalledSkillSource(userDataDir);
  const source = {
    id: SOURCE_ID,
    name: 'Structured Review Helper',
    description: 'Runs a structured code review on dispatch',
    yaml: pipelineYaml({
      name: 'Structured Review Helper',
      description: 'Runs a structured code review on dispatch',
      skillName: SKILL_NAME,
      pluginName: PLUGIN_NAME,
    }),
  };
  const sibling = {
    id: SIBLING_ID,
    name: 'Structured Review Helper (Codex)',
    description: 'Runs a structured code review with Codex on dispatch',
    yaml: pipelineYaml({
      name: 'Structured Review Helper (Codex)',
      description: 'Runs a structured code review with Codex on dispatch',
      skillName: SKILL_NAME,
    }),
  };
  seedPipeline(userDataDir, source);
  seedPipeline(userDataDir, sibling);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const refs = await window.evaluate(() =>
      window.pipelines.listCapabilityRefs(),
    );
    expect(refs).toMatchObject({ success: true });
    expect(refs.data?.pipelines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: SOURCE_ID,
          capabilities: expect.arrayContaining([
            expect.objectContaining({
              matchState: 'matched',
              selection: {
                kind: 'skill',
                sourceId: SKILL_SOURCE_ID,
                skillName: SKILL_NAME,
              },
            }),
            expect.objectContaining({
              matchState: 'matched',
              selection: {
                kind: 'plugin',
                marketplaceId: 'demo/market',
                pluginName: PLUGIN_NAME,
              },
            }),
          ]),
        }),
      ]),
    );

    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill(SKILL_NAME);
    await window
      .getByTestId(`customize-row-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`)
      .click();
    await expect(skillDetailTitle(window)).toHaveText(SKILL_TITLE);
    await expect(
      window.getByTestId('capability-related-sections'),
    ).toBeVisible();
    const sourceRow = window.getByTestId(
      `related-pipelines-section-item-user:${SOURCE_ID}`,
    );
    await expect(sourceRow).toContainText(source.name);
    // CAN-4261: compact rows state a shared reason once, under the title.
    const relatedPipelines = window.getByTestId('related-pipelines-section');
    await expect(relatedPipelines).toContainText(
      'Required by collection "Review Tools"',
    );
    await expect(sourceRow).not.toContainText('Required by collection');
    await expect(
      window
        .getByTestId('related-capabilities-section')
        .getByText('From the same source')
        .first(),
    ).toBeVisible();

    await window
      .getByTestId(
        `related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${UNRELATED_SKILL}`,
      )
      .click();
    await expect(skillDetailTitle(window)).toHaveText(UNRELATED_SKILL_TITLE);
    // CAN-4261: no Back pops the related detail; the breadcrumb root leads to
    // the list, which keeps the search.
    await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await window
      .getByTestId(`customize-row-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`)
      .click();
    await expect(skillDetailTitle(window)).toHaveText(SKILL_TITLE);

    // The pipeline opens in the Workflows edit shell, whose Back returns to
    // Marketplace.
    await sourceRow.click();
    await expect(window.getByTestId('workflow-edit-shell')).toHaveAttribute(
      'data-kind',
      'pipeline',
    );
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Customize',
    );
    await expect(window.getByTestId('pipeline-save')).toBeVisible();
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await window
      .getByTestId(
        `pipeline-related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`,
      )
      .click();
    await expect(skillDetailTitle(window)).toHaveText(SKILL_TITLE);
    // CAN-4261: no Back returns to the pipeline editor; the breadcrumb root
    // leads to the list.
    await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(window.getByTestId('plugins-entry-detail')).toHaveCount(0);

    await window.getByTestId('plugins-search').fill(UNRELATED_SKILL);
    await window
      .getByTestId(`customize-row-skill:${SKILL_SOURCE_ID}:${UNRELATED_SKILL}`)
      .click();
    await expect(skillDetailTitle(window)).toHaveText(UNRELATED_SKILL_TITLE);
    await expect(
      window.getByTestId('related-capabilities-section'),
    ).toBeVisible();
    // CAN-4261: a skill page hides an empty Related pipelines section.
    await expect(
      window.getByTestId('related-pipelines-section-empty'),
    ).toHaveCount(0);
    await expect(window.getByTestId('related-pipelines-section')).toHaveCount(
      0,
    );
    await window.keyboard.press('Escape');

    await window.getByTestId('plugins-search').fill(PLUGIN_NAME);
    await window
      .getByTestId(`plugins-entry-mkt:demo/market/${PLUGIN_NAME}`)
      .click();
    const pluginDetail = window.getByTestId('plugins-entry-detail');
    await expect(
      pluginDetail.getByTestId(
        `related-pipelines-section-item-user:${SOURCE_ID}`,
      ),
    ).toBeVisible();
    await expect(
      pluginDetail
        .getByTestId('related-capabilities-section')
        .getByText('Alpha Tool', { exact: true })
        .first(),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    await openPipelineSettings(window, app, SOURCE_ID);
    const similar = window.getByTestId(
      `similar-pipelines-section-item-user:${SIBLING_ID}`,
    );
    await expect(similar).toContainText(sibling.name);
    await expect(
      window.getByTestId(
        `pipeline-related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`,
      ),
    ).toBeVisible();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('nested capability and pipeline navigation keeps the editor Back and leaves details by breadcrumb', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-nested-'));
  seedShareablePluginCache(userDataDir);
  seedInstalledSkillSource(userDataDir);
  seedPipeline(userDataDir, {
    id: SOURCE_ID,
    name: 'Review Source',
    description: 'Review source',
    yaml: pipelineYaml({
      name: 'Review Source',
      description: 'Review source',
      skillName: SKILL_NAME,
    }),
  });
  const nestedId = 'can2382-nested-return';
  seedPipeline(userDataDir, {
    id: nestedId,
    name: 'Nested Return Helper',
    description: 'Exercises a nested capability return chain',
    yaml: pipelineYaml({
      name: 'Nested Return Helper',
      description: 'Exercises a nested capability return chain',
      skillName: UNRELATED_SKILL,
    }).replace(
      `        skill_name: ${UNRELATED_SKILL}`,
      `        skill_name: ${UNRELATED_SKILL}\n      - type: skill\n        source:\n          type: github\n          repo: example/skills\n        skill_name: ${SKILL_NAME}`,
    ),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await openPipelineSettings(window, app, SOURCE_ID);
    await window
      .getByTestId(
        `pipeline-related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`,
      )
      .click();
    await window
      .getByTestId('plugins-entry-detail')
      .getByTestId(
        `related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${UNRELATED_SKILL}`,
      )
      .click();
    await window
      .getByTestId(`related-pipelines-section-item-user:${nestedId}`)
      .click();
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Customize',
    );
    // The editor's own Back still returns to the detail that opened it.
    await window.getByTestId('pipeline-editor-back').click();
    await expect(skillDetailTitle(window)).toHaveText(UNRELATED_SKILL_TITLE);
    await window
      .getByTestId(`related-pipelines-section-item-user:${nestedId}`)
      .click();
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await window
      .getByTestId(
        `pipeline-related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`,
      )
      .click();
    await expect(skillDetailTitle(window)).toHaveText(SKILL_TITLE);
    // CAN-4261: detail pages have no Back to pop the related-detail stack or
    // return to the pipeline editor; the breadcrumb root leads to the list.
    await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-root').click();
    await expect(window.getByTestId('plugins-entry-detail')).toHaveCount(0);
    await expect(window.getByTestId('plugins-search')).toBeVisible();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('saved relationships refresh and dirty edits survive recommendation navigation', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-save-'));
  seedShareablePluginCache(userDataDir);
  seedInstalledSkillSource(userDataDir);
  seedPipeline(userDataDir, {
    id: SOURCE_ID,
    name: 'Review Source',
    description: 'Original description',
    yaml: pipelineYaml({
      name: 'Review Source',
      description: 'Original description',
      skillName: SKILL_NAME,
    }),
  });
  seedPipeline(userDataDir, {
    id: SIBLING_ID,
    name: 'Review Sibling',
    description: 'Similar review helper',
    yaml: pipelineYaml({
      name: 'Review Sibling',
      description: 'Similar review helper',
    }),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await openPipelineSettings(window, app, SOURCE_ID);

    await window.getByRole('button', { name: 'Review Tools 1 plugin' }).click();
    await window.getByRole('button', { name: 'Remove default' }).click();
    await window.getByTestId('pipeline-save').click();
    await expect
      .poll(
        () =>
          readFileSync(
            path.join(userDataDir, 'pipelines', `${SOURCE_ID}.yaml`),
            'utf8',
          ),
        { timeout: 15_000 },
      )
      .not.toContain(`skill_name: ${SKILL_NAME}`);
    await expect(
      window.getByTestId(
        `pipeline-related-capabilities-section-item-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`,
      ),
    ).toHaveCount(0);

    await window
      .getByPlaceholder('Describe what this pipeline does…')
      .fill('Edited immediately before navigation');
    await window
      .getByTestId(`similar-pipelines-section-item-user:${SIBLING_ID}`)
      .click();
    // The sibling opens as its own item in the edit shell (CAN-4072), so its
    // settings start closed.
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Pipeline',
    );
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await expect(
      window.getByTestId(`similar-pipelines-section-item-user:${SOURCE_ID}`),
    ).toBeVisible();
    // Opening the recommendation saved the edit first, so the sibling's Back
    // returns to the source pipeline without asking.
    await window.getByTestId('pipeline-editor-back').click();
    await expect(window.getByTestId('workflows-unsaved-dialog')).toHaveCount(0);
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Library',
    );
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await expect(
      window.getByPlaceholder('Describe what this pipeline does…'),
    ).toHaveValue('Edited immediately before navigation');
    await expect(window.getByTestId('workflow-edit-shell')).toHaveAttribute(
      'data-dirty',
      'false',
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a related recommendation opened from a new draft returns to the saved draft', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-draft-'));
  seedPipeline(userDataDir, {
    id: SIBLING_ID,
    name: 'Review Sibling',
    description: 'Similar review helper',
    yaml: pipelineYaml({
      name: 'Review Sibling',
      description: 'Similar review helper',
    }),
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    // The manual builder is the New workflow menu's "When you start it, built
    // by hand" row (CAN-3981).
    await app.startNewWorkflow('build');
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await window.getByPlaceholder('Pipeline name').fill('Review Draft');
    await window
      .getByTestId(`similar-pipelines-section-item-user:${SIBLING_ID}`)
      .click();
    await expect(window.getByPlaceholder('Pipeline name')).toHaveCount(0);
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Pipeline',
    );
    await window.getByTestId('pipeline-editor-back').click();
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await expect(window.getByPlaceholder('Pipeline name')).toHaveValue(
      'Review Draft',
    );
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('unreadable stored pipelines are excluded from recommendations', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-read-'));
  const sourceId = 'can2382-readable-source';
  const readableId = 'can2382-readable-candidate';
  const unreadableId = 'can2382-unreadable-candidate';
  for (const [id, name] of [
    [sourceId, 'Unreadable Review Source'],
    [readableId, '001 Readable Review Candidate'],
    [unreadableId, '000 Unreadable Review Candidate'],
  ]) {
    seedPipeline(userDataDir, {
      id,
      name,
      description: 'Shared similarity tokens',
      yaml: pipelineYaml({
        name,
        description: 'Shared similarity tokens',
      }),
    });
  }
  const indexPath = path.join(userDataDir, 'pipelines', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.pipelines.find((entry) => entry.id === unreadableId).triggerTypes = [
    'dispatch',
  ];
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  const unreadablePath = path.join(
    userDataDir,
    'pipelines',
    `${unreadableId}.yaml`,
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    chmodSync(unreadablePath, 0o000);
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(sourceId),
    );
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await expect(
      window.getByTestId(`similar-pipelines-section-item-user:${readableId}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`similar-pipelines-section-item-user:${unreadableId}`),
    ).toHaveCount(0);
  } finally {
    chmodSync(unreadablePath, 0o644);
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('switching saved pipelines cannot retain another pipeline raw YAML buffer', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2382-raw-'));
  for (const [id, name] of [
    [SOURCE_ID, 'Review Source'],
    [SIBLING_ID, 'Review Sibling'],
  ]) {
    seedPipeline(userDataDir, {
      id,
      name,
      description: 'Shared review text',
      yaml: pipelineYaml({ name, description: 'Shared review text' }),
    });
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(SOURCE_ID),
    );
    await window.getByTestId('pipeline-mode-raw').click();
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await window
      .getByTestId(`similar-pipelines-section-item-user:${SIBLING_ID}`)
      .click();
    // The sibling opens as its own item in the edit shell (CAN-4072), with
    // its settings closed.
    await expect(window.getByTestId('pipeline-editor-back')).toHaveText(
      'Pipeline',
    );
    await window.getByTestId('pipeline-editor-settings-toggle').click();
    await expect(
      window.getByTestId(`similar-pipelines-section-item-user:${SOURCE_ID}`),
    ).toBeVisible();
    await window.getByTestId('pipeline-mode-raw').click();
    const rawYaml = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(rawYaml).toContainText('name: Review Sibling');
    await expect(rawYaml).not.toContainText('name: Review Source');
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Resolves a semantic role to the `rgb()` string `getComputedStyle` reports,
 * so a hover assertion compares paint against paint instead of comparing a
 * class name against itself.
 */
async function resolveRole(window, role) {
  return window.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.append(probe);
    const painted = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return painted;
  }, role);
}

async function backgroundOf(locator) {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

test('bordered rows highlight under the pointer', async () => {
  // These rows are the only click targets on their surfaces and they painted
  // nothing on hover: `hover:bg-surface-hover` named a role no stylesheet
  // declares, so Tailwind emitted no rule and the class was removed as dead
  // (#3791). The check reads the PAINTED colour rather than the class list,
  // because a class that generates no CSS is exactly the failure mode here.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'row-hover-'));
  seedShareablePluginCache(userDataDir);
  seedInstalledSkillSource(userDataDir);
  seedPipeline(userDataDir, {
    id: SOURCE_ID,
    name: 'Structured Review Helper',
    description: 'Runs a structured code review on dispatch',
    yaml: pipelineYaml({
      name: 'Structured Review Helper',
      description: 'Runs a structured code review on dispatch',
      skillName: SKILL_NAME,
      pluginName: PLUGIN_NAME,
    }),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const subtle = await resolveRole(window, '--bg-subtle');

    // Shared `RelatedItemsSection` rows, on a skill detail.
    await app.openPluginsPage();
    await window.getByTestId('plugins-search').fill(SKILL_NAME);
    await window
      .getByTestId(`customize-row-skill:${SKILL_SOURCE_ID}:${SKILL_NAME}`)
      .click();
    const relatedRow = window.getByTestId(
      `related-pipelines-section-item-user:${SOURCE_ID}`,
    );
    await expect(relatedRow).toBeVisible();
    // Opening the detail can leave the pointer over this newly mounted row.
    await window.mouse.move(0, 0);
    await expect.poll(() => backgroundOf(relatedRow)).not.toBe(subtle);
    await relatedRow.hover();
    await expect.poll(() => backgroundOf(relatedRow)).toBe(subtle);

    // Pipeline settings: the trigger rows and the execution-scope rows.
    await openPipelineSettings(window, app, SOURCE_ID);
    for (const testId of [
      'pipeline-trigger-row-plan_ready',
      'pipeline-execution-scope-row-global',
    ]) {
      const row = window.getByTestId(testId);
      await expect(row).toBeVisible();
      await window.mouse.move(0, 0);
      await expect.poll(() => backgroundOf(row)).not.toBe(subtle);
      await row.hover();
      await expect.poll(() => backgroundOf(row)).toBe(subtle);
    }

    // The last remaining scope cannot be unchecked, so it stays flat rather
    // than promising a toggle that does nothing.
    const lastScope = window.getByTestId(
      'pipeline-execution-scope-row-directory',
    );
    await expect(
      window.getByTestId('pipeline-execution-scope-directory'),
    ).toBeDisabled();
    await lastScope.hover();
    await expect.poll(() => backgroundOf(lastScope)).not.toBe(subtle);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
