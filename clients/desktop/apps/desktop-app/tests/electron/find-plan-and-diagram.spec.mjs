// Cmd/Ctrl+F in plan panels and the change diagram (CAN-4367).
//
// The shared find bar (CAN-3048) searches the plan document in plan mode and
// a plan diagram in diagram mode; the in-panel plan search is gone.
//   F1 The plan document: Cmd/Ctrl+F opens the bar in plan mode over the
//      document, highlights in the panel's window, Escape clears and returns
//      focus to the panel, and the chord reopens with the remembered query.
//   F2 The joined panel's Diagram tab: switching tabs closes the bar; the
//      Diagram tab searches in diagram mode with the active-node ring,
//      Enter and Shift+Enter wrap, and each tab keeps its own query.
//   F3 Split: the document and the split diagram are both offered, and
//      each keeps its query.
//   F4 A popped-out diagram panel opens its own bar in its own window.
// The change diagram's bar is covered in `code-review.spec.mjs`.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { DEFAULT_GROUP_IDS } from './panelHarness.mjs';
import {
  buildPanelPlan,
  choosePlanFromMenu,
  closeAuxWindows,
  planDiagramPanel,
  planDocumentPanel,
  planGroupOf,
  popOutGroup,
  seedPlanPanelWorktree,
} from './planPanelHarness.mjs';

const ROADMAP = 'plan-roadmap';

function seededPlans() {
  return [
    buildPanelPlan({
      id: ROADMAP,
      title: 'Ship plan panels',
      updatedAt: '2026-06-03T00:00:00.000Z',
      withDiagrams: true,
    }),
  ];
}

/** Ready sequence diagram nodes inside `scope`. */
function sequenceNodes(scope) {
  return scope
    .getByTestId('plan-sequence-diagram')
    .locator('.react-flow__node');
}

/** The active-match ring on a sequence diagram node inside `scope`. */
function sequenceNodeBox(scope, nodeId) {
  return scope.locator(`.react-flow__node[data-id="${nodeId}"] > div`).first();
}

/**
 * Ranges in the find highlights named `<prefix>…`, read from the registry of
 * the window that owns `locator` (a popped-out panel paints its own).
 */
function findHighlightCount(locator, prefix) {
  return locator.evaluate((element, namePrefix) => {
    const registry = element.ownerDocument.defaultView.CSS.highlights;
    let count = 0;
    for (const [name, highlight] of registry) {
      if (name.startsWith(namePrefix)) count += highlight.size;
    }
    return count;
  }, prefix);
}

/** `<n> of <total>` → total, from the bar's counter. */
async function totalMatches(bar) {
  const match = /\d+ of (\d+)/.exec((await bar.textContent()) ?? '');
  return match ? Number(match[1]) : 0;
}

