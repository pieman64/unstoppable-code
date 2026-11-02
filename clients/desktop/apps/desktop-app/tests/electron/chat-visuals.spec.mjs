// Durable assertions only. Captures belong in a temporary capture spec.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatVisuals,
  VISUAL_CHAT_ID,
  VISUAL_DOCUMENT,
  VISUAL_REFERENCE,
  VISUAL_RESULT_MESSAGE_ID,
  VISUAL_SCOPE,
  VISUAL_TOOL_USE_ID,
  VISUAL_TITLE,
} from './fixtures/chat-visuals.mjs';
import {
  DEMO_VISUAL_CHAT_ID,
  DEMO_VISUAL_SCOPE,
  DEMO_VISUALS,
  seedDemoChatVisuals,
} from './fixtures/chat-visuals-demo.mjs';

// Frozen @canopy/ui-app CHAT_VISUAL_TEST_IDS. Electron specs stay plain mjs.
const ids = Object.freeze({
  block: 'chat-visual-block',
  frame: 'chat-visual-frame',
  interactButton: 'chat-visual-interact-button',
  expandButton: 'chat-visual-expand-button',
  sourceButton: 'chat-visual-source-button',
  dialog: 'chat-visual-dialog',
  panel: 'chat-visuals-panel',
  panelItem: 'chat-visuals-panel-item',
  sourceView: 'chat-visual-source-view',
  saveButton: 'chat-visual-save-button',
  unavailableState: 'chat-visual-unavailable-state',
  errorState: 'chat-visual-error-state',
});

async function openSeededChat(page) {
  const app = new CanopyAppDriver(page);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(VISUAL_SCOPE.worktreeId);
  await page.getByTestId(`panel-tab-panel-chat-${VISUAL_CHAT_ID}`).click();
  await expect(page.getByTestId('chat-message-list-content')).toBeVisible();
}

/** Opens the seeded chat and waits until the agent document has rendered. */
async function openSeededVisual(page, electronApp) {
  await openSeededChat(page);
  await expect(page.getByTestId(ids.frame)).toBeVisible();
  await waitForAgentDocument(electronApp);
}

async function waitForAgentDocument(electronApp) {
  await expect
    .poll(async () => {
      const result = await agentFrameSnapshot(
        electronApp,
        'document.body?.textContent ?? ""',
      );
      return result?.value ?? '';
    })
    .toContain('Revenue chart');
}

async function agentFrameSnapshot(electronApp, expression) {
  return electronApp.evaluate(async ({ BrowserWindow }, code) => {
    const contents = BrowserWindow.getAllWindows()
      .map((item) => item.webContents)
      .find((item) =>
        item.mainFrame.framesInSubtree.some(
          (frame) => frame.url === 'about:srcdoc',
        ),
      );
    const frames = contents?.mainFrame.framesInSubtree ?? [];
    const agent = frames.filter((frame) => frame.url === 'about:srcdoc').at(-1);
    if (!contents || !agent) return null;
    return {
      mainProcessId: contents.mainFrame.osProcessId,
      agentProcessId: agent.osProcessId,
      routingId: agent.routingId,
      value: await agent.executeJavaScript(code),
    };
  }, expression);
}

/**
 * Runs `code` in the agent document that holds `selector`, whichever of the
 * mounted visuals that is. The page's own frame tree does not reach into a
 * visual's sandboxed frames; the main process does.
 */
async function inAgentWith(electronApp, selector, code) {
  return electronApp.evaluate(
    async ({ BrowserWindow }, [target, source]) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const frame of window.webContents.mainFrame.framesInSubtree) {
          if (frame.url !== 'about:srcdoc') continue;
          const holds = await frame
            .executeJavaScript(
              `!!document.querySelector(${JSON.stringify(target)})`,
            )
            .catch(() => false);
          if (holds) return frame.executeJavaScript(source);
        }
      }
      return null;
    },
    [selector, code],
  );
}

/** Shows this short transcript from its start, clear of the pinned message. */
async function showVisualFromStart(page) {
  await page.getByTestId(ids.frame).evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
  });
}

/**
 * Moves the real pointer over the visual and on to `point`. A visual lets the
 * pointer in once the host sees it move there, as a hand on its way to a
 * target always does.
 */
async function movePointerInto(page, point) {
  await page.mouse.move(point.x - 12, point.y - 4);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await expect(page.getByTestId(ids.frame)).not.toHaveAttribute('inert', '');
}

async function hoverVisual(page) {
  await showVisualFromStart(page);
  const box = await page.getByTestId(ids.frame).boundingBox();
  expect(box).not.toBeNull();
  await movePointerInto(page, { x: box.x + box.width / 2, y: box.y + 14 });
}

/**
 * Clicks an element inside the agent document with a trusted mouse event.
 * `verify` reads back the element the click reached; skip it only when the
 * click blocks the agent past the host's liveness deadline, which tears the
 * frame down before a read-back could answer.
 */
