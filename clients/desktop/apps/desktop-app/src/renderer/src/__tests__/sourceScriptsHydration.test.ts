import { createEditableScripts } from '../lib/editableScripts';
import { applyHydratedSourceScripts } from '../lib/sourceScriptsHydration';

describe('applyHydratedSourceScripts', () => {
  it('hydrates drafts when the user has not edited them yet', () => {
    const nextLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });

    expect(applyHydratedSourceScripts({}, {}, nextLoadedSourceScripts)).toEqual(
      {
        sourceScripts: nextLoadedSourceScripts,
        loadedSourceScripts: nextLoadedSourceScripts,
      },
    );
  });

  it('preserves in-flight drafts when async data arrives late', () => {
    const currentLoadedSourceScripts = {};
    const currentSourceScripts = createEditableScripts({
      setup: 'pnpm install --offline',
    });
    const nextLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });

    expect(
      applyHydratedSourceScripts(
        currentSourceScripts,
        currentLoadedSourceScripts,
        nextLoadedSourceScripts,
      ),
    ).toEqual({
      sourceScripts: createEditableScripts({
        setup: 'pnpm install --offline',
      }),
      loadedSourceScripts: nextLoadedSourceScripts,
    });
  });

  it('merges untouched canonical scripts into an edited draft', () => {
    const currentLoadedSourceScripts = {};
    const currentSourceScripts = createEditableScripts({
      launch: 'pnpm start --host',
    });
    const nextLoadedSourceScripts = createEditableScripts({
      launch: 'pnpm start',
      setup: 'pnpm install',
    });

    expect(
      applyHydratedSourceScripts(
        currentSourceScripts,
        currentLoadedSourceScripts,
        nextLoadedSourceScripts,
      ),
    ).toEqual({
      sourceScripts: createEditableScripts({
        launch: 'pnpm start --host',
        setup: 'pnpm install',
      }),
      loadedSourceScripts: nextLoadedSourceScripts,
    });
  });

  it('preserves user deletions when canonical data refreshes', () => {
    const currentLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });
    const currentSourceScripts = {};
    const nextLoadedSourceScripts = createEditableScripts({
      launch: 'pnpm start',
      setup: 'pnpm install',
    });

    expect(
      applyHydratedSourceScripts(
        currentSourceScripts,
        currentLoadedSourceScripts,
        nextLoadedSourceScripts,
      ),
    ).toEqual({
      sourceScripts: createEditableScripts({
        launch: 'pnpm start',
      }),
      loadedSourceScripts: nextLoadedSourceScripts,
    });
  });

  it('hydrates drafts that include configured timeout metadata', () => {
    const nextLoadedSourceScripts = createEditableScripts({
      setup: { command: 'pnpm install', timeoutSeconds: 900 },
      teardown: { command: 'pnpm clean', timeoutSeconds: null },
    });

    expect(applyHydratedSourceScripts({}, {}, nextLoadedSourceScripts)).toEqual(
      {
        sourceScripts: nextLoadedSourceScripts,
        loadedSourceScripts: nextLoadedSourceScripts,
      },
    );
  });

  it('preserves an in-flight timeout-only edit when canonical data refreshes', () => {
    // The user upgraded the inherited command-string entry to a custom
    // 900s timeout. The async manifest fetch returns the unchanged base
    // entry; the in-flight edit must survive.
    const currentLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });
    const currentSourceScripts = createEditableScripts({
      setup: { command: 'pnpm install', timeoutSeconds: 900 },
    });
    const nextLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });

    expect(
      applyHydratedSourceScripts(
        currentSourceScripts,
        currentLoadedSourceScripts,
        nextLoadedSourceScripts,
      ),
    ).toEqual({
      sourceScripts: createEditableScripts({
        setup: { command: 'pnpm install', timeoutSeconds: 900 },
      }),
      loadedSourceScripts: nextLoadedSourceScripts,
    });
  });

  it('treats Default → Custom → Default toggles as untouched', () => {
    // A user opens the modal (no in-flight edits), then the manifest
    // re-loads from disk. With both states canonically equal, the hook
    // should snap the draft to the freshly loaded copy.
    const currentLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });
    const currentSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });
    const nextLoadedSourceScripts = createEditableScripts({
      setup: 'pnpm install',
    });

    expect(
      applyHydratedSourceScripts(
        currentSourceScripts,
        currentLoadedSourceScripts,
        nextLoadedSourceScripts,
      ),
    ).toEqual({
      sourceScripts: nextLoadedSourceScripts,
      loadedSourceScripts: nextLoadedSourceScripts,
    });
  });
});
