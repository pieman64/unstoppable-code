import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const FILE_TAB_ID = 'file-comments-tab';
const CHAT_TAB_ID = 'file-comments-chat-tab';
const FILE_NAME = 'FILE_COMMENTS.ts';
const FILE_CONTENT = [
  'const alpha = "select this text for a file comment";',
  'const beta = alpha.toUpperCase();',
  'export { beta };',
  '',
].join('\n');

// CAN-3518: a long Markdown file must stay scrollable after a comment mounts
// the comments tray and an annotation marker.
const LONG_MD_TAB_ID = 'file-comments-long-markdown-tab';
const LONG_MD_FILE_NAME = 'FILE_COMMENTS_LONG.md';
const LONG_MD_PARAGRAPH_COUNT = 150;
const LONG_MD_FINAL_PARAGRAPH =
  'Closing-marker paragraph: the very last line of this long document.';

// Every few words repeat the paragraph id, so any partial selection of one
// paragraph is unique in the raw file and resolves to a marked line.
function longMarkdownParagraph(index) {
  const id = String(index).padStart(3, '0');
  return `Topic-${id} holds entry ${id} so part ${id} of selection ${id} stays unique ${id}.`;
}

const LONG_MD_CONTENT = [
  ...Array.from({ length: LONG_MD_PARAGRAPH_COUNT }, (_, index) =>
    longMarkdownParagraph(index + 1),
  ),
  LONG_MD_FINAL_PARAGRAPH,
  '',
].join('\n\n');

function seedLongMarkdownTab() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-comments-md-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, LONG_MD_FILE_NAME);
  writeFileSync(filePath, LONG_MD_CONTENT, 'utf8');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: LONG_MD_TAB_ID,
    // Seed a chat tab too: a worktree with only a file tab gets a chat tab
    // created and brought to the front at an unpredictable moment, which would
    // hide the viewer mid-test.
    lastActiveEditableChatId: CHAT_TAB_ID,
    tabs: [
      {
        id: LONG_MD_TAB_ID,
        title: LONG_MD_FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'preview',
        description: filePath,
        messages: [],
      },
      { id: CHAT_TAB_ID, title: 'Chat' },
    ],
  });
  return userDataDir;
}

async function openLongMarkdown(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  // Open the file through its tab so the viewer is the visible panel.
  await window.getByTestId(`panel-tab-panel-file-${LONG_MD_TAB_ID}`).click();
  await expect(window.getByTestId('file-viewer-markdown-scroll')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    window
      .getByTestId('file-markdown-preview')
      .getByText(longMarkdownParagraph(1), { exact: true }),
  ).toBeVisible();
  return window;
}

/** Drag-selects the start of a rendered paragraph and stages a comment on it. */
async function stageRenderedSelectionComment(window, paragraphText, body) {
  const paragraph = window
    .getByTestId('file-markdown-preview')
    .getByText(paragraphText, { exact: true });
  const selectionMenu = window.getByTestId('file-selection-menu');
  const composer = window.locator('textarea[placeholder^="Add a comment"]');
  await expect(async () => {
    await expect(paragraph).toBeInViewport({ timeout: 2_000 });
    const box = await paragraph.boundingBox();
    expect(box, `bounds of "${paragraphText}"`).toBeTruthy();
    // Stay on the first rendered line in case the paragraph wraps.
    const y = box.y + Math.min(10, box.height / 2);
    await window.mouse.move(box.x + 2, y);
    await window.mouse.down();
    await window.mouse.move(box.x + Math.min(box.width - 5, 260), y, {
      steps: 10,
    });
    await window.mouse.up();
    await expect(selectionMenu).toBeVisible({ timeout: 2_000 });
    // Opening the composer stays inside the retry: the viewer closes its
    // popover when the file's diff context first resolves, which can land
    // between the selection and this click.
    await window
      .getByTestId('file-selection-comment')
      .click({ timeout: 2_000 });
    await expect(composer).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  await composer.fill(body);
  await window.getByTestId('review-comment-submit-draft').click();
  await expect(window.getByTestId('file-comments-drawer')).toContainText(body);
}

/**
 * Boxes of the annotation surface, the active scroll container, and the tray,
 * plus the scroll metrics of that container. `scrollTestId` selects the
 * rendered Markdown scroller or the raw Monaco host.
 */
function readFileViewerGeometry(window, scrollTestId) {
  return window.evaluate((testId) => {
    const box = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    const scroller = document.querySelector(`[data-testid="${testId}"]`);
    return {
      surface: box(
        document.querySelector(
          '[data-testid="file-viewer-annotation-surface"]',
        ),
      ),
      scroller: box(scroller),
      tray: box(document.querySelector('[data-testid="file-comments-drawer"]')),
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null,
      clientWidth: scroller?.clientWidth ?? null,
      offsetWidth: scroller?.offsetWidth ?? null,
    };
  }, scrollTestId);
}

function waitForNextPaint(window) {
  return window.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
      }),
  );
}

