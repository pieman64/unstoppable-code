import {
  findRendererStartupViolations,
  rendererManualChunk,
} from '../renderer-chunks';

describe('rendererManualChunk', () => {
  it("gives Vite's preload helper its own chunk instead of a lazy vendor chunk", () => {
    expect(rendererManualChunk('\0vite/preload-helper.js')).toBe(
      'vendor-vite-preload-helper',
    );
  });

  it('keeps shared diff-viewer dependencies out of the lazy diff chunk', () => {
    expect(
      rendererManualChunk('/repo/node_modules/js-yaml/dist/js-yaml.mjs'),
    ).toBe('vendor-js-yaml');
  });

  it("keeps React's store shim with React, out of the lazy xyflow chunk", () => {
    // xyflow's nested zustand 4 and the app's zustand 5 both import it.
    expect(
      rendererManualChunk(
        '/repo/node_modules/use-sync-external-store/shim/with-selector.js',
      ),
    ).toBe('vendor-react');
    expect(
      rendererManualChunk(
        '\0/repo/node_modules/use-sync-external-store/shim/with-selector.js?commonjs-module',
      ),
    ).toBe('vendor-react');
  });

  it('keeps the xyflow stylesheet apart from the lazily loaded library', () => {
    expect(
      rendererManualChunk('/repo/node_modules/@xyflow/react/dist/style.css'),
    ).toBeUndefined();
    expect(
      rendererManualChunk('/repo/node_modules/@xyflow/react/dist/esm/index.js'),
    ).toBe('vendor-xyflow');
  });

  it('keeps the existing vendor and SDK chunks', () => {
    expect(
      rendererManualChunk(
        '/repo/node_modules/@datadog/browser-rum/esm/index.js',
      ),
    ).toBe('datadog-sdk');
    expect(
      rendererManualChunk(
        '/repo/node_modules/react-diff-viewer-continued/lib/esm/src/index.js',
      ),
    ).toBe('vendor-diff');
    expect(rendererManualChunk('/repo/node_modules/react-dom/client.js')).toBe(
      'vendor-react',
    );
    expect(
      rendererManualChunk('/repo/apps/desktop-app/src/renderer/src/App.tsx'),
    ).toBeUndefined();
  });
});

describe('findRendererStartupViolations', () => {
  function chunk(
    fileName: string,
    name: string,
    options: {
      isEntry?: boolean;
      facadeModuleId?: string;
      imports?: string[];
      moduleIds?: string[];
    } = {},
  ): {
    type: 'chunk';
    name: string;
    fileName: string;
    isEntry: boolean;
    facadeModuleId: string | null;
    imports: string[];
    moduleIds: string[];
  } {
    return {
      type: 'chunk',
      name,
      fileName,
      isEntry: options.isEntry ?? false,
      facadeModuleId: options.facadeModuleId ?? null,
      imports: options.imports ?? [],
      moduleIds: options.moduleIds ?? [],
    };
  }

  const boundaries = [
    {
      entryModule: '/src/app-advisor-entry.tsx',
      forbiddenModules: ['/src/App.tsx'],
    },
  ];

  it('accepts on-demand chunks reached only through dynamic imports', () => {
    expect(
      findRendererStartupViolations(
        {
          'entry.js': chunk('entry.js', 'index', {
            isEntry: true,
            facadeModuleId: '/repo/src/app-advisor-entry.tsx',
            imports: ['shared.js'],
          }),
          'shared.js': chunk('shared.js', 'shared', {
            moduleIds: ['/repo/src/main.tsx'],
          }),
          'xyflow.js': chunk('xyflow.js', 'vendor-xyflow'),
          'app.js': chunk('app.js', 'App', {
            moduleIds: ['/repo/src/App.tsx'],
          }),
          'style.css': { type: 'asset' },
        },
        boundaries,
      ),
    ).toEqual([]);
  });

  it('reports on-demand chunks and forbidden modules on the startup path', () => {
    expect(
      findRendererStartupViolations(
        {
          'entry.js': chunk('entry.js', 'index', {
            isEntry: true,
            facadeModuleId: '/repo/src/app-advisor-entry.tsx',
            imports: ['shared.js'],
          }),
          'shared.js': chunk('shared.js', 'shared', {
            imports: ['diff.js'],
            moduleIds: ['/repo/src/App.tsx'],
          }),
          'diff.js': chunk('diff.js', 'vendor-diff'),
        },
        boundaries,
      ),
    ).toEqual([
      '/repo/src/app-advisor-entry.tsx loads on-demand chunk vendor-diff',
      '/repo/src/app-advisor-entry.tsx loads /src/App.tsx (shared.js)',
    ]);
  });
  it('finds the entry module inside an HTML page entry chunk', () => {
    // Vite names the page as the facade of an HTML input's entry chunk.
    expect(
      findRendererStartupViolations(
        {
          'entry.js': chunk('entry.js', 'app-advisor', {
            isEntry: true,
            facadeModuleId: '/repo/src/app-advisor.html',
            imports: ['shared.js'],
            moduleIds: [
              '/repo/src/app-advisor-entry.tsx',
              '/repo/src/app-advisor.html',
            ],
          }),
          'shared.js': chunk('shared.js', 'shared', {
            moduleIds: ['/repo/src/App.tsx'],
          }),
        },
        boundaries,
      ),
    ).toEqual(['/repo/src/app-advisor.html loads /src/App.tsx (shared.js)']);
  });

  it('reports a boundary whose entry module no entry chunk contains', () => {
    expect(
      findRendererStartupViolations(
        {
          'entry.js': chunk('entry.js', 'index', {
            isEntry: true,
            facadeModuleId: '/repo/src/index.html',
            moduleIds: ['/repo/src/main-window-entry.tsx'],
          }),
        },
        boundaries,
      ),
    ).toEqual(['no renderer entry loads /src/app-advisor-entry.tsx']);
  });
});
