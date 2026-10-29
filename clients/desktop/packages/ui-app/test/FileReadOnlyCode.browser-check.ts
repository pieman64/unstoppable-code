/**
 * CAN-4275 real Chromium component geometry, without an Electron/Next build.
 * Run from the repo root:
 * node --test packages/ui-app/test/FileReadOnlyCode.browser-check.ts
 * Uses installed Chrome headlessly; set CANOPY_COMPONENT_BROWSER_CHANNEL to
 * chromium to use Playwright's installed Chromium instead.
 * Bundles only the production component and uses the real Tailwind/token CSS.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { FileReadOnlyCodeProps } from '../src/code/file/FileReadOnlyCode';

declare global {
  interface Window {
    renderText: (props: FileReadOnlyCodeProps) => void;
  }
}

let browser: Browser;
let componentScript: string;
let css: string;

before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { FileReadOnlyCode } from './packages/ui-app/src/code/file/FileReadOnlyCode';
        const root = createRoot(document.getElementById('viewer'));
        window.renderText = (props) => flushSync(() => root.render(
          React.createElement(React.StrictMode, null, React.createElement(FileReadOnlyCode, props)),
        ));
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  componentScript = bundle.outputFiles[0].text;
  css = (
    await postcss([tailwindcss()]).process(
      `
    @import 'tailwindcss' source(none);
    @import './packages/ui-shared/src/styles/canopy-tokens.css';
    @source './packages/ui-app/src/code/file/FileReadOnlyCode.tsx';
  `,
      { from: path.join(process.cwd(), 'can4275-component.css') },
    )
  ).css;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CANOPY_COMPONENT_BROWSER_CHANNEL ?? 'chrome',
  });
});

after(async () => {
  await browser?.close();
});

async function withViewer(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  try {
    await page.setContent(`<!doctype html><style>${css}</style>
      <div style="height:900px"></div>
      <div id="viewer" style="height:200px;width:600px;display:flex;flex-direction:column"></div>
      <pre id="reference" style="height:200px;width:600px;overflow:auto;white-space:pre;padding:12px 16px;line-height:20px;font-size:12px;font-family:monospace"></pre>
      <div style="height:900px"></div>`);
    await page.addScriptTag({ content: componentScript });
    await page.evaluate(() => window.scrollTo(0, 800));
    await run(page);
  } finally {
    await page.close();
  }
}

async function render(page: Page, props: FileReadOnlyCodeProps): Promise<void> {
  await page.evaluate((next) => {
    const reference = document.getElementById('reference');
    if (!reference) throw new Error('Missing reference pre');
    reference.textContent = next.content;
    window.renderText(next);
  }, props);
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="file-viewer-raw-text-scroll"]'),
  );
}

interface Geometry {
  text: string | null;
  rangeText: string | null;
  targetText: string | null;
  targetHeight: number;
  targetInContent: number;
  targetInViewport: number;
  rangeHeight: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  referenceTop: number | null;
  lineHeight: number;
  paddingTop: number;
  pageScroll: number;
}

async function geometry(
  page: Page,
  content: string,
  line: number,
): Promise<Geometry> {
  return page.evaluate(
    ({ content, line }) => {
      const pre = document.querySelector<HTMLPreElement>(
        '[data-testid="file-viewer-raw-text-scroll"]',
      );
      const target = document.querySelector<HTMLSpanElement>(
        '[data-testid="file-viewer-line-target"]',
      );
      const highlight = document.querySelector<HTMLSpanElement>(
        '[data-testid="file-viewer-line-range"]',
      );
      const reference = document.getElementById('reference');
      if (!pre || !target || !highlight || !reference)
        throw new Error('Missing geometry fixture');
      const preRect = pre.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight);
      // Use an actual DOM text Range in an unhighlighted reference to compare
      // source-line position; no data-line-* attribute supplies geometry.
      const offset = content
        .split('\n')
        .slice(0, line - 1)
        .reduce((total, text) => total + text.length + 1, 0);
      let referenceTop: number | null = null;
      if (
        offset < content.length &&
        content[offset] !== '\n' &&
        content[offset] !== '\r'
      ) {
        if (!reference.firstChild) throw new Error('Missing reference text');
        const range = document.createRange();
        range.setStart(reference.firstChild, offset);
        range.setEnd(reference.firstChild, offset + 1);
        referenceTop =
          range.getBoundingClientRect().top -
          reference.getBoundingClientRect().top;
      }
      return {
        text: pre.textContent,
        rangeText: highlight.textContent,
        targetText: target.textContent,
        targetHeight: targetRect.height,
        targetInContent: targetRect.top - preRect.top + pre.scrollTop,
        targetInViewport: targetRect.top - preRect.top,
        rangeHeight: highlight.getBoundingClientRect().height,
        scrollTop: pre.scrollTop,
        scrollHeight: pre.scrollHeight,
        viewportHeight: pre.clientHeight,
        referenceTop,
        lineHeight,
        paddingTop: Number.parseFloat(getComputedStyle(pre).paddingTop),
        pageScroll: window.scrollY,
      };
    },
    { content, line },
  );
}

const longContent = Array.from(
  { length: 220 },
  (_, i) => `marker ${i + 1} π 😀`,
).join('\n');

void test('long range centers its actual first line and leaves the page still', async () => {
  await withViewer(async (page) => {
    await render(page, {
      content: longContent,
      fileIdentity: 'a',
      reveal: { line: 150, lineEnd: 210, revision: 1 },
    });
    const result = await geometry(page, longContent, 150);
    assert.equal(result.text, longContent);
    assert.equal(result.pageScroll, 800);
    assert.equal(result.targetText, '');
    assert.equal(result.targetHeight, result.lineHeight);
    assert.ok(result.scrollTop > 2000);
    assert.ok(
      Math.abs(
        result.targetInViewport -
          (result.viewportHeight - result.lineHeight) / 2,
      ) <= 1,
    );
    assert.ok(
      Math.abs(
        result.targetInContent -
          ((150 - 1) * result.lineHeight + result.paddingTop),
      ) <= 1,
    );
    assert.equal(result.rangeHeight, 61 * result.lineHeight);
    // Glyph ascent can differ from the line box; it must remain on that row.
    assert.notEqual(result.referenceTop, null);
    assert.ok(
      Math.abs(result.targetInContent - (result.referenceTop ?? 0)) <
        result.lineHeight,
    );
  });
});

void test('identical requests replay on file changes and revisions, and edits keep scroll', async () => {
  await withViewer(async (page) => {
    const reveal = { line: 150, lineEnd: 160, revision: 1 };
    await render(page, { content: longContent, fileIdentity: 'a', reveal });
    await page
      .locator('[data-testid="file-viewer-raw-text-scroll"]')
      .evaluate((el) => {
        el.scrollTop = 0;
      });
    await render(page, {
      content: longContent.replaceAll('marker', 'second'),
      fileIdentity: 'b',
      reveal,
    });
    assert.ok((await geometry(page, longContent, 150)).scrollTop > 2000);
    await page
      .locator('[data-testid="file-viewer-raw-text-scroll"]')
      .evaluate((el) => {
        el.scrollTop = 17;
      });
    await render(page, {
      content: `${longContent}\nedit`,
      fileIdentity: 'b',
      reveal,
    });
    assert.equal((await geometry(page, longContent, 150)).scrollTop, 17);
    await render(page, {
      content: longContent,
      fileIdentity: 'b',
      reveal: { ...reveal, revision: 2 },
    });
    assert.ok((await geometry(page, longContent, 150)).scrollTop > 2000);
  });
});

const edgeCases: ReadonlyArray<
  readonly [string, string, number, number, string]
> = [
  ['empty', '', 1, 1, ''],
  ['blank', 'a\n\n\nb', 2, 3, '\n\n'],
  ['CRLF', 'a\r\nb\r\nc', 2, 2, 'b\r\n'],
  ['Unicode', 'π\n😀 x\n中文', 2, 3, '😀 x\n中文'],
  ['final empty', 'a\nb\n', 3, 3, ''],
  ['range through final empty', 'a\nb\n', 2, 3, 'b\n'],
  ['clamped', 'a\nb', 999, 999, 'b'],
];
for (const [label, content, line, lineEnd, rangeText] of edgeCases) {
  void test(`${label} lines preserve bytes and have a line-tall target at the correct row`, async () => {
    await withViewer(async (page) => {
      await render(page, {
        content,
        fileIdentity: label,
        reveal: { line, lineEnd },
      });
      const result = await geometry(
        page,
        content,
        Math.min(line, content.split('\n').length),
      );
      assert.equal(result.text, content);
      assert.equal(result.rangeText, rangeText);
      assert.equal(result.targetText, '');
      assert.equal(result.targetHeight, result.lineHeight);
      const lineCount = content.split('\n').length;
      const clamped = Math.min(line, lineCount);
      assert.equal(
        result.rangeHeight,
        (Math.min(lineEnd, lineCount) - clamped + 1) * result.lineHeight,
      );
      assert.ok(
        Math.abs(
          result.targetInContent -
            ((clamped - 1) * result.lineHeight + result.paddingTop),
        ) <= 1,
        JSON.stringify(result),
      );
      assert.equal(result.pageScroll, 800);
    });
  });
}
