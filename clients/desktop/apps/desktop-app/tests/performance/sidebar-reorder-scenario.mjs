import { expect } from '@playwright/test';
import {
  seedSidebarReorderWorkspace,
  dragSidebarReorderRow,
  sidebarReorderRows,
} from '../electron/sidebarReorderFixture.mjs';
import { expandCoworkWorkspace } from '../electron/coworkWorkEntryDoneFixture.mjs';

export function prepareSidebarReorder(userDataDir) {
  return seedSidebarReorderWorkspace(userDataDir);
}

/** Same driver and fake inventory for baseline/candidate production bundles. */
export async function runSidebarReorder({
  page,
  app,
  electronApp,
  fixture,
  tasks,
}) {
  await app.waitForShell();
  await expandCoworkWorkspace(page, fixture.workspaceId);
  const rows = sidebarReorderRows(page);
  await expect(rows).toHaveCount(11);
  await page
    .getByTestId(`sidebar-work-entry-${fixture.ids[0]}`)
    .locator('p')
    .first()
    .click();
  await expect(
    page.getByTestId(`sidebar-work-entry-${fixture.ids[0]}`),
  ).toHaveAttribute('data-sidebar-selected-item', '');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.api.workEntries
          .list({ projectId: 'delivery-cowork' })
          .then((value) => value.entries.length),
      ),
    )
    .toBe(11);
  await electronApp.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get(
      'sidebar-item-groups:move-item',
    );
    globalThis.__reorderPerformance = {
      acknowledged: 0,
      trace: [],
      waiters: [],
    };
    for (const channel of [
      'work-entries:list',
      'sidebar-item-groups:list',
      'projects:load',
      'desktop:session-snapshot',
    ]) {
      const read = ipcMain._invokeHandlers.get(channel);
      if (!read) throw new Error(`Missing reorder trace handler ${channel}`);
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        globalThis.__reorderPerformance.trace.push({
          channel,
          stage: 'start',
          at: Date.now(),
        });
        const result = await read(...args);
        globalThis.__reorderPerformance.trace.push({
          channel,
          stage: 'end',
          at: Date.now(),
        });
        return result;
      });
    }
    ipcMain._invokeHandlers.set(
      'sidebar-item-groups:move-item',
      async (...args) => {
        globalThis.__reorderPerformance.trace.push({
          stage: 'save-admitted',
          at: Date.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const result = await original(...args);
        globalThis.__reorderPerformance.acknowledged += 1;
        globalThis.__reorderPerformance.trace.push({
          stage: 'save-acknowledged',
          at: Date.now(),
        });
        const state = globalThis.__reorderPerformance;
        const ready = state.waiters.filter(
          (waiter) => waiter.count <= state.acknowledged,
        );
        state.waiters = state.waiters.filter(
          (waiter) => waiter.count > state.acknowledged,
        );
        ready.forEach((waiter) => waiter.finish());
        return result;
      },
    );
  });
  const measurements = [];
  for (let iteration = 0; iteration < 33; iteration++) {
    const source = fixture.ids[iteration % 2 === 0 ? 4 : 1];
    const anchor = fixture.ids[iteration % 2 === 0 ? 1 : 4];
    await page.evaluate(
      ({ source, anchor }) => {
        const prefix = 'sidebar-work-entry-';
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        window.__reorderPaint = { promise };
        document.addEventListener(
          'pointerup',
          () => {
            const droppedAt = performance.now();
            const check = () => {
              const row = document.querySelector(
                `[data-testid="${prefix}${source}"]`,
              );
              const target = document.querySelector(
                `[data-testid="${prefix}${anchor}"]`,
              );
              if (
                row &&
                target &&
                row.getBoundingClientRect().top <
                  target.getBoundingClientRect().top
              ) {
                const firstPositionFrameAt = performance.now();
                const sourceY = row.getBoundingClientRect().top;
                const anchorY = target.getBoundingClientRect().top;
                requestAnimationFrame(() =>
                  resolve({
                    droppedAt,
                    timeOrigin: performance.timeOrigin,
                    firstPositionFrameAt,
                    sourceY,
                    anchorY,
                    paintedAt: performance.now(),
                    source,
                    anchor,
                  }),
                );
              } else if (performance.now() - droppedAt > 15000)
                resolve({
                  droppedAt,
                  error: 'No position paint within 15 seconds',
                });
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          },
          { once: true, capture: true },
        );
      },
      { source, anchor },
    );
    try {
      await dragSidebarReorderRow(page, source, anchor);
    } catch (error) {
      await page.screenshot({
        path: '.playwright/sidebar-reorder-lag/reorder-driver-failure.png',
      });
      const diagnostic = await page.evaluate(
        ({ source, iteration }) => {
          const row = document.querySelector(
            `[data-testid="sidebar-work-entry-${source}"]`,
          );
          const title = row?.querySelector('p');
          const rect = title?.getBoundingClientRect();
          return {
            iteration,
            title: title?.outerHTML,
            row: row?.outerHTML.slice(0, 2500),
            rect: rect?.toJSON(),
            hit: rect
              ? document
                  .elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2,
                  )
                  ?.outerHTML.slice(0, 1000)
              : null,
          };
        },
        { source, iteration },
      );
      throw new Error(`${String(error)}; ${JSON.stringify(diagnostic)}`);
    }
    const timing = await page.evaluate(() => window.__reorderPaint.promise);
    if (timing.error) {
      await page.screenshot({
        path: '.playwright/sidebar-reorder-lag/reorder-driver-failure.png',
      });
      const trace = await electronApp.evaluate(
        () => globalThis.__reorderPerformance,
      );
      throw new Error(
        `${timing.error}; iteration=${iteration}; ${JSON.stringify(trace)}`,
      );
    }
    const durationMs = timing.paintedAt - timing.droppedAt;
    if (iteration >= 3) {
      measurements.push(durationMs);
      tasks.push({
        kind: 'sidebar_reorder_drop_to_paint',
        status: 'ok',
        durationMs,
        iteration: iteration - 3,
        positionPaint: timing,
      });
    }
    await electronApp.evaluate(async (_electron, count) => {
      const state = globalThis.__reorderPerformance;
      if (state.acknowledged >= count) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Sidebar save acknowledgement timed out')),
          15000,
        );
        state.waiters.push({
          count,
          finish: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    }, iteration + 1);
    // Let the preceding projection settle before the next matched drop.
    await expect
      .poll(() =>
        page.evaluate(
          async ({ source, anchor, workspaceId }) => {
            const { entries } = await window.api.workEntries.list({
              projectId: workspaceId,
            });
            return (
              entries.findIndex((entry) => entry.id === source) <
              entries.findIndex((entry) => entry.id === anchor)
            );
          },
          { source, anchor, workspaceId: fixture.workspaceId },
        ),
      )
      .toBe(true);
  }
  const ordered = [...measurements].sort((a, b) => a - b);
  const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
  tasks.timings.sidebarReorderDropToPaintP95Ms = p95;
  tasks.push({
    kind: 'sidebar_reorder_drop_to_paint_p95',
    status: 'ok',
    durationMs: p95,
    responsivenessBudgetMs: 100,
    summary: true,
    delayedSaveMs: 5000,
    warmups: 3,
    measuredDrops: 30,
    stageTrace: await electronApp.evaluate(
      () => globalThis.__reorderPerformance.trace,
    ),
  });
  return {
    sidebarReorderDropToPaintP95Ms: p95,
    sidebarReorderDropToPaintSamples: measurements,
    sidebarReorderDelayedSaveMs: 5000,
    sidebarReorderWarmups: 3,
    sidebarReorderMeasuredDrops: 30,
  };
}
