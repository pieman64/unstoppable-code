// Color modes: run each documented stage normally for light, then append `--dark-mode` for dark.
// @capture-keep: before/after evidence for the sidebar's sticky header stack, which this area has reshaped repeatedly
// @capture-reference: docs/cowork-workspaces.md
/**
 * CAN-2363 — the sidebar's top-level Chats section.
 *
 * What changed: the default Cowork workspace (the catch-all for project-less
 * chats) no longer renders as a workspace row inside the Projects list. Its
 * Work Entries render flat under a new top-level "Chats" section placed after
 * the project rows, and that header is a sticky accordion — docked to the
 * scroll viewport's bottom edge while its list is below the fold, pinned under
 * the stuck Projects band once the project rows scroll past. Projects and
 * Chats are therefore both visible at every scroll offset.
 *
 * Run both stages from the repo root:
 *
 *   CAN2363_STAGE=before pnpm run test:electron:captures:built can-2363-chats-section.capture-spec.ts --reporter=line
 *   CAN2363_STAGE=before pnpm run test:electron:captures:built can-2363-chats-section.capture-spec.ts --reporter=line --dark-mode
 *   # apply the change, then rebuild with `pnpm run build:e2e`
 *   CAN2363_STAGE=after  pnpm run test:electron:captures:built can-2363-chats-section.capture-spec.ts --reporter=line
 *   CAN2363_STAGE=after  pnpm run test:electron:captures:built can-2363-chats-section.capture-spec.ts --reporter=line --dark-mode
 *
 * In the `before` stage the Chats section does not exist — the default
 * workspace is just another row in the list — so the spec captures the same
 * two viewport states without requiring it.
 *
 * Determinism: one seeded git repo with twelve worktrees, one named Cowork
 * workspace, and the default Cowork workspace with ten chat transcripts, all
 * written to a test-scoped data dir before launch. No live agents, no network.
 * The sidebar is scrolled to fixed offsets and allowed to settle before each
 * element screenshot, which is taken with `animations: 'disabled'`.
 *
 * One wrinkle is worth knowing about: the sticky Projects band and the Chats
 * header occlude rows through scroll-timeline CSS animations, and disabling
 * animations fast-forwards those to their end state — painting the clip for
 * the wrong scroll offset and inventing overlap that does not exist in the
 * running app. `freezeScrollDrivenClips` therefore pins each clip's computed
 * value as an inline style for the settled offset before the screenshot, and
 * releases it afterwards, so the capture is both deterministic and faithful.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';

const STAGE = process.env.CAN2363_STAGE === 'before' ? 'before' : 'after';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-2363-chats-section');

/**
 * Pin the scroll-driven occlusion clips to their current computed values so a
 * screenshot taken with animations disabled shows the clip for the settled
 * scroll offset rather than the animation's end state. Returns a release
 * function that restores the animated values.
 */
async function freezeScrollDrivenClips(window: {
  evaluate: <T>(
    fn: (selectors: string[]) => T,
    selectors: string[],
  ) => Promise<T>;
}): Promise<() => Promise<void>> {
  const selectors = [
    '.sidebar-workspaces-rows-clip',
    '.sidebar-trailing-rows-clip',
  ];
  await window.evaluate((clipSelectors: string[]) => {
    for (const selector of clipSelectors) {
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      )) {
        element.style.clipPath = getComputedStyle(element).clipPath;
      }
    }
  }, selectors);
  return async (): Promise<void> => {
    await window.evaluate((clipSelectors: string[]) => {
      for (const selector of clipSelectors) {
        for (const element of Array.from(
          document.querySelectorAll<HTMLElement>(selector),
        )) {
          element.style.removeProperty('clip-path');
        }
      }
    }, selectors);
  };
}

async function settleSidebar(viewport: {
  evaluate: (fn: (element: HTMLElement) => Promise<void>) => Promise<void>;
}): Promise<void> {
  await viewport.evaluate(async (element: HTMLElement) => {
    let previousScrollTop = element.scrollTop;
    let stableSince = performance.now();
    const deadline = stableSince + 5_000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const nextScrollTop = element.scrollTop;
      if (Math.abs(nextScrollTop - previousScrollTop) > 0.01) {
        stableSince = performance.now();
      }
      previousScrollTop = nextScrollTop;
      if (performance.now() - stableSince >= 800) break;
    }
  });
}

test('captures the Chats section at rest and scrolled', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(path.join(captureDir, 'videos'), { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2363-capture-'),
  );
  seedChatsSectionFixture(userDataDir);

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 560 },
    recordVideoDir: path.join(captureDir, 'videos'),
  });

  let video: ReturnType<
    Awaited<ReturnType<typeof electronApp.firstWindow>>['video']
  >;
  try {
    const window = await electronApp.firstWindow();
    video = window.video();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const viewport = window.getByTestId('sidebar-scroll-container');
    await viewport.waitFor({ state: 'visible' });
    await viewport.evaluate((element: HTMLElement) => {
      element.scrollTop = 0;
    });
    await settleSidebar(viewport);

    // 1. Top of the list. After the change the Chats header is docked to the
    //    sidebar's bottom edge below the project rows; before it, the default
    //    workspace is an ordinary row somewhere in the list.
    const releaseTopClips = await freezeScrollDrivenClips(window);
    await sidebar.screenshot({
      path: path.join(captureDir, `chats-section-top-${STAGE}.png`),
      animations: 'disabled',
    });
    await releaseTopClips();

    // 2. Scrolled to the bottom. After the change the Chats header is pinned
    //    under the Projects band with its entries listed beneath it.
    await viewport.evaluate((element: HTMLElement) => {
      element.scrollTop = element.scrollHeight;
    });
    await settleSidebar(viewport);
    const releaseScrolledClips = await freezeScrollDrivenClips(window);
    await sidebar.screenshot({
      path: path.join(captureDir, `chats-section-scrolled-${STAGE}.png`),
      animations: 'disabled',
    });
    await releaseScrolledClips();

    // 3. A paced scroll so the recording shows the header handing off from the
    //    bottom edge to the Projects band rather than jumping.
    await viewport.evaluate((element: HTMLElement) => {
      element.scrollTop = 0;
    });
    await settleSidebar(viewport);
    const steps = 14;
    for (let step = 1; step <= steps; step += 1) {
      await viewport.evaluate((element: HTMLElement, fraction: number) => {
        element.scrollTop =
          (element.scrollHeight - element.clientHeight) * fraction;
      }, step / steps);
      await window.waitForTimeout(220);
    }
    await settleSidebar(viewport);
  } finally {
    try {
      await closeCanopy(electronApp, userDataDir);
    } finally {
      // Read the recording back so the flow lands on a stable, stage-named
      // path the report can link, instead of Playwright's hashed filename.
      if (video) {
        const videoPath = path.join(
          captureDir,
          'videos',
          `scroll-flow-${STAGE}.webm`,
        );
        const rawVideoPath = await video.path();
        await video.saveAs(videoPath);
        if (rawVideoPath !== videoPath) {
          rmSync(rawVideoPath, { force: true });
        }
      }
    }
  }
});