async function clickInsideAgent(
  page,
  electronApp,
  selector,
  { verify = true } = {},
) {
  // The transcript opens at its end, and its pinned user message covers
  // whatever scrolls beneath it.
  await showVisualFromStart(page);
  const outer = await page.getByTestId(ids.frame).boundingBox();
  expect(outer).not.toBeNull();
  const geometry = await electronApp.evaluate(
    async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()
        .map((item) => item.webContents)
        .find((item) =>
          item.mainFrame.framesInSubtree.some(
            (frame) => frame.url === 'about:srcdoc',
          ),
        );
      const frames =
        contents?.mainFrame.framesInSubtree.filter(
          (frame) => frame.url === 'about:srcdoc',
        ) ?? [];
      const wrapper = frames.at(-2);
      const agent = frames.at(-1);
      if (!contents || !wrapper || !agent) return null;
      const inner = await wrapper.executeJavaScript(
        '({x:document.querySelector("iframe").getBoundingClientRect().x,y:document.querySelector("iframe").getBoundingClientRect().y})',
      );
      // Record which element a trusted click reaches, so a miss fails loudly.
      const item = await agent.executeJavaScript(
        `(() => { window.__visualClicks = []; document.addEventListener('click', (event) => window.__visualClicks.push(event.target.id || event.target.tagName), true); const rect = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}; })()`,
      );
      return { inner, item };
    },
    selector,
  );
  expect(geometry).not.toBeNull();
  // Untransformed subframes share the page's CSS pixel scale.
  const point = {
    x: outer.x + geometry.inner.x + geometry.item.x + geometry.item.width / 2,
    y: outer.y + geometry.inner.y + geometry.item.y + geometry.item.height / 2,
  };
  await movePointerInto(page, point);
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
      point,
    ),
  ).toBe(ids.frame);
  if (!verify) {
    // A blocked agent never acknowledges the click before the host tears it
    // down, so Playwright's click would wait forever; send it and move on.
    void page.mouse.click(point.x, point.y).catch(() => {});
    return;
  }
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(async () => {
      const result = await agentFrameSnapshot(
        electronApp,
        'window.__visualClicks ?? []',
      );
      return result?.value ?? [];
    })
    .toContain(selector.replace(/^#/, ''));
}

test('reads the owned V2 artifact and renders its visual in a collapsed turn', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededChat(page);
    // This assertion comes first: a visual placeholder cannot conceal a bad
    // fixture path, invalid reference, or owner mismatch.
    const read = await page.evaluate(
      (request) => window.api.chat.readVisual(request),
      {
        ...VISUAL_SCOPE,
        chatId: VISUAL_CHAT_ID,
        messageId: VISUAL_RESULT_MESSAGE_ID,
        toolUseId: VISUAL_TOOL_USE_ID,
        reference: VISUAL_REFERENCE,
        offset: 0,
        limit: VISUAL_REFERENCE.byteLength,
      },
    );
    expect(read.byteLength).toBe(VISUAL_REFERENCE.byteLength);
    expect(read.sha256).toBe(VISUAL_REFERENCE.sha256);
    expect(Buffer.from(read.data, 'base64').toString('utf8')).toBe(
      VISUAL_DOCUMENT,
    );
    const transcript = page.getByTestId('chat-message-list-content');
    const summary = transcript.getByRole('button', { name: /Agent steps:/i });
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    const block = transcript.getByTestId(ids.block);
    await expect(block).toHaveAttribute('data-variant', 'visual-only');
    await expect(block.getByTestId(ids.frame)).toBeVisible();
    await expect(transcript.getByText(VISUAL_TITLE)).toHaveCount(0);
    const collapsedWidth = (await block.boundingBox())?.width ?? 0;
    expect(collapsedWidth).toBeGreaterThan(0);
    await summary.click();
    await expect(block).toHaveAttribute('data-variant', 'inline');
    // The visual keeps the transcript's width inside the expanded turn rather
    // than shrinking to its tool row's label.
    expect((await block.boundingBox())?.width).toBe(collapsedWidth);
    await expect(transcript.getByTestId('chat-tool-call')).toContainText(
      VISUAL_TITLE,
    );
    await expect(transcript).not.toContainText('<hidden>');
    // Expanding moves the block into the tool row, which loads a new frame.
    await waitForAgentDocument(electronApp);
    const processIds = await agentFrameSnapshot(electronApp, 'document.title');
    expect(processIds?.agentProcessId).toBeTruthy();
    expect(processIds?.agentProcessId).not.toBe(processIds?.mainProcessId);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps a visual readable and rendered after its scope is promoted to format 4 and reopened', async () => {
  test.setTimeout(240_000);
  const { userDataDir } = await seedChatVisuals();
  const manifest = join(
    userDataDir,
    'workspaces',
    VISUAL_SCOPE.projectId,
    'chat-storage-manifests',
    `${VISUAL_SCOPE.worktreeId}.json`,
  );
  const manifestVersion = () =>
    existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, 'utf8')).version
      : 0;
  expect(manifestVersion()).toBeLessThan(4);
  const env = { CANOPY_E2E_CHAT_FORMAT4: '1' };
  let electronApp;
  try {
    // The first launch promotes the seeded scope; the second reopens format 4.
    for (const launch of ['promote', 'reopen']) {
      ({ electronApp } = await launchCanopy({ userDataDir, env }));
      const page = await electronApp.firstWindow();
      await openSeededChat(page);
      await expect.poll(manifestVersion, { message: launch }).toBe(4);
      const read = await page.evaluate(
        (request) => window.api.chat.readVisual(request),
        {
          ...VISUAL_SCOPE,
          chatId: VISUAL_CHAT_ID,
          messageId: VISUAL_RESULT_MESSAGE_ID,
          toolUseId: VISUAL_TOOL_USE_ID,
          reference: VISUAL_REFERENCE,
          offset: 0,
          limit: VISUAL_REFERENCE.byteLength,
        },
      );
      expect(read.sha256, launch).toBe(VISUAL_REFERENCE.sha256);
      expect(Buffer.from(read.data, 'base64').toString('utf8')).toBe(
        VISUAL_DOCUMENT,
      );
      const block = page
        .getByTestId('chat-message-list-content')
        .getByTestId(ids.block);
      await expect(block).toHaveAttribute('data-variant', 'visual-only');
      await expect(block.getByTestId(ids.frame)).toBeVisible();
      await waitForAgentDocument(electronApp);
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: launch === 'promote',
      });
      electronApp = undefined;
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('renders in light and dark and changes the live frame theme without reloading it', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const before = await agentFrameSnapshot(
      electronApp,
      '({mode:getComputedStyle(document.documentElement).colorScheme, html:document.body.textContent})',
    );
    expect(before?.value.html).toContain('Revenue chart');
    // The frame gets the six chart series colors, and each appearance has
    // its own steps of the same hues.
    const chartSeries =
      '[1,2,3,4,5,6].map((slot) => getComputedStyle(document.documentElement).getPropertyValue("--chart-categorical-" + slot).trim())';
    const lightSeries =
      (await agentFrameSnapshot(electronApp, chartSeries))?.value ?? [];
    expect(new Set(lightSeries.filter(Boolean)).size).toBe(6);
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-color-mode', 'dark');
    });
    await expect
      .poll(async () => {
        const next = await agentFrameSnapshot(
          electronApp,
          'getComputedStyle(document.documentElement).colorScheme',
        );
        return next?.value;
      })
      .toBe('dark');
    const dark = await agentFrameSnapshot(
      electronApp,
      'document.body.textContent',
    );
    expect(dark?.routingId).toBe(before?.routingId);
    expect(dark?.value).toContain('Revenue chart');
    const darkSeries =
      (await agentFrameSnapshot(electronApp, chartSeries))?.value ?? [];
    expect(new Set(darkSeries.filter(Boolean)).size).toBe(6);
    expect(darkSeries).not.toEqual(lightSeries);
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-color-mode', 'light');
    });
    await expect
      .poll(async () => {
        const next = await agentFrameSnapshot(
          electronApp,
          'getComputedStyle(document.documentElement).colorScheme',
        );
        return next?.value;
      })
      .toBe('light');
    expect(
      (await agentFrameSnapshot(electronApp, 'document.title'))?.routingId,
    ).toBe(before?.routingId);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps a visual at rest closed to focus and ignores forged messages', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const frame = page.getByTestId(ids.frame);
    await expect(frame).toHaveAttribute('inert', '');
    // Forged bridge messages never activate or focus the visual, and nobody
    // but its wrapper can vouch for a gesture.
    await page.evaluate(() => {
      window.postMessage({ jsonrpc: '2.0', method: 'ui/activate' }, '*');
      window.postMessage({ jsonrpc: '2.0', method: 'ui/focus' }, '*');
      window.postMessage(
        {
          jsonrpc: '2.0',
          method: 'canopy/visual/gesture',
          params: { id: 1, active: true },
        },
        '*',
      );
    });
    await expect(frame).toHaveAttribute('inert', '');
    await expect(page.getByTestId(ids.interactButton)).toBeVisible();
    // Script focus inside a visual at rest fails closed: focus stays on the
    // host, or the host tears the visual down.
    // The host may tear the frame down before this script's result returns.
    await agentFrameSnapshot(
      electronApp,
      "document.getElementById('focus-probe').focus(); document.activeElement.id",
    ).catch(() => null);
    // Let the focus change reach the host before judging it.
    await page.waitForTimeout(500);
    await expect
      .poll(async () => {
        if ((await page.getByTestId(ids.errorState).count()) > 0)
          return 'torn-down';
        const focused = await page.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? null,
        );
        return focused === ids.frame ? 'focused' : 'inert';
      })
      .not.toBe('focused');
    if ((await page.getByTestId(ids.errorState).count()) === 0)
      await expect(frame).toHaveAttribute('inert', '');
    else await expect(frame).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('answers the pointer and the first click with no activation step, and closes on every host exit', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const frame = page.getByTestId(ids.frame);
    const interact = page.getByTestId(ids.interactButton);
    const steps = page.getByRole('button', { name: /Agent steps:/i });
    await expect(frame).toHaveAttribute('inert', '');
    await steps.focus();

    // Moving the pointer over the visual lets it in. Focus stays where it
    // was, and the visual gains no control or outline of its own.
    await hoverVisual(page);
    await expect(interact).toHaveCount(0);
    await expect(steps).toBeFocused();
    await expect(page.getByTestId('chat-visual-done-button')).toHaveCount(0);
    const edges = await frame.evaluate((element, blockId) => {
      const found = [];
      for (
        let node = element;
        node && node.getAttribute('data-testid') !== blockId;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        found.push(`${style.outlineStyle}|${style.boxShadow}`);
      }
      return found;
    }, ids.block);
    expect(edges.every((edge) => edge === 'none|none')).toBe(true);

    // The first click inside lands, and the field it clicks keeps the caret.
    await clickInsideAgent(page, electronApp, '#focus-probe');
    await page.keyboard.type('ok');
    // Past the host's wait for the wrapper to confirm the click.
    await page.waitForTimeout(600);
    await expect(frame).toBeFocused();
    await expect(frame).not.toHaveAttribute('inert', '');
    await expect(page.getByTestId(ids.errorState)).toHaveCount(0);
    const typed = await agentFrameSnapshot(
      electronApp,
      "document.getElementById('focus-probe').value",
    );
    expect(typed?.value).toBe('ok');

    // Focus returning to the host closes the visual.
    await steps.focus();
    await expect(frame).toHaveAttribute('inert', '');
    // So does a key typed in the app while the pointer rests on the visual.
    await hoverVisual(page);
    await page.keyboard.press('a');
    await expect(frame).toHaveAttribute('inert', '');
    // And the pointer leaving it. After typing, the pointer is let in again
    // only once the keys have been quiet for a moment.
    await hoverVisual(page);
    await page.mouse.move(2, 2, { steps: 4 });
    await expect(frame).toHaveAttribute('inert', '');

    // The control under the pointer is also the keyboard's way in.
    for (const key of ['Enter', 'Space']) {
      // Position before the control, then move into it with a real Tab.
      await interact.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(interact).toBeFocused();
      await page.keyboard.press(key);
      await expect(frame).not.toHaveAttribute('inert', '');
      await expect(frame).toBeFocused();
      await steps.focus();
      await expect(frame).toHaveAttribute('inert', '');
    }

    // Escape pressed in the host closes a visual the keyboard opened.
    await interact.focus();
    await page.keyboard.press('Enter');
    await expect(frame).toBeFocused();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await expect(frame).not.toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(frame).toHaveAttribute('inert', '');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('gives focus back when a visual takes it with no gesture, and then needs a click', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const frame = page.getByTestId(ids.frame);
    const steps = page.getByRole('button', { name: /Agent steps:/i });
    await steps.focus();
    await hoverVisual(page);
    // No gesture inside the visual: the script runs from a timer, after the
    // activation this evaluation itself may carry has lapsed.
    await agentFrameSnapshot(
      electronApp,
      "setTimeout(() => document.getElementById('focus-probe').focus(), 5400); true",
    );
    await page.waitForTimeout(6400);
    await expect(steps).toBeFocused();
    if ((await page.getByTestId(ids.errorState).count()) > 0) {
      await expect(frame).toHaveCount(0);
      return;
    }
    await expect(frame).toHaveAttribute('inert', '');
    // Moving the pointer no longer opens this visual.
    const box = await frame.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 20);
    await page.mouse.move(box.x + 120, box.y + 30, { steps: 5 });
    await page.waitForTimeout(400);
    await expect(frame).toHaveAttribute('inert', '');
    // A click the host can see still does.
    await page.mouse.click(box.x + 120, box.y + 30);
    await expect(frame).not.toHaveAttribute('inert', '');
    await expect(frame).toBeFocused();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('opens external links only after an in-frame click and keeps hash links local', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    await electronApp.evaluate(({ BrowserWindow }) => {
      globalThis.__visualOpenedUrls = [];
      const main = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.mainFrame.framesInSubtree.some(
          (frame) => frame.url === 'about:srcdoc',
        ),
      );
      main.webContents.setWindowOpenHandler(({ url }) => {
        globalThis.__visualOpenedUrls.push(url);
        return { action: 'deny' };
      });
    });
    const interact = page.getByTestId(ids.interactButton);
    await interact.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await agentFrameSnapshot(
      electronApp,
      "window.parent.postMessage({jsonrpc:'2.0',method:'ui/open-link',params:{url:'https://example.com/forged-within-1s'}},'*')",
    );
    await page.waitForTimeout(1100);
    expect(
      await electronApp.evaluate(() => globalThis.__visualOpenedUrls),
    ).toEqual([]);
    await clickInsideAgent(page, electronApp, '#external-link');
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__visualOpenedUrls))
      .toContain('https://example.com/visual-landing');
    const beforeHash = await agentFrameSnapshot(electronApp, 'window.scrollY');
    await clickInsideAgent(page, electronApp, '#internal-link');
    const afterHash = await agentFrameSnapshot(electronApp, 'window.scrollY');
    expect(afterHash?.value).toBeGreaterThan(beforeHash?.value ?? 0);
    expect(
      await electronApp.evaluate(() => globalThis.__visualOpenedUrls),
    ).toEqual(['https://example.com/visual-landing']);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('proves the self-navigation sink, then blocks wrapper and guarded main-window escapes', async () => {
  test.setTimeout(180_000);
  const requests = [];
  const sink = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('sink');
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const port = sink.address().port;
  const sinkUrl = `http://127.0.0.1:${port}`;
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const wrapperSrcDoc = await page
      .getByTestId(ids.frame)
      .getAttribute('srcdoc');
    expect(wrapperSrcDoc).toBeTruthy();

    // The control window deliberately has no will-frame-navigate guard.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const control = new BrowserWindow({
        show: false,
        title: 'visual-navigation-control',
        webPreferences: { sandbox: true },
      });
      await control.loadURL('data:text/html,<html><body>control</body></html>');
      await control.webContents.executeJavaScript(`(() => {
        const frame = document.createElement('iframe');
        frame.name = 'raw-control';
        frame.sandbox = 'allow-scripts';
        frame.srcdoc = '<p id="control-marker">raw</p>';
        document.body.append(frame);
      })()`);
    });
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const control = BrowserWindow.getAllWindows().find(
            (item) => item.getTitle() === 'visual-navigation-control',
          );
          return (
            control?.webContents.mainFrame.framesInSubtree.some(
              (frame) => frame.name === 'raw-control',
            ) ?? false
          );
        }),
      )
      .toBe(true);
    await electronApp.evaluate(({ BrowserWindow }, url) => {
      const control = BrowserWindow.getAllWindows().find(
        (item) => item.getTitle() === 'visual-navigation-control',
      );
      const frame = control.webContents.mainFrame.framesInSubtree.find(
        (item) => item.name === 'raw-control',
      );
      void frame.executeJavaScript(`location.href=${JSON.stringify(url)}`);
    }, `${sinkUrl}/raw`);
    await expect.poll(() => requests.includes('/raw')).toBe(true);

    await electronApp.evaluate(async ({ BrowserWindow }, srcDoc) => {
      const control = BrowserWindow.getAllWindows().find(
        (item) => item.getTitle() === 'visual-navigation-control',
      );
      await control.webContents.executeJavaScript(`(() => {
        document.body.textContent = '';
        const frame = document.createElement('iframe');
        frame.name = 'wrapped-control';
        frame.sandbox = 'allow-scripts';
        frame.srcdoc = ${JSON.stringify(srcDoc)};
        document.body.append(frame);
      })()`);
    }, wrapperSrcDoc);
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => {
          const control = BrowserWindow.getAllWindows().find(
            (item) => item.getTitle() === 'visual-navigation-control',
          );
          return (
            control?.webContents.mainFrame.framesInSubtree.filter(
              (frame) => frame.url === 'about:srcdoc',
            ).length ?? 0
          );
        }),
      )
      .toBeGreaterThanOrEqual(2);
    await electronApp.evaluate(({ BrowserWindow }, url) => {
      const control = BrowserWindow.getAllWindows().find(
        (item) => item.getTitle() === 'visual-navigation-control',
      );
      const agent = control.webContents.mainFrame.framesInSubtree
        .filter((frame) => frame.url === 'about:srcdoc')
        .at(-1);
      void agent.executeJavaScript(`location.href=${JSON.stringify(url)}`);
    }, `${sinkUrl}/wrapped`);
    await page.waitForTimeout(1200);
    expect(
      requests,
      'the wrapper must not reach the loopback sink',
    ).not.toContain('/wrapped');

    const probeEval = (expression) =>
      electronApp.evaluate(async ({ BrowserWindow }, code) => {
        const main = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.mainFrame.framesInSubtree.some(
            (frame) => frame.name === 'guard-probe',
          ),
        );
        const probe = main?.webContents.mainFrame.framesInSubtree.find(
          (frame) => frame.name === 'guard-probe',
        );
        return probe ? probe.executeJavaScript(code) : null;
      }, expression);
    const marker =
      'document.getElementById("guard-marker")?.textContent ?? null';
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.name = 'guard-probe';
      frame.sandbox.add('allow-scripts');
      frame.srcdoc = '<p id="guard-marker">guarded</p>';
      document.body.append(frame);
    });
    // Navigate only once the srcdoc has committed, so the sink navigation
    // cannot replace a pending srcdoc load.
    await expect.poll(() => probeEval(marker)).toBe('guarded');
    await probeEval(
      `location.href=${JSON.stringify(`${sinkUrl}/guarded`)}; true`,
    );
    await page.waitForTimeout(1200);
    expect(
      requests,
      'the main-window guard must not reach the sink',
    ).not.toContain('/guarded');
    // The cancelled navigation leaves the probe's document in place. In a
    // packaged build the main window's frame policy already refuses every
    // target but about:, and Chromium commits about:blank and about:srcdoc
    // without a will-frame-navigate event, so the guard's narrower rule is
    // covered by subframe-navigation-guard tests rather than here.
    expect(await probeEval(marker)).toBe('guarded');
  } finally {
    if (electronApp) {
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .filter((item) => item.getTitle() === 'visual-navigation-control')
          .forEach((item) => item.close());
      });
      await closeCanopy(electronApp, userDataDir);
    }
    await new Promise((resolve) => sink.close(resolve));
  }
});

