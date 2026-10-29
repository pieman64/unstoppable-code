// CAN-1570 phase 10b: one end-to-end workflow per interaction class, through
// the App Advisor dispatcher and the MCP DispatchAction route, each in its
// own launch; the support ticket's approved upload runs through the App
// Advisor and worktree MCP routes instead. A workflow drives Browser Lab
// pages with agent actions only, in one tab, and checks what the server
// received or what the page shows.
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import {
  chatForRoute,
  endApprovalSession,
  expectPathFree,
  filesIn,
  inLab,
  readLab,
  receiptOf,
  selector,
  startApprovalSession,
  stubNativePrint,
  taskDownloadsDir,
  withBrowser,
  WORKTREE_ROUTE,
} from './browser-files-harness.mjs';

const CROSS_FRAME = 'browser-lab-frames-cross-site-frame';
const CROSS_FORM_PATH = '/browser-lab/frames/cross-site-form';
const REPORT_NAME = 'browser-lab-report.txt';
const REPORT_BODY = 'Browser Lab attachment report\n';
const TICKET_BODY = 'Steps to reproduce: open Reports, then Export.\n';
const CARD = '4111111111111111';

let lab;
let origin;

test.beforeAll(async () => {
  lab = await listenPairedBrowserLabServers();
  origin = lab.primary.origin;
});

test.afterAll(async () => {
  await lab?.close();
});

/** The agent-visible part of a route response; App Advisor adds UI state beside it. */
function payloadOf(response) {
  return response.result ?? response;
}

function executed(kind, response) {
  expect(response.ok, `${kind}: ${JSON.stringify(response)}`).toBe(true);
  const receipt = receiptOf(response);
  expect(receipt, `${kind}: ${JSON.stringify(response)}`).toMatchObject({
    status: 'executed',
  });
  return receipt;
}

/** Moves the workflow's tab to another lab page, keeping its layout. */
async function goTo({ kind, run, electronApp }, caseName) {
  const url = `${origin}/browser-lab/${caseName}#${kind}-${randomUUID()}`;
  const navigated = await run({ type: 'browser.navigate', url });
  expect(navigated.ok, `${kind}: ${JSON.stringify(navigated)}`).toBe(true);
  await expect
    .poll(
      () =>
        readLab(
          electronApp,
          url,
          `browser-lab-${caseName}-main`,
          'data-testid',
        ).catch(() => null),
      { timeout: 30_000 },
    )
    .toBe(`browser-lab-${caseName}-main`);
  return url;
}

/** The fields an echo route received, from its result page. */
async function receivedFields(electronApp, url) {
  let fields;
  await expect
    .poll(
      async () => {
        fields = await inLab(
          electronApp,
          url,
          `Object.fromEntries(Array.from(document.querySelectorAll('[data-browser-lab-field]'), (item) => [item.dataset.browserLabField, item.textContent]))`,
        ).catch(() => null);
        return fields !== null && Object.keys(fields).length > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return fields;
}

/** Runs `expression` in the lab page's frame at `framePath`. */
async function inFrame(electronApp, url, framePath, expression) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      const frame = view?.mainFrame.framesInSubtree.find((candidate) => {
        try {
          return new URL(candidate.url).pathname === input.framePath;
        } catch {
          return false;
        }
      });
      if (!frame)
        throw new Error(`Browser Lab frame missing: ${input.framePath}`);
      return frame.executeJavaScript(input.expression);
    },
    { url, framePath, expression },
  );
}

/** The cross-site frame's ref, once its form has loaded. */
async function crossFrame({ kind, run, electronApp }, url) {
  await expect
    .poll(
      () =>
        inFrame(
          electronApp,
          url,
          CROSS_FORM_PATH,
          "document.readyState === 'complete' && !!document.querySelector('main')",
        ).catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);
  const inspected = await run({
    type: 'browser.inspect',
    locator: `page.frameLocator('${selector(CROSS_FRAME)}').getByTestId('browser-lab-frames-cross-site-name')`,
  });
  expect(inspected.ok, `${kind}: ${JSON.stringify(inspected)}`).toBe(true);
  const frame = payloadOf(inspected).element.frameRef;
  expect(frame).toMatch(/^f-/);
  return frame;
}

