// Test-only component host inside the real Electron renderer. It exposes no
// production route, API or capability and mounts the actual shared primitives.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedPanelWorktree } from './panelHarness.mjs';
import { closeCanopy } from './launchCanopy.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const artifactRoot = path.join(
  repoRoot,
  '.playwright/sidebar-groups-primitives',
);

export async function launchSidebarItemGroupHarness(
  stage = 'after',
  options = {},
) {
  mkdirSync(artifactRoot, { recursive: true });
  const sourceRoot = path.join(
    repoRoot,
    '.playwright/sidebar-groups-primitives-baseline-source',
  );
  const baseline = stage === 'before';
  const outfile = path.join(artifactRoot, `fixture-${stage}.js`);
  if (baseline) {
    mkdirSync(sourceRoot, { recursive: true });
    const archive = execFileSync(
      'git',
      [
        'archive',
        process.env.SIDEBAR_GROUP_PRIMITIVES_BASE_REF || 'HEAD',
        'packages/ui-shared',
        'packages/protocol',
        'packages/agent-transcript',
        'tsconfig.base.json',
      ],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync('tar', ['-x', '-C', sourceRoot], { input: archive });
  }
  const legacyEntry = `import {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {WorktreeRow} from '${path.join(sourceRoot, 'packages/ui-shared/src/components/WorktreeRow.tsx')}';
    import {ColorSwatchPicker} from '${path.join(sourceRoot, 'packages/ui-shared/src/components/ColorSwatchPicker.tsx')}';
    function Harness(){const [color,setColor]=useState();return <main data-testid="primitives-harness" className="bg-base fg-primary p-6" style={{width:380}}><h1 className="mb-3 text-s fg-secondary">Projects</h1><section className="bg-secondary p-2" data-testid="group-area">{['Release notes','Checkout form','Dark mode polish','Fix upload test'].map((branchLabel,i)=><WorktreeRow key={branchLabel} branchLabel={branchLabel} uiStatus={i===2?'unread':'idle'} selected={i===1}/>)}</section><h2 className="mt-4 mb-2 text-s fg-secondary">Project color</h2><ColorSwatchPicker value={color} onChange={setColor} testId="legacy-swatches"/></main>};createRoot(document.getElementById('root')).render(<Harness/>);`;
  await build({
    ...(baseline
      ? {
          stdin: { contents: legacyEntry, resolveDir: repoRoot, loader: 'tsx' },
        }
      : {
          entryPoints: [
            path.join(
              repoRoot,
              'packages/ui-shared/src/components/__tests__/fixtures/sidebar-item-group-primitives.tsx',
            ),
          ],
        }),
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      '@canopy/protocol': path.join(
        baseline ? sourceRoot : repoRoot,
        'packages/protocol/src',
      ),
      '@canopy/agent-transcript': path.join(
        baseline ? sourceRoot : repoRoot,
        'packages/agent-transcript/src',
      ),
    },
  });
  const cssRoot = path.join(repoRoot, 'out-e2e/renderer/assets');
  const cssFiles = readdirSync(cssRoot).filter((name) => name.endsWith('.css'));
  const mode =
    process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : 'light';
  const html = path.join(artifactRoot, `fixture-${stage}.html`);
  writeFileSync(
    html,
    `<!doctype html><html data-theme="default" data-color-mode="${mode}" class="${mode}"><head>${cssFiles.map((name) => `<link rel="stylesheet" href="${pathToFileURL(path.join(cssRoot, name))}">`).join('')}</head><body><div id="root"></div><script>${readFileSync(outfile, 'utf8').replaceAll('</script', '<\\/script')}</script></body></html>`,
  );
  const app = await seedPanelWorktree();
  try {
    const fixtureUrl = pathToFileURL(html);
    if (options.hideFirstMemberOnCollapse)
      fixtureUrl.searchParams.set('hideFirstMemberOnCollapse', 'true');
    await app.window.goto(fixtureUrl.href);
    await app.window.getByTestId('primitives-harness').waitFor();
    return app;
  } catch (error) {
    await closeCanopy(app.electronApp, app.userDataDir);
    throw error;
  }
}