test.describe('plan and diagram find (CAN-4367)', () => {
  test.setTimeout(180_000);

  test('F1–F2: the joined plan panel searches its shown tab through the find bar', async () => {
    const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
      plans: seededPlans(),
    });

    try {
      await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
      const doc = planDocumentPanel(window, ROADMAP);
      const view = doc.getByTestId('plan-panel-view');
      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');
      await expect(view).toBeVisible();
      await expect(view).toHaveAttribute('data-plan-inner-tab', 'document');

      // --- F1: plan mode over the document ---------------------------------
      await expect(doc.getByTestId('content-search-toggle')).toHaveCount(0);
      await doc.getByTestId('plan-explore-plan-panel').click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'plan');
      await expect(input).toHaveAttribute('placeholder', 'Search the plan.');
      await expect(input).toBeFocused();
      await input.fill('baseline');
      await expect(bar).toContainText('1 of 1');
      await expect
        .poll(() => findHighlightCount(view, 'plan-find-matches-'))
        .toBe(1);

      await input.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect
        .poll(() => findHighlightCount(view, 'plan-find-matches-'))
        .toBe(0);
      await expect(view).toBeFocused();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(input).toHaveValue('baseline');
      await expect(bar).toContainText('1 of 1');

      // --- F2: switching tabs closes the bar --------------------------------
      await doc.getByTestId('plan-panel-tab-diagram').click();
      await expect(view).toHaveAttribute('data-plan-inner-tab', 'diagram');
      await expect(bar).toHaveCount(0);
      // The hidden document keeps no highlight.
      await expect
        .poll(() => findHighlightCount(view, 'plan-find-matches-'))
        .toBe(0);

      // Diagram mode from inside the diagram canvas.
      const baselineNode = sequenceNodeBox(doc, `${ROADMAP}-task-1-2`);
      await expect(sequenceNodes(doc)).not.toHaveCount(0);
      await sequenceNodes(doc).first().click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'diagram');
      await expect(input).toHaveAttribute('placeholder', 'Search the diagram.');
      await expect(input).toHaveValue('');
      await input.fill('baseline');
      await expect(bar).toContainText('1 of 1');
      await expect(baselineNode).toHaveClass(/ring-2/);

      // Several matches: Enter advances, Shift+Enter and Enter wrap.
      await input.fill('the');
      // Wait out the debounce: the counter still reads the last query's.
      await expect.poll(() => totalMatches(bar)).toBeGreaterThan(1);
      const total = await totalMatches(bar);
      await expect(bar).toContainText(`1 of ${total}`);
      await input.press('Enter');
      await expect(bar).toContainText(`2 of ${total}`);
      await input.press('Shift+Enter');
      await input.press('Shift+Enter');
      await expect(bar).toContainText(`${total} of ${total}`);
      await input.press('Enter');
      await expect(bar).toContainText(`1 of ${total}`);

      // Escape clears the active ring.
      await input.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(doc.locator('.react-flow__node > div.ring-2')).toHaveCount(
        0,
      );

      // Each tab keeps its own query.
      await doc.getByTestId('plan-panel-tab-document').click();
      await doc.getByTestId('plan-explore-plan-panel').click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'plan');
      await expect(input).toHaveValue('baseline');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('F3–F4: split and popped-out diagram panels get the bar in diagram mode', async () => {
    const { electronApp, userDataDir, window } = await seedPlanPanelWorktree({
      plans: seededPlans(),
    });

    try {
      await choosePlanFromMenu(window, DEFAULT_GROUP_IDS.chat, ROADMAP);
      const doc = planDocumentPanel(window, ROADMAP);
      await expect(doc.getByTestId('plan-panel-view')).toBeVisible();
      await doc.getByTestId('plan-panel-split').click();
      const diagram = planDiagramPanel(window, ROADMAP);
      await expect(sequenceNodes(diagram)).not.toHaveCount(0);
      // The split diagram has no search row of its own.
      await expect(diagram.getByTestId('content-search-toggle')).toHaveCount(0);
      await expect(
        diagram.getByTestId('plan-diagram-panel-top-row'),
      ).toHaveCount(0);

      const bar = window.getByTestId('surface-find-bar');
      const input = bar.getByRole('textbox');

      // --- F3: the document and its split diagram ---------------------------
      await doc.getByTestId('plan-explore-plan-panel').click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'plan');
      await expect(window.getByTestId('surface-find-mode-plan')).toBeVisible();
      await expect(
        window.getByTestId('surface-find-mode-diagram'),
      ).toBeVisible();
      await input.fill('baseline');
      await expect(bar).toContainText('1 of 1');

      await window.getByTestId('surface-find-mode-diagram').click();
      await expect(bar).toHaveAttribute('data-find-mode', 'diagram');
      // Switching modes carries the query over.
      await expect(input).toHaveValue('baseline');
      await expect(bar).toContainText('1 of 1');
      await expect(sequenceNodeBox(diagram, `${ROADMAP}-task-1-2`)).toHaveClass(
        /ring-2/,
      );
      await input.fill('fixtures');
      await expect(bar).toContainText('1 of 1');
      await expect(sequenceNodeBox(diagram, `${ROADMAP}-task-1-1`)).toHaveClass(
        /ring-2/,
      );
      await input.press('Escape');
      await expect(bar).toHaveCount(0);

      // Each keeps its query across close and reopen.
      await sequenceNodes(diagram).first().click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'diagram');
      await expect(input).toHaveValue('fixtures');
      await input.press('Escape');
      await doc.getByTestId('plan-explore-plan-panel').click();
      await window.keyboard.press('ControlOrMeta+f');
      await expect(bar).toHaveAttribute('data-find-mode', 'plan');
      await expect(input).toHaveValue('baseline');
      await input.press('Escape');

      // --- F4: popped out, the diagram's bar opens in its own window --------
      const diagramGroup = await planGroupOf(
        electronApp,
        window,
        ROADMAP,
        'plan-diagram',
      );
      const aux = await popOutGroup(electronApp, window, diagramGroup);
      const auxDiagram = planDiagramPanel(aux, ROADMAP);
      await expect(sequenceNodes(auxDiagram)).not.toHaveCount(0);
      await sequenceNodes(auxDiagram).first().click();
      await aux.keyboard.press('ControlOrMeta+f');
      const auxBar = aux.getByTestId('surface-find-bar');
      await expect(auxBar).toHaveAttribute('data-find-mode', 'diagram');
      await expect(bar).toHaveCount(0);
      await auxBar.getByRole('textbox').fill('baseline');
      await expect(auxBar).toContainText('1 of 1');
      await expect(
        sequenceNodeBox(auxDiagram, `${ROADMAP}-task-1-2`),
      ).toHaveClass(/ring-2/);
      await closeAuxWindows(electronApp);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