// Consecutive wheels that leave Monaco's scroll position unchanged before the
// raw-view loop gives up short of the end; a stuck editor then fails the
// end-of-file assertion.
const RAW_WHEEL_STALL_LIMIT = 5;

/**
 * Monaco's own scroll position, read from the editor DOM: the lines layer sits
 * at `-scrollTop`, and the vertical slider touches the track's bottom near the
 * maximum scroll position. Monaco rounds the slider, so `atEnd` can turn true
 * a few pixels early; callers confirm the end by a wheel that no longer moves.
 */
function readMonacoScroll(editor) {
  return editor.evaluate((host) => {
    const linesContent = host.querySelector('.lines-content');
    const track = host.querySelector(
      '.editor-scrollable > .scrollbar.vertical',
    );
    const slider = track?.querySelector('.slider');
    const scrollTop = -Number.parseFloat(linesContent?.style.top || '0');
    const trackHeight = track?.getBoundingClientRect().height ?? 0;
    const sliderTop = Number.parseFloat(slider?.style.top || '0');
    const sliderHeight = slider?.getBoundingClientRect().height ?? 0;
    return {
      scrollTop,
      trackHeight,
      sliderTop,
      sliderHeight,
      atEnd:
        trackHeight > 0 &&
        sliderHeight > 0 &&
        sliderTop + sliderHeight >= trackHeight - 1,
    };
  });
}

/** The visible scroll container must sit inside the surface, above the tray. */
function expectScrollerFitsAboveTray(geometry, label) {
  const detail = `${label}: ${JSON.stringify(geometry)}`;
  expect(geometry.surface, detail).toBeTruthy();
  expect(geometry.scroller, detail).toBeTruthy();
  expect(geometry.tray, detail).toBeTruthy();
  expect(geometry.scroller.top, detail).toBeGreaterThanOrEqual(
    geometry.surface.top - 0.5,
  );
  expect(geometry.scroller.bottom, detail).toBeLessThanOrEqual(
    geometry.surface.bottom + 0.5,
  );
  expect(geometry.surface.bottom, detail).toBeLessThanOrEqual(
    geometry.tray.top + 0.5,
  );
  expect(geometry.scroller.height, detail).toBeGreaterThan(40);
}