test('enforces opaque-origin and resource CSP against a loopback sink', async () => {
  test.setTimeout(180_000);
  const requests = [];
  const sink = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('leak');
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}`;
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    const blocked = await agentFrameSnapshot(
      electronApp,
      `(() => {
      const url = ${JSON.stringify(sinkUrl)};
      const probe = {};
      try { probe.parent = !!parent.document; } catch { probe.parent = 'blocked'; }
      try { probe.storage = !!localStorage.length; } catch { probe.storage = 'blocked'; }
      try { probe.cookie = document.cookie; } catch { probe.cookie = 'blocked'; }
      probe.httpEquiv = [...document.querySelectorAll('meta[http-equiv]')].map((meta) => meta.httpEquiv.toLowerCase()).sort();
      fetch(url + '/fetch').catch(() => {});
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url + '/xhr');
      try { xhr.send(); } catch {}
      try { new WebSocket(url.replace('http:', 'ws:') + '/socket'); } catch {}
      try { new EventSource(url + '/events'); } catch {}
      try { navigator.sendBeacon(url + '/beacon', 'probe'); } catch {}
      const image = new Image(); image.src = url + '/image'; document.body.append(image);
      const nested = document.createElement('iframe'); nested.src = url + '/nested'; document.body.append(nested);
      const style = document.createElement('style');
      style.textContent = 'body{background-image:url(' + url + '/css)}';
      document.head.append(style);
      try { window.open(url + '/popup', '_blank'); } catch {}
      return probe;
    })()`,
    );
    expect(blocked?.value.parent).toBe('blocked');
    expect(blocked?.value.storage).toBe('blocked');
    expect(['', 'blocked']).toContain(blocked?.value.cookie);
    // Only the host's own metas: the visual policy and DNS prefetch off.
    expect(blocked?.value.httpEquiv).toEqual([
      'content-security-policy',
      'x-dns-prefetch-control',
    ]);
    const localAllowed = await agentFrameSnapshot(
      electronApp,
      `new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 1;
      canvas.getContext('2d').fillRect(0, 0, 1, 1);
      const data = new Image();
      data.onload = () => canvas.toBlob((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const objectImage = new Image();
        objectImage.onload = () => { URL.revokeObjectURL(objectUrl); resolve({data:true, blob:true, eval:eval('1+1'), fn:new Function('return 3')()}); };
        objectImage.onerror = () => resolve({data:true, blob:false});
        objectImage.src = objectUrl;
      }, 'image/png');
      data.onerror = () => resolve({data:false, blob:false});
      data.src = canvas.toDataURL('image/png');
    })`,
    );
    expect(localAllowed?.value).toEqual({
      data: true,
      blob: true,
      eval: 2,
      fn: 3,
    });
    await agentFrameSnapshot(
      electronApp,
      "window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:100000}},'*')",
    );
    // The clamp sizes the bordered container that holds the frame.
    await expect
      .poll(() =>
        page
          .getByTestId(ids.frame)
          .evaluate(
            (frame) => frame.parentElement?.getBoundingClientRect().height,
          ),
      )
      .toBe(VISUAL_REFERENCE.maxHeight);
    await page.waitForTimeout(1200);
    expect(requests).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => sink.close(resolve));
  }
});

test('keeps the host responsive while a busy visual is torn down', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededVisual(page, electronApp);
    // The error state below proves the click reached the busy button.
    await clickInsideAgent(page, electronApp, '#busy-trigger', {
      verify: false,
    });
    const hostLatency = [];
    for (let index = 0; index < 10; index += 1) {
      const started = Date.now();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          ),
      );
      hostLatency.push(Date.now() - started);
    }
    expect(Math.max(...hostLatency)).toBeLessThan(2500);
    await expect(page.getByTestId(ids.errorState)).toContainText(
      'stopped responding',
      { timeout: 20_000 },
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('shows an unavailable visual instead of an iframe in a popped-out chat', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededChat(page);
    await expect(page.getByTestId(ids.frame)).toBeVisible();
    const auxPromise = electronApp.waitForEvent('window');
    await page.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      'group-chat',
    );
    const aux = await auxPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    await expect(aux.getByTestId(ids.unavailableState)).toContainText(
      'main window',
    );
    await expect(aux.getByTestId(ids.frame)).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps HTML file preview rendering and searchable under the frame guard', async () => {
  test.setTimeout(180_000);
  const { userDataDir, worktreePath } = await seedChatVisuals();
  const filename = 'visual-guard-preview.html';
  writeFileSync(
    join(worktreePath, filename),
    '<!doctype html><h1>Guard preview orchid</h1><p>Searchable preview content</p>',
    'utf8',
  );
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededChat(page);
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
    );
    const palette = page.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await page.getByTestId('file-search-palette-input').fill(filename);
    await palette
      .getByTestId('file-search-palette-result')
      .filter({ hasText: filename })
      .first()
      .click();
    // A fresh HTML file opens formatted from the file palette.
    await expect(
      page.getByRole('button', { name: 'Formatted', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const preview = page.getByTestId('html-file-preview-frame');
    await expect(preview).toBeVisible();
    const body = page
      .frameLocator('[data-testid="html-file-preview-frame"]')
      .locator('body');
    await expect(body).toContainText('Guard preview orchid');
    await body.getByText('Searchable preview content').click();
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+F' : 'Control+F',
    );
    // CAN-3048: desktop searches the preview through the floating find bar.
    const search = page.getByTestId('surface-find-bar');
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('data-find-mode', 'file');
    await search.locator('input').fill('orchid');
    await expect(search).toContainText('1 of 1');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('opens source and saves a sandboxed HTML export through the download path', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    await openSeededChat(page);
    await page.getByRole('button', { name: /Agent steps:/i }).click();
    // The tool row offers the source in its expanded panel.
    await page
      .getByTestId('chat-tool-call')
      .getByRole('button', { expanded: false })
      .click();
    await page.getByTestId(ids.sourceButton).click();
    const dialog = page.getByTestId(ids.dialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(ids.sourceView)).toContainText(
      'Revenue chart',
    );
    const { require: tsRequire } = await import('tsx/cjs/api');
    const { AGENT_VISUAL_THEME_VARIABLES, buildAgentVisualExportDocument } =
      tsRequire(
        '../../../../packages/ui-shared/src/lib/agent-visual-html.ts',
        import.meta.url,
      );
    const theme = await page.evaluate((names) => {
      const style = getComputedStyle(document.documentElement);
      const variables = {};
      for (const name of names) {
        const value = style.getPropertyValue(name).trim();
        if (value) variables[name] = value;
      }
      return {
        appearance: style.colorScheme.includes('dark') ? 'dark' : 'light',
        variables,
      };
    }, AGENT_VISUAL_THEME_VARIABLES);
    const savePath = join(userDataDir, 'saved-visual.html');
    await electronApp.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(path);
      });
    }, savePath);
    await dialog.getByTestId(ids.saveButton).click();
    await expect
      .poll(() => {
        try {
          return readFileSync(savePath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('sandbox="allow-scripts"');
    const saved = readFileSync(savePath, 'utf8');
    expect(saved).toBe(
      buildAgentVisualExportDocument(VISUAL_DOCUMENT, theme, VISUAL_TITLE),
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

async function openDemoChat(page) {
  const app = new CanopyAppDriver(page);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(DEMO_VISUAL_SCOPE.worktreeId);
  await page.getByTestId(`panel-tab-panel-chat-${DEMO_VISUAL_CHAT_ID}`).click();
  const chat = page.getByTestId('panel-content-chat');
  await expect(chat.getByTestId(ids.block)).toHaveCount(DEMO_VISUALS.length);
  return chat;
}

test('shows a visual with no border, rounded corners, or label, and takes the first click', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedDemoChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    const chat = await openDemoChat(page);
    // The second visual: the first one's top sits under the pinned message.
    const block = chat.getByTestId(ids.block).nth(1);
    await block.scrollIntoViewIfNeeded();
    const frame = block.getByTestId(ids.frame);
    await expect(frame).toBeVisible();
    // Nothing between the visual and the transcript draws an edge.
    const borders = await frame.evaluate((element, blockId) => {
      const widths = [];
      for (
        let node = element;
        node && node.getAttribute('data-testid') !== blockId;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        // A rounded box would cut off what the visual draws in its corners.
        widths.push(
          parseFloat(style.borderTopWidth) +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.borderTopLeftRadius) +
            parseFloat(style.borderBottomRightRadius),
        );
      }
      return widths;
    }, ids.block);
    expect(borders.every((width) => width === 0)).toBe(true);
    await expect(block).not.toContainText('Click to interact');
    await expect(block.getByTestId(ids.interactButton)).toHaveAccessibleName(
      `Interact with ${DEMO_VISUALS[1].title}`,
    );

    await block.hover();
    const expand = block.getByTestId(ids.expandButton);
    const save = block.getByTestId(ids.saveButton);
    await expect(expand).toHaveAccessibleName('Open in Chat visuals');
    await expect(save).toHaveAccessibleName('Save as HTML');
    await expect(expand).toHaveCSS('opacity', '1');
    // The actions overhang the corner and are not cut off by the transcript.
    for (const action of [expand, save]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      const top = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('button')
            ?.getAttribute('data-testid') ?? null,
        { x: box.x + box.width / 2, y: box.y + 3 },
      );
      expect(top).toBe(await action.getAttribute('data-testid'));
    }

    // A control the visual draws answers the first click: there is nothing to
    // click through, and no state to leave afterwards.
    const sortLabel = () =>
      inAgentWith(
        electronApp,
        '#sort',
        "document.querySelector('#sort').textContent",
      );
    expect(await sortLabel()).toBe('Sort by revenue');
    const target = await inAgentWith(
      electronApp,
      '#sort',
      "(() => { const rect = document.querySelector('#sort').getBoundingClientRect(); return {x:rect.x,y:rect.y,height:rect.height}; })()",
    );
    const outer = await frame.boundingBox();
    expect(target).not.toBeNull();
    expect(outer).not.toBeNull();
    // Below the corner actions, which sit over the button's top edge.
    const point = {
      x: outer.x + target.x + 12,
      y: outer.y + target.y + target.height - 4,
    };
    await page.mouse.move(point.x - 40, point.y + 30);
    await page.mouse.move(point.x, point.y, { steps: 5 });
    await expect(frame).not.toHaveAttribute('inert', '');
    await page.mouse.click(point.x, point.y);
    await expect.poll(sortLabel).toBe('Sort by name');
    await expect(page.getByTestId('chat-visual-done-button')).toHaveCount(0);
    // The corner actions stay up while the pointer is in the visual.
    await expect(expand).toHaveCSS('opacity', '1');
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('Expand opens one Chat visuals panel beside the chat, at that visual, and restores it', async () => {
  test.setTimeout(240_000);
  const { userDataDir } = await seedDemoChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let page = await electronApp.firstWindow();
    let chat = await openDemoChat(page);
    const blocks = chat.getByTestId(ids.block);
    const last = blocks.nth(2);
    await last.scrollIntoViewIfNeeded();
    await last.hover();
    await last.getByTestId(ids.expandButton).click();

    const content = page.getByTestId('panel-content-chat-visuals');
    const visualsTabs = page.locator(
      '[data-testid^="panel-tab-panel-chat-visuals"]',
    );
    await expect(content).toBeVisible();
    await expect(page.getByTestId(ids.dialog)).toHaveCount(0);
    // The chat stays open beside its visuals.
    await expect(chat).toBeVisible();
    await expect(visualsTabs).toHaveCount(1);
    await expect(visualsTabs).toContainText('Chat visuals');
    const items = content.getByTestId(ids.panelItem);
    await expect(items).toHaveCount(DEMO_VISUALS.length);
    await expect(items.locator('h3')).toHaveText(
      DEMO_VISUALS.map((visual) => visual.title),
    );
    await expect(items.nth(2).getByTestId(ids.frame)).toBeVisible();
    await expect(items.nth(2)).toBeInViewport();
    // A panel entry can be saved but has nothing to expand to.
    await items.nth(2).hover();
    await expect(items.nth(2).getByTestId(ids.saveButton)).toBeVisible();
    await expect(content.getByTestId(ids.expandButton)).toHaveCount(0);

    const scroller = content.getByTestId(ids.panel);
    const first = blocks.first();
    await first.scrollIntoViewIfNeeded();
    await first.hover();
    await first.getByTestId(ids.expandButton).click();
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(0);
    await expect(items.first()).toBeInViewport();
    await expect(visualsTabs).toHaveCount(1);
    await expect(visualsTabs).toContainText('Chat visuals');

    // The panel is part of the saved layout, and fills again from the chat.
    // The save is debounced, so wait for it to reach the file before quitting.
    const layoutPath = join(
      userDataDir,
      'workspaces',
      DEMO_VISUAL_SCOPE.projectId,
      'worktree-data',
      DEMO_VISUAL_SCOPE.worktreeId,
      'panel-layout.json',
    );
    await expect
      .poll(
        () =>
          existsSync(layoutPath) &&
          /"kind":\s*"chat-visuals"/.test(readFileSync(layoutPath, 'utf8')),
      )
      .toBe(true);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    page = await electronApp.firstWindow();
    chat = await openDemoChat(page);
    await expect(
      page.getByTestId('panel-content-chat-visuals').getByTestId(ids.panelItem),
    ).toHaveCount(DEMO_VISUALS.length);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('renders a visual in the app font', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedDemoChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    const chat = await openDemoChat(page);
    await expect(
      chat.getByTestId(ids.block).last().getByTestId(ids.frame),
    ).toBeVisible();
    const hostFamily = await page.evaluate(() => {
      const family = getComputedStyle(document.body).fontFamily;
      return family.split(',')[0].trim().replace(/["']/g, '');
    });
    expect(hostFamily.length).toBeGreaterThan(0);
    // The frame cannot fetch the app's bundled faces, so the host hands them
    // over; the same family then resolves to a loaded face inside it.
    await expect
      .poll(
        async () => {
          const result = await agentFrameSnapshot(
            electronApp,
            `(() => {
              const first = getComputedStyle(document.body).fontFamily.split(',')[0].trim().replace(/["']/g, '');
              const loaded = [...document.fonts].some((face) => face.status === 'loaded' && face.family.replace(/["']/g, '') === first);
              return first + '|' + loaded + '|' + document.fonts.check('14px "' + first + '"');
            })()`,
          );
          return result?.value ?? '';
        },
        { timeout: 30_000 },
      )
      .toBe(`${hostFamily}|true|true`);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('saves a visual as HTML from its corner action', async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await seedDemoChatVisuals();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const page = await electronApp.firstWindow();
    const chat = await openDemoChat(page);
    const block = chat.getByTestId(ids.block).nth(1);
    await block.scrollIntoViewIfNeeded();
    await expect(block.getByTestId(ids.frame)).toBeVisible();
    const savePath = join(userDataDir, 'saved-inline-visual.html');
    await electronApp.evaluate(({ session }, path) => {
      session.defaultSession.once('will-download', (_event, item) => {
        globalThis.__savedVisualName = item.getFilename();
        item.setSavePath(path);
      });
    }, savePath);
    await block.hover();
    await block.getByTestId(ids.saveButton).click();
    await expect
      .poll(() => {
        try {
          return readFileSync(savePath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('sandbox="allow-scripts"');
    expect(readFileSync(savePath, 'utf8')).toContain('Revenue by region, Q3');
    expect(await electronApp.evaluate(() => globalThis.__savedVisualName)).toBe(
      'Revenue-by-region.html',
    );
    // Saving is not expanding: no dialog and no panel opened.
    await expect(page.getByTestId(ids.dialog)).toHaveCount(0);
    await expect(page.getByTestId('panel-content-chat-visuals')).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});
