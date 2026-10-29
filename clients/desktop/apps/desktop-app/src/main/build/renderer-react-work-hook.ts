import { dirname } from 'node:path';
import { build } from 'esbuild';
import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * Build wiring for the E2E-only React work hook
 * (`apps/desktop-app/src/renderer/src/lib/react-work-hook.ts`).
 *
 * E2E renderer builds inject the hook as a classic inline script. Classic
 * scripts run while the page is parsed, and module scripts only after it, so
 * the hook exists before the vendor chunk evaluates `react-dom`. Production
 * builds inject nothing, and their output is checked: a shipped script or page
 * that installs a DevTools hook fails the build.
 */

const INSTALLATION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> =
  [
    { name: 'work-counter query', pattern: /__CANOPY_REACT_WORK__/ },
    {
      name: 'DevTools hook property',
      pattern: /["'`]__REACT_DEVTOOLS_GLOBAL_HOOK__["'`]/,
    },
    {
      name: 'DevTools hook assignment',
      pattern: /__REACT_DEVTOOLS_GLOBAL_HOOK__\s*=(?!=)/,
    },
  ];

/** Hook installation evidence in `source`; React merely reading it is fine. */
export function findReactWorkHookInstallation(source: string): string[] {
  return INSTALLATION_PATTERNS.filter(({ pattern }) =>
    pattern.test(source),
  ).map(({ name }) => name);
}

export type RendererBundleOutput =
  | { type: 'chunk'; fileName: string; code: string }
  | { type: 'asset'; fileName: string; source: string | Uint8Array };

/** `<file>: <evidence>` for every shipped script or page that installs it. */
export function findReactWorkHookInOutputs(
  outputs: readonly RendererBundleOutput[],
): string[] {
  const findings: string[] = [];
  const decoder = new TextDecoder();
  for (const output of outputs) {
    if (!/\.(?:m?js|html)$/.test(output.fileName)) continue;
    const text =
      output.type === 'chunk'
        ? output.code
        : typeof output.source === 'string'
          ? output.source
          : decoder.decode(output.source);
    const evidence = findReactWorkHookInstallation(text);
    if (evidence.length > 0)
      findings.push(`${output.fileName}: ${evidence.join(', ')}`);
  }
  return findings;
}

/**
 * Compiles the hook module to a self-contained script that installs it on
 * the page's global object. `__CANOPY_E2E__` is true because only E2E builds
 * compile it.
 */
export async function compileRendererReactWorkHook(
  hookModulePath: string,
): Promise<string> {
  const result = await build({
    stdin: {
      contents:
        "import { installReactWorkHook } from './react-work-hook';\ninstallReactWorkHook(globalThis);\n",
      resolveDir: dirname(hookModulePath),
      sourcefile: 'react-work-hook-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    define: { __CANOPY_E2E__: 'true' },
  });
  const [output] = result.outputFiles;
  if (!output)
    throw new Error('React work hook compilation produced no output');
  return output.text;
}

/** The inline script tag E2E pages receive; none for other builds. */
export async function reactWorkHookHtmlTags(
  e2e: boolean,
  compileHook: () => Promise<string>,
): Promise<HtmlTagDescriptor[]> {
  if (!e2e) return [];
  const code = await compileHook();
  return [
    {
      tag: 'script',
      // Classic, not `type="module"`: it must run before any module script.
      children: code.replace(/<\/script/gi, '<\\/script'),
      injectTo: 'head',
    },
  ];
}

export function rendererReactWorkHookPlugin(options: {
  e2e: boolean;
  compileHook: () => Promise<string>;
}): Plugin {
  return {
    name: 'canopy:renderer-react-work-hook',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: (): Promise<HtmlTagDescriptor[]> =>
        reactWorkHookHtmlTags(options.e2e, options.compileHook),
    },
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle): void {
        if (options.e2e) return;
        const findings = findReactWorkHookInOutputs(Object.values(bundle));
        if (findings.length > 0) {
          this.error(
            `The production renderer must never install a React DevTools hook; found ${findings.join('; ')}`,
          );
        }
      },
    },
  };
}