test('a long Markdown file scrolls to its end with the comments tray open', async () => {
  const userDataDir = seedLongMarkdownTab();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await openLongMarkdown(electronApp);
    const scroller = window.getByTestId('file-viewer-markdown-scroll');
    const readRendered = () =>
      readFileViewerGeometry(window, 'file-viewer-markdown-scroll');

    const beforeComment = await readRendered();
    expect(
      beforeComment.scrollHeight,
      `rendered Markdown overflows: ${JSON.stringify(beforeComment)}`,
    ).toBeGreaterThan(beforeComment.clientHeight * 2);

    await stageRenderedSelectionComment(
      window,
      longMarkdownParagraph(3),
      'First comment near the top.',
    );
    await expect(window.getByTestId('file-comments-submit')).toHaveText(
      'Submit 1 comment',
    );
    await expect(
      window.locator('[aria-label="File annotations"] button'),
    ).toHaveCount(1);

    expectScrollerFitsAboveTray(await readRendered(), 'rendered with tray');

    // Wheel over the document until the scroll position itself reaches the end.
    const scrollerBox = await scroller.boundingBox();
    expect(scrollerBox, 'rendered scroll container bounds').toBeTruthy();
    await window.mouse.move(
      scrollerBox.x + scrollerBox.width / 2,
      scrollerBox.y + scrollerBox.height / 2,
    );
    const atEnd = (geometry) =>
      geometry.scrollTop + geometry.clientHeight >= geometry.scrollHeight - 1;
    let rendered = await readRendered();
    for (let attempt = 0; attempt < 80 && !atEnd(rendered); attempt += 1) {
      await window.mouse.wheel(0, 1_200);
      await waitForNextPaint(window);
      rendered = await readRendered();
    }
    await expect
      .poll(async () => atEnd(await readRendered()), {
        message: `wheel scrolling reaches the end: ${JSON.stringify(rendered)}`,
        timeout: 5_000,
      })
      .toBe(true);
    // The position must hold; a scroll restore would move it back.
    await waitForNextPaint(window);
    rendered = await readRendered();
    expect(atEnd(rendered), JSON.stringify(rendered)).toBe(true);

    const finalParagraph = window
      .getByTestId('file-markdown-preview')
      .getByText(LONG_MD_FINAL_PARAGRAPH, { exact: true });
    await expect(finalParagraph).toBeInViewport();
    const finalBox = await finalParagraph.boundingBox();
    expect(finalBox, 'final paragraph bounds').toBeTruthy();
    expect(
      finalBox.y + finalBox.height,
      `final paragraph sits above the tray: ${JSON.stringify(rendered)}`,
    ).toBeLessThanOrEqual(rendered.scroller.bottom + 0.5);

    await stageRenderedSelectionComment(
      window,
      LONG_MD_FINAL_PARAGRAPH,
      'Second comment near the end.',
    );
    await expect(window.getByTestId('file-comments-submit')).toHaveText(
      'Submit 2 comments',
    );
    await expect(
      window.locator('[data-testid^="file-comment-thread-"]'),
    ).toHaveCount(2);

    // Raw view: the editor must fit above the tray and reach the last line.
    await window.getByTestId('file-view-toggle-source').click();
    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId('file-comments-drawer')).toBeVisible();
    await expect(editor.locator('.view-line').first()).toBeVisible();
    const raw = await readFileViewerGeometry(window, 'monaco-file-editor');
    expectScrollerFitsAboveTray(raw, 'raw with tray');

    const editorBox = await editor.boundingBox();
    expect(editorBox, 'raw editor bounds').toBeTruthy();
    await window.mouse.move(
      editorBox.x + editorBox.width / 2,
      editorBox.y + editorBox.height / 2,
    );
    // Monaco virtualizes lines, so the final line only exists once scrolled to.
    // Its per-wheel distance varies by host (as little as 50px per event), so
    // wheel until its own scroll position reaches the end, not a fixed count.
    const readRawScroll = () => readMonacoScroll(editor);
    const finalLine = editor
      .locator('.view-line')
      .filter({ hasText: 'Closing-marker paragraph' });
    // Once the slider reports the end, one wheel that no longer moves the
    // editor confirms the true maximum past the slider's rounding.
    let rawScroll = await readRawScroll();
    let stalledWheels = 0;
    let wheels = 0;
    while (stalledWheels < (rawScroll.atEnd ? 1 : RAW_WHEEL_STALL_LIMIT)) {
      const previousTop = rawScroll.scrollTop;
      await window.mouse.wheel(0, 1_200);
      await waitForNextPaint(window);
      wheels += 1;
      rawScroll = await readRawScroll();
      stalledWheels = rawScroll.scrollTop > previousTop ? 0 : stalledWheels + 1;
    }
    await expect
      .poll(async () => (await readRawScroll()).atEnd, {
        message: `wheel scrolling reaches the raw end (loop ended after ${wheels} wheels at ${JSON.stringify(rawScroll)})`,
        timeout: 5_000,
      })
      .toBe(true);
    await expect(finalLine).toBeVisible();
    await expect(async () => {
      const lineBox = await finalLine.boundingBox();
      expect(lineBox, 'final raw line bounds').toBeTruthy();
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(
        raw.surface.bottom + 0.5,
      );
    }).toPass({ timeout: 5_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const scrollbarMode of ['overlay', 'always']) {
  test(`Markdown annotation markers leave the ${scrollbarMode} scrollbar gutter usable`, async () => {
    const userDataDir = seedLongMarkdownTab();
    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await openLongMarkdown(electronApp);
      const readRendered = () =>
        readFileViewerGeometry(window, 'file-viewer-markdown-scroll');

      await stageRenderedSelectionComment(
        window,
        longMarkdownParagraph(3),
        'Comment that adds an annotation marker.',
      );
      const marker = window.locator('[aria-label="File annotations"] button');
      await expect(marker).toHaveCount(1);

      // Exercise both CSS rail geometries on the same host. The always-visible
      // mode uses the native 15px width when the OS provides no measured width.
      await window.evaluate((mode) => {
        document.documentElement.dataset.scrollbars = mode;
      }, scrollbarMode);

      const geometry = await readRendered();
      // The app styles native scrollbars as space-taking rails, so the gutter is
      // the strip between the scroller's content box and its border box.
      const gutterWidth = geometry.offsetWidth - geometry.clientWidth;
      expect(
        gutterWidth,
        `scrollbar gutter width: ${JSON.stringify(geometry)}`,
      ).toBe(scrollbarMode === 'always' ? 15 : 10);
      const gutterLeft = geometry.scroller.right - gutterWidth;
      const gutterCenterX = geometry.scroller.right - gutterWidth / 2;

      const markerBox = await marker.boundingBox();
      expect(markerBox, 'annotation marker bounds').toBeTruthy();
      const markerCenterY = markerBox.y + markerBox.height / 2;

      // Hit targets across the gutter, at several heights and beside the marker.
      // A hit on the scroller itself means the scrollbar receives the pointer;
      // this is evidence about obstruction, not proof that dragging works.
      const sampleYs = [
        ...[0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map(
          (fraction) =>
            geometry.scroller.top + geometry.scroller.height * fraction,
        ),
        markerCenterY,
      ];
      const sampleXs = Array.from(
        { length: Math.round(gutterWidth) },
        (_, index) => gutterLeft + index + 0.5,
      );
      const gutterHits = await window.evaluate(
        ({ xs, ys }) => {
          const surfaceNode = document.querySelector(
            '[data-testid="file-viewer-annotation-surface"]',
          );
          const scrollerNode = document.querySelector(
            '[data-testid="file-viewer-markdown-scroll"]',
          );
          const describe = (element) =>
            `${element.tagName.toLowerCase()}[${element.getAttribute('aria-label') ?? element.getAttribute('data-testid') ?? String(element.className).slice(0, 80)}]`;
          const blocked = [];
          const foreign = new Set();
          for (const y of ys) {
            for (const x of xs) {
              const hit = document.elementFromPoint(x, y);
              if (hit === scrollerNode) continue;
              if (hit && surfaceNode?.contains(hit)) {
                blocked.push({ x, y: Math.round(y), hit: describe(hit) });
              } else {
                foreign.add(hit ? `${describe(hit)}@x=${x}` : `none@x=${x}`);
              }
            }
          }
          return { blocked, foreign: [...foreign] };
        },
        { xs: sampleXs, ys: sampleYs },
      );
      // Only the viewer's own layers count: the panel's resize sash overlaps
      // the outer edge of the rail and belongs to the panel layout.
      expect
        .soft(
          gutterHits.blocked,
          `viewer elements covering the scrollbar gutter (other overlays: ${JSON.stringify(gutterHits.foreign)})`,
        )
        .toEqual([]);

      // The marker button is checked separately from the gutter: a
      // pointer-transparent strip still contains an interactive button.
      expect
        .soft(
          markerBox.x + markerBox.width,
          `marker stays out of the gutter (gutter starts at ${gutterLeft})`,
        )
        .toBeLessThanOrEqual(gutterLeft + 0.5);
      const markerHit = await window.evaluate(
        ({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return Boolean(
            hit?.closest('[aria-label="File annotations"] button'),
          );
        },
        { x: markerBox.x + markerBox.width / 2, y: markerCenterY },
      );
      expect(markerHit, 'marker button receives the pointer').toBe(true);
      await marker.hover();
      await expect(
        window.locator('[role="tooltip"]', { hasText: 'File comment thread' }),
      ).toBeVisible();

      // Native scrollbar: with the document at its midpoint the thumb is centred
      // on the track, so a press on the gutter centre lands on the thumb.
      await window
        .getByTestId('file-viewer-markdown-scroll')
        .evaluate((node) => {
          node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
        });
      await waitForNextPaint(window);
      const beforeDrag = await readRendered();
      const trackCenterY =
        beforeDrag.scroller.top + beforeDrag.clientHeight / 2;
      await window.mouse.move(gutterCenterX, trackCenterY);
      await window.mouse.down();
      await window.mouse.move(gutterCenterX, trackCenterY + 60, { steps: 6 });
      await window.mouse.up();
      await waitForNextPaint(window);
      const afterDrag = await readRendered();
      expect
        .soft(
          afterDrag.scrollTop,
          `dragging the scrollbar thumb scrolls the document: ${JSON.stringify({ beforeDrag, afterDrag })}`,
        )
        .toBeGreaterThan(beforeDrag.scrollTop + 20);

      // Wheel input with the pointer resting on the gutter must scroll too.
      await window.mouse.move(
        gutterCenterX,
        afterDrag.scroller.top + afterDrag.clientHeight * 0.3,
      );
      await window.mouse.wheel(0, 400);
      let afterWheel = await readRendered();
      for (
        let attempt = 0;
        attempt < 30 && afterWheel.scrollTop <= afterDrag.scrollTop + 20;
        attempt += 1
      ) {
        await waitForNextPaint(window);
        afterWheel = await readRendered();
      }
      expect
        .soft(
          afterWheel.scrollTop,
          'wheel over the scrollbar gutter scrolls the document',
        )
        .toBeGreaterThan(afterDrag.scrollTop + 20);

      // The marker still opens its thread after the scroll interactions.
      await marker.click();
      await expect(
        window.getByTestId('review-comment-thread-popover'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('file comments render markers and drawer and stage a selection comment', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-comments-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, FILE_NAME);
  writeFileSync(filePath, FILE_CONTENT, 'utf8');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: FILE_TAB_ID,
    // A seeded chat tab keeps the app from creating one and bringing it to the
    // front, which intermittently hid the editor under test.
    lastActiveEditableChatId: CHAT_TAB_ID,
    tabs: [
      {
        id: FILE_TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
      },
      { id: CHAT_TAB_ID, title: 'Chat' },
    ],
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktree-data',
      WORKTREE_ID,
      'file-annotations.json',
    ),
    {
      version: 1,
      files: [
        {
          filePath,
          annotations: [
            {
              id: 'annotation-1',
              repoId: 'default',
              filePath,
              side: 'new',
              lineStart: 2,
              lineEnd: 2,
              kind: 'context',
              title: 'Seeded highlight',
              body: 'Inspect this line.',
            },
          ],
          commentThreads: [
            {
              id: 'thread-1',
              status: 'open',
              createdAt: '2026-07-27T00:00:00.000Z',
              anchorState: 'matched',
              anchor: {
                source: 'code',
                repoId: 'default',
                filePath,
                side: 'new',
                lineStart: 2,
                lineEnd: 2,
                quote: 'const beta = alpha.toUpperCase();',
                annotationId: 'annotation-1',
              },
              comments: [
                {
                  id: 'comment-1',
                  author: 'agent',
                  body: 'Please review this highlighted line.',
                  createdAt: '2026-07-27T00:00:00.000Z',
                  staged: false,
                },
              ],
            },
          ],
        },
      ],
    },
  );

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId('file-comments-drawer')).toBeVisible();
    await expect(
      window.getByTestId('file-comment-thread-thread-1'),
    ).toContainText('Please review this highlighted line.');
    await expect(editor.locator('.canopy-file-annotation-glyph')).toBeVisible();

    const firstLine = editor
      .locator('.view-line')
      .filter({ hasText: 'const alpha' })
      .first();
    const selectionMenu = window.getByTestId('file-selection-menu');
    await expect(async () => {
      await expect(firstLine).toBeVisible({ timeout: 2_000 });
      const box = await firstLine.boundingBox();
      expect(box, 'first Monaco line bounds').toBeTruthy();
      await window.mouse.move(box.x + 45, box.y + box.height / 2);
      await window.mouse.down();
      await window.mouse.move(
        box.x + Math.min(box.width - 5, 250),
        box.y + box.height / 2,
        { steps: 10 },
      );
      await window.mouse.up();
      await expect(selectionMenu).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    await window.getByTestId('file-selection-comment').click();
    const composer = window.locator('textarea[placeholder^="Add a comment"]');
    await expect(composer).toBeVisible();
    await composer.fill('Please update this selected text.');
    await window.getByTestId('review-comment-submit-draft').click();

    await expect(window.getByTestId('file-comments-submit')).toHaveText(
      'Submit 1 comment',
    );
    await expect(window.getByTestId('file-comments-drawer')).toContainText(
      'Please update this selected text.',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
