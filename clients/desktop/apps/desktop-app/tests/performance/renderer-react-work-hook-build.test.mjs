import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
// tsx loads the TypeScript module as CommonJS, so its exports arrive as the
// default export.
import hookBuild from '../../src/main/build/renderer-react-work-hook.ts';

const { compileRendererReactWorkHook, rendererReactWorkHookPlugin } = hookBuild;

/**
 * Builds a small renderer with the real plugin, so the production output
 * assertion and the E2E injection are exercised through Vite's own pipeline.
 */
const HOOK_MODULE = fileURLToPath(
  new URL('../../src/renderer/src/lib/react-work-hook.ts', import.meta.url),
);

async function buildRenderer({ e2e, entrySource }) {
  // Vite needs the real path: macOS temp directories sit behind a symlink.
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'react-work-hook-build-')),
  );
  try {
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head><meta charset="UTF-8" /></head><body><script type="module" src="./main.js"></script></body></html>',
    );
    await writeFile(path.join(root, 'main.js'), entrySource);
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        rendererReactWorkHookPlugin({
          e2e,
          compileHook: () => compileRendererReactWorkHook(HOOK_MODULE),
        }),
      ],
      build: { write: false, modulePreload: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (bundle) => bundle.output,
    );
    const html = outputs.find((output) => output.fileName === 'index.html');
    return { html: String(html?.source ?? '') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a production renderer build fails if its output installs a React DevTools hook', async () => {
  await assert.rejects(
    buildRenderer({
      e2e: false,
      entrySource:
        "Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: {} });\nconsole.info('app');\n",
    }),
    /production renderer must never install a React DevTools hook/,
  );
});

test('a production renderer build that only reads the hook passes without injecting it', async () => {
  const { html } = await buildRenderer({
    e2e: false,
    entrySource:
      "if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined') console.info(__REACT_DEVTOOLS_GLOBAL_HOOK__.supportsFiber);\n",
  });
  assert.doesNotMatch(html, /__CANOPY_REACT_WORK__/);
  assert.match(html, /<script type="module"/);
});

test('an E2E renderer build injects the hook as a classic script ahead of module execution', async () => {
  const { html } = await buildRenderer({
    e2e: true,
    entrySource: "console.info('app');\n",
  });
  const inline = [
    ...html.matchAll(
      /<script(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/script>/g,
    ),
  ]
    .map((match) => match.groups)
    .filter(({ body }) => body.includes('__CANOPY_REACT_WORK__'));
  assert.equal(inline.length, 1);
  // Classic scripts run while the page is parsed; module scripts only after.
  assert.doesNotMatch(inline[0].attributes, /type=/);
  assert.match(inline[0].body, /__REACT_DEVTOOLS_GLOBAL_HOOK__/);
});
