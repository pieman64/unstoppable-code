import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '../../../..');
// The lab previews the Unstoppable brand unless CANOPY_BRAND picks another.
const selectedBrandId = process.env.CANOPY_BRAND ?? 'unstoppable-code';

export default defineConfig({
  root: configDir,
  appType: 'spa',
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
    open: '/composer-status-lab.html',
    fs: {
      allow: [repoRoot],
    },
    // Only source edits matter here. Build output, test artifacts and the
    // web app's generated client rewrite thousands of files (an E2E build
    // pegged the watcher), so they are not watched.
    watch: {
      ignored: [
        '**/out/**',
        '**/out-e2e/**',
        '**/.playwright/**',
        '**/.cache/**',
        '**/dist/**',
        '**/apps/web/**',
        '**/tests/**',
        '**/__tests__/**',
      ],
    },
  },
  // Build-time constants the app's renderer modules read (the real values
  // come from electron.vite.config.ts): a plain dev build with telemetry, E2E
  // hooks and Ollama off.
  define: {
    __CANOPY_E2E__: 'false',
    __CANOPY_E2E_WORKERS__: 'undefined',
    __CANOPY_E2E_WORKER_ACTIONS__: 'undefined',
    __CANOPY_E2E_HOME_HEADING_INDEX__: 'undefined',
    __CANOPY_TRANSCRIPT_PERF__: 'false',
    __CANOPY_OLLAMA_ENABLED__: 'false',
    __CANOPY_DESKTOP_SIDEBAR_SHADOW__: 'false',
    __CANOPY_DESKTOP_SHARED_SIDEBAR__: 'false',
    __CANOPY_DEV_MCP_PROXY_PORT__: 'undefined',
    __CANOPY_RELEASE_FLAVOR__: JSON.stringify('dev'),
    __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
    __CANOPY_UD_OAUTH_ENV__: JSON.stringify('production'),
    __CANOPY_INTERNAL_RELEASE_INDICATOR__: JSON.stringify(''),
    __CANOPY_UPDATE_BASE_URL__: JSON.stringify(''),
    __CANOPY_CURSOR_CLI__: JSON.stringify({ version: 'lab', artifacts: {} }),
    __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__: 'undefined',
    __CANOPY_GOOGLE_OAUTH_CLIENT_SECRET__: 'undefined',
    __CANOPY_MOCK_LLM_BASE_URL__: 'undefined',
    __CANOPY_LINEAR_API_BASE_URL__: 'undefined',
    __CANOPY_POSTHOG_ENABLED__: 'false',
    __CANOPY_POSTHOG_HOST__: 'undefined',
    __CANOPY_POSTHOG_PROJECT_KEY__: 'undefined',
    __CANOPY_POSTHOG_SESSION_REPLAY_SAMPLE_RATE__: 'undefined',
    __CANOPY_POSTHOG_STUB_URL__: 'undefined',
    ...Object.fromEntries(
      [
        'CLAUDE_CLI',
        'CLAUDE_SDK',
        'CODEX_CLI',
        'GH_CLI',
        'OCTOKIT',
        'RTK_CLI',
      ].map((name) => [`__DEP_${name}__`, JSON.stringify('lab')]),
    ),
  },
  esbuild: {
    jsx: 'automatic',
  },
  plugins: [
    {
      name: 'composer-status-lab-root',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          if (path === '/' || path === '/index.html') {
            res.statusCode = 302;
            res.setHeader('Location', '/composer-status-lab.html');
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(configDir, 'src'),
      '@canopy/protocol': resolve(repoRoot, 'packages/protocol/src'),
      '@canopy/plugin-interop': resolve(
        repoRoot,
        'packages/plugin-interop/src',
      ),
      '@canopy/pipeline-interop': resolve(
        repoRoot,
        'packages/pipeline-interop/src',
      ),
      '@canopy/app-core': resolve(repoRoot, 'packages/app-core/src'),
      '@canopy/app-state': resolve(repoRoot, 'packages/app-state/src'),
      '@canopy/desktop-shared': resolve(
        repoRoot,
        'packages/desktop-shared/src',
      ),
      '@canopy/desktop-instrumentation': resolve(
        repoRoot,
        'packages/desktop-instrumentation/src',
      ),
      '@canopy/ui-shared': resolve(repoRoot, 'packages/ui-shared/src'),
      '@canopy/ui-rich': resolve(repoRoot, 'packages/ui-rich/src'),
      '@canopy/ui-app': resolve(repoRoot, 'packages/ui-app/src'),
      '@canopy/brand/current': resolve(
        repoRoot,
        '.cache/brand',
        selectedBrandId,
        'desktop-brand.ts',
      ),
      '@canopy/brand/web': resolve(repoRoot, '.cache/brand/web-brands.ts'),
      '@repo/package.json': resolve(repoRoot, 'package.json'),
      'composer-lab/gateway-catalog': resolve(
        repoRoot,
        'apps/desktop-app/tests/electron/fixtures/pr3519-gateway-catalog.json',
      ),
    },
  },
});
