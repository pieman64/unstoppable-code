import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build, type Metafile } from 'esbuild';

/**
 * Import boundaries of the renderer's window entries, read from each HTML
 * page's module script. esbuild resolves the same TypeScript graph Vite
 * builds; only `import` statements count as loaded at startup, while
 * `import()` targets load on demand.
 */
const REPO_ROOT = resolve(__dirname, '../../../../../..');
const RENDERER_ROOT = join(REPO_ROOT, 'apps/desktop-app/src/renderer');
const SRC = 'apps/desktop-app/src/renderer/src';

function pageEntry(page: string): string {
  const html = readFileSync(join(RENDERER_ROOT, page), 'utf8');
  const src = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  if (!src) throw new Error(`${page} has no module script`);
  return relative(REPO_ROOT, resolve(RENDERER_ROOT, src));
}

async function metafileFor(entry: string): Promise<Metafile> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    outdir: join(REPO_ROOT, '.cache/renderer-entry-graph'),
    metafile: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    tsconfig: 'apps/desktop-app/tsconfig.web.json',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    plugins: [
      {
        name: 'workspace-only',
        setup(pluginBuild): void {
          // Follow workspace sources; keep packages and Vite query imports
          // (`?worker&url`, `?raw`) as named edges.
          pluginBuild.onResolve({ filter: /.*/ }, (args) =>
            !args.path.includes('?') &&
            /^(?:\.|\/|@\/|@canopy\/)/.test(args.path)
              ? undefined
              : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  return result.metafile;
}

/** Files and packages an entry loads through `import` statements. */
function staticClosure(metafile: Metafile, entry: string): Set<string> {
  const loaded = new Set<string>();
  const queue = [entry];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (loaded.has(next)) continue;
    loaded.add(next);
    for (const edge of metafile.inputs[next]?.imports ?? []) {
      if (edge.kind === 'import-statement') queue.push(edge.path);
    }
  }
  return loaded;
}

async function startupGraph(page: string): Promise<{
  all: Set<string>;
  startup: Set<string>;
}> {
  const entry = pageEntry(page);
  const metafile = await metafileFor(entry);
  return {
    all: new Set(Object.keys(metafile.inputs)),
    startup: staticClosure(metafile, entry),
  };
}

const LAZY_AT_STARTUP = [
  '@xyflow/react',
  'react-diff-viewer-continued',
  `${SRC}/components/plan-explore/diagram/PlanSequenceDiagramView.tsx`,
  `${SRC}/components/plan-explore/diagram/PlanLogicDiffDiagramView.tsx`,
  `${SRC}/components/plan-explore/diagram/PlanDataModelDiffDiagramView.tsx`,
  `${SRC}/components/pipeline/flow/PipelineFlowDiagramView.tsx`,
];

describe('renderer window entries', () => {
  jest.setTimeout(60_000);

  it('App Advisor never loads the main window app', async () => {
    const advisor = await startupGraph('app-advisor.html');

    expect(advisor.startup.has(`${SRC}/AppAdvisorWindowApp.tsx`)).toBe(true);
    // Not even on demand: nothing in its graph reaches the main app.
    expect(advisor.all.has(`${SRC}/App.tsx`)).toBe(false);
    expect(
      advisor.all.has(`${SRC}/components/DesktopResourceContextProvider.tsx`),
    ).toBe(false);
  });

  it('the main window does not load the App Advisor app', async () => {
    const main = await startupGraph('index.html');

    expect(main.startup.has(`${SRC}/App.tsx`)).toBe(true);
    expect(
      main.startup.has(`${SRC}/components/DesktopResourceContextProvider.tsx`),
    ).toBe(true);
    expect(main.all.has(`${SRC}/AppAdvisorWindowApp.tsx`)).toBe(false);
  });

  it.each(['index.html', 'app-advisor.html'])(
    '%s loads React Flow and the diff viewer only on demand',
    async (page) => {
      const { startup } = await startupGraph(page);

      expect(LAZY_AT_STARTUP.filter((file) => startup.has(file))).toEqual([]);
    },
  );
});
