import {
  RENDERER_OBFUSCATION_OPTIONS,
  type RendererChunkMetadata,
  isObfuscatedRendererChunk,
  shouldObfuscateRendererChunk,
} from '../renderer-obfuscation';

describe('RENDERER_OBFUSCATION_OPTIONS', () => {
  it('keeps identifier obfuscation without runtime-heavy transforms', () => {
    expect(RENDERER_OBFUSCATION_OPTIONS).toMatchObject({
      compact: true,
      identifierNamesGenerator: 'hexadecimal',
      simplify: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      numbersToExpressions: false,
      splitStrings: false,
      stringArray: false,
      transformObjectKeys: false,
    });
  });
});

function chunk(
  name: string,
  moduleIds: string[] = [],
  facadeModuleId: string | null = null,
): RendererChunkMetadata {
  return { facadeModuleId, moduleIds, name };
}

describe('shouldObfuscateRendererChunk', () => {
  it('obfuscates first-party renderer chunks when vendor obfuscation is disabled', () => {
    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-abc123.js',
        chunk('workspace-panel', [
          '/repo/apps/desktop-app/src/renderer/src/WorkspacePanel.tsx',
        ]),
        { obfuscateVendor: false },
      ),
    ).toBe(true);
  });

  it('excludes manual vendor chunks by chunk name even when filenames are hash-only', () => {
    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-abc123.js',
        chunk('vendor-react', ['/repo/node_modules/react/index.js']),
        { obfuscateVendor: false },
      ),
    ).toBe(false);
  });

  it('excludes Datadog chunks by chunk name and module id', () => {
    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-abc123.js',
        chunk('datadog-sdk', [
          '/repo/node_modules/@datadog/browser-rum/esm/index.js',
        ]),
        { obfuscateVendor: false },
      ),
    ).toBe(false);

    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-def456.js',
        chunk('chunk-def456', [
          '/repo/node_modules/@datadog/browser-rum/esm/index.js',
        ]),
        { obfuscateVendor: false },
      ),
    ).toBe(false);
  });

  it.each(['?worker&url', '?worker', '?worker&inline'])(
    'keeps the application entry obfuscated when it imports a %s worker proxy',
    (query) => {
      expect(
        shouldObfuscateRendererChunk(
          'assets/entry-abc123.js',
          chunk('index', [
            '/repo/apps/desktop-app/src/renderer/src/App.tsx',
            `/repo/apps/desktop-app/src/renderer/src/lib/file-viewer/office-parse.worker.ts${query}`,
          ]),
          { obfuscateVendor: false },
        ),
      ).toBe(true);
    },
  );

  it('still excludes actual Vite worker entries carrying worker_file metadata', () => {
    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-abc123.js',
        chunk('parser', ['/repo/src/parser.ts?worker_file&type=module']),
        { obfuscateVendor: false },
      ),
    ).toBe(false);
  });

  it('excludes worker chunks by module metadata', () => {
    expect(
      shouldObfuscateRendererChunk(
        'assets/chunk-abc123.js',
        chunk('editor-worker', [
          '/repo/node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
        ]),
        { obfuscateVendor: false },
      ),
    ).toBe(false);
  });

  it('obfuscates vendor, worker, and Datadog chunks when explicitly enabled', () => {
    for (const rendererChunk of [
      chunk('vendor-react', ['/repo/node_modules/react/index.js']),
      chunk('datadog-sdk', [
        '/repo/node_modules/@datadog/browser-rum/esm/index.js',
      ]),
      chunk('editor-worker', [
        '/repo/node_modules/monaco-editor/esm/vs/editor/editor.worker.js',
      ]),
    ]) {
      expect(
        shouldObfuscateRendererChunk('assets/chunk-abc123.js', rendererChunk, {
          obfuscateVendor: true,
        }),
      ).toBe(true);
    }
  });
});

describe('isObfuscatedRendererChunk', () => {
  const RELEASE = { enabled: true, obfuscateVendor: false };

  it('obfuscates the PostHog SDK chunk in release builds, as it always has', () => {
    // Only `vendor-*`, Datadog and worker chunks skip obfuscation, so the
    // `posthog-sdk` chunk is obfuscated and then loses only whitespace.
    expect(
      isObfuscatedRendererChunk(
        'assets/posthog-sdk-abc123.js',
        chunk('posthog-sdk', ['/repo/node_modules/posthog-js/dist/module.js']),
        RELEASE,
      ),
    ).toBe(true);
  });

  it('leaves vendor and Datadog chunks to full minification in release builds', () => {
    for (const rendererChunk of [
      chunk('vendor-xyflow', ['/repo/node_modules/@xyflow/react/index.js']),
      chunk('datadog-sdk', [
        '/repo/node_modules/@datadog/browser-rum/esm/index.js',
      ]),
    ]) {
      expect(
        isObfuscatedRendererChunk(
          'assets/chunk-abc123.js',
          rendererChunk,
          RELEASE,
        ),
      ).toBe(false);
    }
  });
});