/**
 * A field's value inside a closed shadow root, which page script cannot
 * reach: read over the view's debugger, which pierces every root.
 */
async function closedRootValue(electronApp, url, testId) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view) throw new Error('Browser Lab WebContents not found');
      const send = (method, params) =>
        view.debugger.sendCommand(method, params);
      const { root } = await send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const find = (node) => {
        const attributes = node.attributes ?? [];
        for (let index = 0; index < attributes.length; index += 2)
          if (
            attributes[index] === 'data-testid' &&
            attributes[index + 1] === input.testId
          )
            return node;
        for (const child of [
          ...(node.children ?? []),
          ...(node.shadowRoots ?? []),
        ]) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      const node = find(root);
      if (!node) throw new Error(`No element ${input.testId}`);
      const { object } = await send('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
      });
      try {
        const { result } = await send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function () { return this.value; }',
          returnByValue: true,
        });
        return result.value;
      } finally {
        await send('Runtime.releaseObject', { objectId: object.objectId });
      }
    },
    { url, testId },
  );
}

/**
 * With `CAN1570_WORKFLOW_FRAMES_DIR` set, saves a numbered still of the window
 * and one of the page, for the report's video. A screencast misses the
 * approval card, because the window does not repaint while it is hidden.
 */
function stills(kind, electronApp, window) {
  const root = process.env.CAN1570_WORKFLOW_FRAMES_DIR;
  let count = 0;
  return async (label, pageUrl) => {
    if (!root) return;
    const dir = path.join(root, kind);
    mkdirSync(dir, { recursive: true });
    count += 1;
    const name = `${String(count).padStart(2, '0')}-${label}`;
    await window.screenshot({ path: path.join(dir, `${name}-window.png`) });
    const page = await electronApp.evaluate(async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input);
      return view ? (await view.capturePage()).toPNG().toString('base64') : '';
    }, pageUrl);
    writeFileSync(
      path.join(dir, `${name}-page.png`),
      Buffer.from(page, 'base64'),
    );
  };
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

