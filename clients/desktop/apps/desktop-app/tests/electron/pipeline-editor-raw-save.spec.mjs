import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
  openWorkflowEditSection,
  saveWorkflowEdit,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';

// Spec 7 (PR 800): pipeline raw-YAML editor save.
//
// PR 800 changed the raw-mode Save affordance so that Save STAYS available when
// the raw YAML fails validation (instead of being disabled like in visual
// mode), and instead surfaces the validation message inline. Saving valid YAML
// then persists the pipeline.
//
// We reach the raw editor deterministically via the Library's "New workflow"
// menu, "When you start it, built by hand" (`workflows-new` ->
// `workflows-new-build`), which opens the Workflows edit shell (CAN-4072) on
// a pipeline draft (`pipelineId: null`) -> an editable default pipeline. No data seeding is
// required: the create flow is always available and always editable.
//
// Flow & testids exercised:
//   - openPipelinesPage()                -> `page-workflows-library`
//   - `workflows-new`                    -> opens the New workflow menu
//   - `workflows-new-build`              -> opens the editor on a blank pipeline
//   - `pipeline-mode-raw`                -> switches to raw mode, serializes
//                                            the pipeline into the textarea
//   - `pipeline-raw-yaml-textarea`       -> the editable raw-YAML field
//   - `pipeline-save`                    -> Save button
//   - `pipeline-raw-yaml-error`          -> inline validation error
//   - `workflows-library-row`            -> a `pipeline:user:` row, used to
//                                            confirm the saved pipeline landed
//                                            in the Library
test('raw-YAML editor keeps Save available on validation errors and persists valid YAML', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPipelinesPage();

    // Open the editor via the create flow (deterministic, no seeding needed).
    // "When you start it" starts the AI interview (CAN-3487); the manual
    // builder is the menu's "built by hand" entry.
    await app.startNewWorkflow('build');

    // Switch to raw mode. This serializes the default pipeline into the
    // textarea and resets the raw baseline.
    const rawModeButton = window.getByTestId('pipeline-mode-raw');
    await expect(rawModeButton).toBeVisible();
    await rawModeButton.click();

    const textarea = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(textarea).toBeVisible();
    // The default pipeline serializes with a top-level `pipeline:` document.
    await expect(textarea).toHaveValue(/pipeline:/);

    const saveButton = window.getByTestId('pipeline-save');
    await expect(saveButton).toBeVisible();

    // (a) Invalid YAML: `jobs` is a string instead of an object. This parses as
    // YAML but fails pipeline validation ("Pipeline must define a 'jobs'
    // object"). PR 800: Save must REMAIN available (visible + enabled) so the
    // user can re-attempt after fixing, and the inline error must appear.
    const invalidYaml = [
      'pipeline:',
      '  name: Broken Pipeline',
      '  jobs: oops',
    ].join('\n');
    await textarea.fill(invalidYaml);

    // Editing the textarea makes the raw view dirty, so Save is enabled.
    await expect(saveButton).toBeEnabled();

    await saveButton.click();

    // The inline raw-YAML error surfaces and Save stays available (PR 800).
    const rawError = window.getByTestId('pipeline-raw-yaml-error');
    await expect(rawError).toBeVisible();
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();

    await window.screenshot({
      path: testInfo.outputPath('raw-yaml-invalid-error.png'),
    });

    // (b) Valid YAML: a complete minimal pipeline with one job + one runnable
    // step. Saving should clear the error and persist the pipeline.
    const validYaml = [
      'pipeline:',
      '  name: E2E Raw Save Pipeline',
      "  version: '3.0'",
      '  description: Created by the raw-YAML save e2e spec',
      '  icon: "🧪"',
      '  on: dispatch',
      '  jobs:',
      '    main:',
      '      name: main',
      '      steps:',
      '        - id: step_1',
      '          name: Echo',
      '          run: echo hello',
    ].join('\n');
    await textarea.fill(validYaml);
    await expect(saveButton).toBeEnabled();

    await saveButton.click();

    // The inline error clears once the valid YAML is accepted + saved.
    await expect(rawError).toHaveCount(0);

    // After a successful save the raw baseline resets (asynchronously), so the
    // raw view is no longer dirty and the Save button returns to its disabled
    // state. The reset can lag under full-suite load, so allow extra time.
    await expect(saveButton).toBeDisabled({ timeout: 15_000 });

    await window.screenshot({
      path: testInfo.outputPath('raw-yaml-valid-saved.png'),
    });

    // Persistence: leave the Pipelines page entirely (which unmounts the
    // editor) and return so PipelinesPage remounts in its `list` view. The
    // saved pipeline should now appear as a row in the Library table.
    await app.openMainPage();
    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();
    // The user's own pipelines are the editable rows.
    const savedRow = window.locator(
      '[data-testid="workflows-library-row"][data-row-key^="pipeline:user:"]',
    );
    await expect(
      window.getByText('E2E Raw Save Pipeline', { exact: true }),
    ).toBeVisible();
    expect(await savedRow.count()).toBeGreaterThan(0);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// Removed legacy fan-out fields must surface migration guidance, while current
// matrix strategy fields and unevaluated expressions round-trip unchanged.
test('raw-YAML editor rejects legacy fan-out and round-trips matrix strategy', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPipelinesPage();
    // "When you start it" starts the AI interview (CAN-3487); the manual
    // builder is the menu's "built by hand" entry.
    await app.startNewWorkflow('build');

    const rawModeButton = window.getByTestId('pipeline-mode-raw');
    await expect(rawModeButton).toBeVisible();
    await rawModeButton.click();

    const textarea = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(textarea).toBeVisible();
    const saveButton = window.getByTestId('pipeline-save');
    const rawError = window.getByTestId('pipeline-raw-yaml-error');

    // (a) Legacy `foreach` and top-level `max_parallel` are rejected with
    // migration guidance rather than being persisted.
    const legacyFanout = [
      'pipeline:',
      '  name: E2E Legacy Fan-out',
      "  version: '3.0'",
      '  on: dispatch',
      '  jobs:',
      '    main:',
      '      name: main',
      '      foreach: [alpha, beta]',
      '      max_parallel: 3',
      '      steps:',
      '        - id: step_1',
      '          run: echo hello',
    ].join('\n');
    await textarea.fill(legacyFanout);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(rawError).toBeVisible();
    await expect(rawError).toContainText('uses removed field "foreach"');
    await expect(rawError).toContainText(
      'defines legacy top-level "max_parallel"',
    );

    // (b) Static and expression-backed matrices plus strategy.max_parallel are
    // supported and must survive the raw editor round trip.
    const matrixYaml = [
      'pipeline:',
      '  name: E2E Matrix Raw Save Pipeline',
      "  version: '3.0'",
      '  description: Created by the matrix raw-YAML round-trip e2e spec',
      '  icon: "🧪"',
      '  on: dispatch',
      '  jobs:',
      '    static_matrix:',
      '      name: Static matrix',
      '      strategy:',
      '        matrix:',
      '          item: [alpha, beta, gamma]',
      '          include:',
      '            - item: delta',
      '              tier: extra',
      '        max_parallel: 2',
      '      steps:',
      '        - id: step_1',
      '          run: echo "${{ matrix.item }}"',
      '    dynamic_matrix:',
      '      name: Dynamic matrix',
      '      strategy:',
      '        matrix: ${{ parseJson(inputs.matrix) }}',
      '        max_parallel: 3',
      '      steps:',
      '        - id: step_1',
      '          run: echo "${{ matrix.item }}"',
    ].join('\n');
    await textarea.fill(matrixYaml);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(rawError).toHaveCount(0);
    await expect(saveButton).toBeDisabled({ timeout: 15_000 });

    await window.screenshot({
      path: testInfo.outputPath('raw-yaml-matrix-saved.png'),
    });

    // Round trip: leave the page (unmounting the editor), come back, reopen the
    // saved pipeline in raw mode, and confirm both fields survived — including
    // the unevaluated expressions, which must NOT have been resolved or
    // rewritten.
    await app.openMainPage();
    await app.openPipelinesPage();
    await expect(window.getByTestId('workflows-library-table')).toBeVisible();
    await expect(
      window.getByText('E2E Matrix Raw Save Pipeline', { exact: true }),
    ).toBeVisible();

    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryRowByName('E2E Matrix Raw Save Pipeline'),
    );
    await window.getByTestId('pipeline-mode-raw').click();
    const reloaded = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(reloaded).toBeVisible();

    const reloadedYaml = await reloaded.inputValue();
    expect(reloadedYaml).toContain('strategy:');
    expect(reloadedYaml).toContain('matrix:');
    // Static axes and include entries survive.
    expect(reloadedYaml).toContain('alpha');
    expect(reloadedYaml).toContain('tier: extra');
    // Expressions survive verbatim — never evaluated in the renderer.
    expect(reloadedYaml).toContain('${{ parseJson(inputs.matrix) }}');
    // `max_parallel` survives at its supported strategy location.
    expect(reloadedYaml).toContain('max_parallel: 2');
    expect(reloadedYaml).toContain('max_parallel: 3');
    expect(reloadedYaml).not.toContain('foreach:');

    // Re-saving the untouched round-tripped YAML is still valid.
    await expect(window.getByTestId('pipeline-raw-yaml-error')).toHaveCount(0);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

test('duplicating the bundled multi-provider review preserves valid model aliases', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.chooseWorkflowsLibraryFilter('source', 'built-in');
    await app.chooseWorkflowsLibraryRowAction(
      app.workflowsLibraryPipelineRow(
        'bundled-code-review-multi-provider',
        'bundled',
      ),
      'duplicate',
    );
    await app.chooseWorkflowsLibraryFilter('source', 'mine');
    const copy = window
      .getByTestId('workflows-library-table')
      .getByRole('row')
      .filter({
        hasText: 'Code Review (Multi-Provider) (Copy)',
      });
    await expect(copy).toBeVisible();
    await app.openWorkflowsLibraryRow(copy);
    await expect(window.getByTestId('pipeline-mode-visual')).toBeVisible();
    await expect(
      window.getByText(/matches no defined model alias or known model/),
    ).toHaveCount(0);
    await window.getByTestId('pipeline-mode-raw').click();
    const textarea = window.getByTestId('pipeline-raw-yaml-textarea');
    await expect(textarea).toHaveValue(/\$cheap/);
    await expect(textarea).toHaveValue(/\$luna/);
    await expect(textarea).toHaveValue(/\$sol/);
    await expect(textarea).toHaveValue(/\$opus/);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-4072: the pipeline editor is the Definition section of the Workflows
// edit shell. Visited sections stay mounted while hidden, so unsaved raw text
// survives a trip to another section and still saves.
test('raw text survives a Trigger tab round trip and still saves', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-raw-save-sections-'),
  );
  const pipelineId = 'raw-save-sections';
  seedStoredPipeline({
    userDataDir,
    id: pipelineId,
    name: 'Raw Sections Pipeline',
    yaml: [
      'name: Raw Sections Pipeline',
      'on: dispatch',
      'scope: directory',
      'jobs:',
      '  main:',
      '    steps:',
      '      - run: echo before',
      '',
    ].join('\n'),
  });
  const yamlPath = path.join(userDataDir, 'pipelines', `${pipelineId}.yaml`);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPipelinesPage();
    await app.openWorkflowsLibraryRow(
      app.workflowsLibraryPipelineRow(pipelineId),
    );

    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toHaveAttribute('data-kind', 'pipeline');
    await expect(shell).toHaveAttribute('data-dirty', 'false');
    const definition = shell.getByTestId('workflow-edit-section-definition');
    await definition.getByTestId('pipeline-mode-raw').click();
    const textarea = definition.getByTestId('pipeline-raw-yaml-textarea');
    await expect(textarea).toHaveValue(/echo before/);

    // Type into the raw text so only the raw buffer holds the edit.
    const original = await textarea.inputValue();
    await textarea.fill(original.replace('echo before', 'echo after'));
    await expect(textarea).toHaveValue(/echo after/);
    await expect(shell).toHaveAttribute('data-dirty', 'true');

    // Definition -> Trigger -> Definition keeps the raw mode, the unsaved
    // text and the dirty state.
    const trigger = await openWorkflowEditSection(window, 'trigger');
    await expect(
      trigger.getByTestId('pipeline-trigger-automations-empty'),
    ).toBeVisible();
    await expect(definition).toBeHidden();
    await expect(shell).toHaveAttribute('data-dirty', 'true');
    await openWorkflowEditSection(window, 'definition');
    await expect(trigger).toBeHidden();
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue(/echo after/);
    await expect(textarea).not.toHaveValue(/echo before/);
    await expect(shell).toHaveAttribute('data-dirty', 'true');
    expect(readFileSync(yamlPath, 'utf8')).toContain('echo before');

    // Save writes the raw text and leaves the shell clean on the pipeline.
    await saveWorkflowEdit(window);
    await expect
      .poll(() => readFileSync(yamlPath, 'utf8'))
      .toContain('echo after');
    await expect(shell.getByTestId('pipeline-save')).toBeDisabled();
    await expect(window.getByTestId('pipeline-raw-yaml-error')).toHaveCount(0);
    await expect(textarea).toHaveValue(/echo after/);
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});
