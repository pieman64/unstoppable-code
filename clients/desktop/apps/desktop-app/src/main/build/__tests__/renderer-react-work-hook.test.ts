import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  compileRendererReactWorkHook,
  findReactWorkHookInOutputs,
  findReactWorkHookInstallation,
  reactWorkHookHtmlTags,
  rendererReactWorkHookPlugin,
} from '../renderer-react-work-hook';

const HOOK_MODULE = join(
  __dirname,
  '../../../renderer/src/lib/react-work-hook.ts',
);
const compileHook = (): Promise<string> =>
  compileRendererReactWorkHook(HOOK_MODULE);

// React's own read-only use of the hook, as it appears in react-dom builds.
const REACT_DOM_HOOK_READS = `
if ("undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__) {
  var hook$jscomp$inline_2348 = __REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook$jscomp$inline_2348.isDisabled && hook$jscomp$inline_2348.supportsFiber)
    rendererID = hook$jscomp$inline_2348.inject(internals);
}
if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === "undefined" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== "function") return;
__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
`;

describe('renderer React work hook build', () => {
  let compiled: string;
  beforeAll(async () => {
    compiled = await compileHook();
  }, 60_000);

  it('compiles a self-contained classic script that installs the hook', () => {
    expect(compiled).not.toMatch(/^\s*(?:import|export)\b/m);
    const context: Record<string, unknown> = {};
    context.globalThis = context;
    runInNewContext(compiled, context);

    expect(context.__REACT_DEVTOOLS_GLOBAL_HOOK__).toMatchObject({
      supportsFiber: true,
    });
    expect(context.__CANOPY_REACT_WORK__).toBeDefined();
  });

  it('recognizes hook installation code but not React reading the hook', () => {
    expect(findReactWorkHookInstallation(compiled)).not.toEqual([]);
    expect(
      findReactWorkHookInstallation(
        'window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true };',
      ),
    ).toEqual(['DevTools hook assignment']);
    expect(
      findReactWorkHookInstallation(
        'Object.defineProperty(e,"__REACT_DEVTOOLS_GLOBAL_HOOK__",{value:h})',
      ),
    ).toEqual(['DevTools hook property']);
    expect(findReactWorkHookInstallation(REACT_DOM_HOOK_READS)).toEqual([]);
  });

  it('flags every shipped script or page that carries the hook', () => {
    expect(
      findReactWorkHookInOutputs([
        {
          type: 'chunk',
          fileName: 'assets/chunk-react.js',
          code: REACT_DOM_HOOK_READS,
        },
        { type: 'chunk', fileName: 'assets/entry.js', code: compiled },
        {
          type: 'asset',
          fileName: 'index.html',
          source: `<script>${compiled}</script>`,
        },
        { type: 'asset', fileName: 'assets/app.css', source: compiled },
        {
          type: 'asset',
          fileName: 'assets/worker.js',
          source: new TextEncoder().encode(compiled),
        },
      ]),
    ).toEqual([
      expect.stringMatching(/^assets\/entry\.js: /),
      expect.stringMatching(/^index\.html: /),
      expect.stringMatching(/^assets\/worker\.js: /),
    ]);
  });

  it('injects a classic inline script into E2E pages only', async () => {
    await expect(reactWorkHookHtmlTags(false, compileHook)).resolves.toEqual(
      [],
    );
    const tags = await reactWorkHookHtmlTags(true, () =>
      Promise.resolve('hook();</script>'),
    );
    expect(tags).toEqual([
      {
        tag: 'script',
        children: 'hook();<\\/script>',
        injectTo: 'head',
      },
    ]);
  });

  it('builds as a renderer plugin that guards production output', () => {
    const plugin = rendererReactWorkHookPlugin({
      e2e: false,
      compileHook,
    });
    expect(plugin).toMatchObject({
      name: 'canopy:renderer-react-work-hook',
      apply: 'build',
      enforce: 'post',
    });
  });
});