test.describe('phase 10b: end-to-end workflows', () => {
  test('sign up: text fields, a date, a select, and a checkbox submit with Enter, then the terms are accepted in a cross-site frame, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(origin, 'controls', async (context) => {
      const { kind, run, electronApp } = context;
      const field = (id) => selector(`browser-lab-controls-${id}`);
      for (const [id, text] of [
        ['required', 'Ada Lovelace'],
        ['invalid-email', 'ada@example.test'],
        ['date', '2026-10-16'],
      ])
        executed(
          kind,
          await run({ type: 'browser.fill', locator: field(id), text }),
        );
      executed(
        kind,
        await run({
          type: 'browser.select_option',
          locator: field('select-single'),
          values: ['violet'],
        }),
      );
      executed(
        kind,
        await run({
          type: 'browser.set_checked',
          locator: field('checkbox-native'),
          checked: true,
        }),
      );
      executed(
        kind,
        await run({
          type: 'browser.press',
          locator: field('required'),
          key: 'Enter',
        }),
      );
      expect(
        await receivedFields(
          electronApp,
          `${origin}/browser-lab/controls/submit`,
        ),
      ).toMatchObject({
        requiredText: 'Ada Lovelace',
        email: 'ada@example.test',
        dateValue: '2026-10-16',
        singleSelect: 'violet',
        nativeCheckbox: 'checked',
      });

      // The terms are a form in a frame from another site.
      const url = await goTo(context, 'frames');
      const frame = await crossFrame(context, url);
      const inTerms = (id) => ({
        locator: selector(`browser-lab-frames-cross-site-${id}`),
        frame,
      });
      executed(
        kind,
        await run({ type: 'browser.fill', ...inTerms('name'), text: 'Ada' }),
      );
      executed(
        kind,
        await run({
          type: 'browser.select_option',
          ...inTerms('delivery'),
          values: ['express'],
        }),
      );
      executed(
        kind,
        await run({
          type: 'browser.set_checked',
          ...inTerms('consent'),
          checked: true,
        }),
      );
      executed(
        kind,
        await run({ type: 'browser.press', ...inTerms('name'), key: 'Enter' }),
      );
      await expect
        .poll(
          () =>
            inFrame(
              electronApp,
              url,
              '/browser-lab/frames/submit',
              `Object.fromEntries(Array.from(document.querySelectorAll('[data-browser-lab-field]'), (item) => [item.dataset.browserLabField, item.textContent]))`,
            ).catch(() => null),
          { timeout: 15_000 },
        )
        .toEqual({ name: 'Ada', delivery: 'express', consent: 'yes' });
    });
  });

  test('settings: a hover menu, a toggle switch, and an ARIA combobox with search, then save, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(origin, 'menus', async (context) => {
      const { kind, run, electronApp, url: menusUrl } = context;
      executed(
        kind,
        await run({
          type: 'browser.hover',
          locator: selector('browser-lab-menus-hover-trigger'),
        }),
      );
      executed(
        kind,
        await run({
          type: 'browser.click',
          locator: selector('browser-lab-menus-hover-two'),
        }),
      );
      await expect
        .poll(() =>
          readLab(
            electronApp,
            menusUrl,
            'browser-lab-menus-hover-status',
            'data-browser-lab-selection',
          ),
        )
        .toBe('hover-two');

      const url = await goTo(context, 'controls');
      const field = (id) => selector(`browser-lab-controls-${id}`);
      executed(
        kind,
        await run({
          type: 'browser.set_checked',
          locator: field('switch-aria'),
          checked: true,
        }),
      );
      expect(
        executed(
          kind,
          await run({
            type: 'browser.select_option',
            locator: field('combobox-input'),
            searchText: 'beta',
            values: ['beta'],
          }),
        ),
      ).toMatchObject({ target: { value: 'Beta' } });
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-combobox-status',
          'data-browser-lab-value',
        ),
      ).toBe('beta');
      // The settings form requires a name and an email before it saves.
      for (const [id, text] of [
        ['required', 'Ada Lovelace'],
        ['invalid-email', 'ada@example.test'],
      ])
        executed(
          kind,
          await run({ type: 'browser.fill', locator: field(id), text }),
        );
      executed(
        kind,
        await run({ type: 'browser.click', locator: field('echo-submit') }),
      );
      expect(
        await receivedFields(
          electronApp,
          `${origin}/browser-lab/controls/submit`,
        ),
      ).toMatchObject({ ariaSwitch: 'checked', requiredText: 'Ada Lovelace' });
    });
  });

  test('kanban: a card moves between columns by HTML5 drag, and a list reorders by pointer drag, through both routes', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'drag',
      async ({ kind, run, electronApp, url }) => {
        const columns = async () =>
          Object.fromEntries(
            String(
              await readLab(
                electronApp,
                url,
                'browser-lab-drag-board-status',
                'data-browser-lab-board',
              ),
            )
              .split('|')
              .map((column) => {
                const [name, cards] = column.split(':');
                return [name, cards ? cards.split(',') : []];
              }),
          );
        const before = await columns();
        expect(before.done).not.toContain('a');
        executed(
          kind,
          await run({
            type: 'browser.drag',
            from: { locator: selector('browser-lab-drag-card-a') },
            to: { locator: selector('browser-lab-drag-board-done') },
          }),
        );
        await expect.poll(async () => (await columns()).done).toContain('a');
        expect(
          Object.values(await columns())
            .flat()
            .sort(),
        ).toEqual(Object.values(before).flat().sort());

        executed(
          kind,
          await run({
            type: 'browser.drag',
            from: { locator: selector('browser-lab-drag-sort-item-a') },
            to: { locator: selector('browser-lab-drag-sort-item-c') },
          }),
        );
        await expect
          .poll(async () => {
            const order = String(
              await readLab(
                electronApp,
                url,
                'browser-lab-drag-sortable-status',
                'data-browser-lab-order',
              ),
            ).split(',');
            return (
              order.indexOf('a') > order.indexOf('b') && order.length === 5
            );
          })
          .toBe(true);
      },
    );
  });

  test('document editor: rich text in a contenteditable editor, then save, through both routes', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'editor',
      async ({ kind, run, electronApp, url }) => {
        const text = 'Release notes\nThe browser tools ship today.';
        executed(
          kind,
          await run({
            type: 'browser.fill',
            locator: selector('browser-lab-editor-model'),
            text,
          }),
        );
        expect(
          await readLab(
            electronApp,
            url,
            'browser-lab-editor-model-status',
            'data-browser-lab-model',
          ),
        ).toBe(text);
        executed(
          kind,
          await run({
            type: 'browser.click',
            locator: selector('browser-lab-editor-save'),
          }),
        );
        await expect
          .poll(() =>
            readLab(
              electronApp,
              url,
              'browser-lab-editor-saved',
              'data-browser-lab-state',
            ),
          )
          .toBe('saved');
        // The text the server received.
        expect(
          await readLab(
            electronApp,
            url,
            'browser-lab-editor-saved',
            'data-browser-lab-value',
          ),
        ).toBe(text);
      },
    );
  });

  test('support ticket: a workspace file is attached once the chat approves it, then the ticket is submitted and the server checks its hash, through the MCP routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(
      origin,
      'upload',
      async ({ kind, run, electronApp, window, userDataDir, url }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'ask',
        );
        const root = session.workspaceRoot;
        const still = stills(kind, electronApp, window);
        const echoUrl = `${origin}/browser-lab/upload-echo`;
        try {
          await still('ticket', url);
          const relativePath = 'support/ticket-details.txt';
          mkdirSync(path.join(root, 'support'), { recursive: true });
          writeFileSync(path.join(root, relativePath), TICKET_BODY);
          const card =
            chatPanelLocator(window).getByTestId('tool-approval-card');
          const attaching = run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-single-input'),
            files: [{ path: relativePath }],
          });
          await expect(card).toBeVisible({ timeout: 15_000 });
          await expect(card).toContainText(relativePath);
          await still('approval', url);
          await card.getByTestId('tool-approval-allow').click();
          const attachedResponse = await attaching;
          expect(executed(kind, attachedResponse)).toMatchObject({
            upload: {
              status: 'attached',
              files: [
                { name: 'ticket-details.txt', sha256: sha256Hex(TICKET_BODY) },
              ],
            },
          });
          expectPathFree(payloadOf(attachedResponse), `${kind} upload`, [
            userDataDir,
            root,
          ]);
          await expect
            .poll(() =>
              readLab(
                electronApp,
                url,
                'browser-lab-upload-single-result',
                'data-browser-lab-state',
              ),
            )
            .toBe('done');
          await still('attached', url);

          executed(
            kind,
            await run({
              type: 'browser.click',
              locator: selector('browser-lab-upload-single-submit'),
            }),
          );
          // The form posts to the echo route, which answers with each file's hash.
          let received;
          await expect
            .poll(
              async () => {
                received = await inLab(
                  electronApp,
                  echoUrl,
                  'document.body.innerText',
                ).catch(() => '');
                return received.trim().startsWith('{');
              },
              { timeout: 15_000 },
            )
            .toBe(true);
          await still('submitted', echoUrl);
          expect(JSON.parse(received).files).toEqual([
            {
              name: 'ticket-details.txt',
              size: Buffer.byteLength(TICKET_BODY),
              sha256: sha256Hex(TICKET_BODY),
            },
          ]);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
      {
        // The App Advisor dispatcher route has no chat panel to show the
        // upload's approval card in, as in browser-files' upload cases.
        routes: ['mcp', WORKTREE_ROUTE],
      },
    );
  });

  test('reports: a downloaded report is saved into the workspace with save_download and reads back, through both routes', async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'downloads',
      async ({ kind, run, electronApp, userDataDir }) => {
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(kind),
          'auto',
        );
        try {
          const clicked = executed(
            kind,
            await run({
              type: 'browser.click',
              locator: selector('browser-lab-downloads-attachment'),
            }),
          );
          const [report] = clicked.effects.downloads;
          expect(report).toMatchObject({
            fileName: REPORT_NAME,
            status: 'complete',
          });
          const relativePath = `reports/${REPORT_NAME}`;
          const saved = payloadOf(
            await run({
              type: 'browser.save_download',
              downloadId: report.id,
              path: relativePath,
            }),
          );
          expect(saved, `${kind}: ${JSON.stringify(saved)}`).toMatchObject({
            ok: true,
            transfer: { kind: 'copy', status: 'complete' },
          });
          expectPathFree(saved, `${kind} save_download`, [
            userDataDir,
            session.workspaceRoot,
          ]);
          expect(
            readFileSync(
              path.join(session.workspaceRoot, relativePath),
              'utf8',
            ),
          ).toBe(REPORT_BODY);
        } finally {
          await endApprovalSession(electronApp, session.id);
        }
      },
    );
  });

  test("invoice: the page's window.print() becomes a PDF task file once the agent accepts it, through both routes", async () => {
    test.setTimeout(180_000);
    await withBrowser(
      origin,
      'print',
      async ({ kind, run, electronApp, userDataDir, url }) => {
        await stubNativePrint(electronApp, url);
        const clicked = executed(
          kind,
          await run({
            type: 'browser.click',
            locator: selector('browser-lab-print-button'),
          }),
        );
        const request = clicked.effects.printRequest;
        expect(request).toMatchObject({ id: expect.stringMatching(/^print-/) });
        const accepted = payloadOf(
          await run({
            type: 'browser.handle_dialog',
            dialogId: request.id,
            accept: true,
          }),
        );
        expect(accepted, `${kind}: ${JSON.stringify(accepted)}`).toMatchObject({
          handled: {
            printRequestId: request.id,
            transfer: {
              kind: 'download',
              source: 'print',
              status: 'complete',
              fileName: expect.stringMatching(/\.pdf$/),
            },
          },
        });
        const { fileName } = accepted.handled.transfer;
        const folder = taskDownloadsDir(userDataDir);
        expect(filesIn(folder)).toContain(fileName);
        expect(
          readFileSync(path.join(folder, fileName)).subarray(0, 5).toString(),
        ).toBe('%PDF-');
      },
    );
  });

  test('web component checkout: card fields in a closed shadow root and in a cross-site frame take the card without it reaching a response, through both routes', async () => {
    test.setTimeout(240_000);
    await withBrowser(origin, 'shadow', async (context) => {
      const { kind, run, electronApp, url } = context;
      const card = 'browser-lab-shadow-closed-secret-card';
      const inShadow = await run({
        type: 'browser.fill',
        locator: selector(card),
        text: CARD,
      });
      expect(executed(kind, inShadow)).toMatchObject({
        target: { valueRedacted: true },
      });
      expect(JSON.stringify(inShadow)).not.toContain(CARD);
      expect(await closedRootValue(electronApp, url, card)).toBe(CARD);

      const framesUrl = await goTo(context, 'frames');
      const frame = await crossFrame(context, framesUrl);
      const frameCard = 'browser-lab-frames-cross-site-secret-card';
      const inFrameResponse = await run({
        type: 'browser.fill',
        locator: selector(frameCard),
        frame,
        text: CARD,
      });
      expect(executed(kind, inFrameResponse)).toMatchObject({
        target: { valueRedacted: true },
      });
      expect(JSON.stringify(inFrameResponse)).not.toContain(CARD);
      expect(
        await inFrame(
          electronApp,
          framesUrl,
          CROSS_FORM_PATH,
          `document.querySelector(${JSON.stringify(selector(frameCard))}).value`,
        ),
      ).toBe(CARD);
    });
  });
});
