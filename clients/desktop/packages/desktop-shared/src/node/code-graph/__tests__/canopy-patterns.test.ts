import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CodeGraphParserRuntime } from '../parser/runtime';
import { extractFileFacts } from '../extract/tags-extractor';
import {
  extractCanopyPatterns,
  IPC_CHANNEL_MAX_PER_FILE,
  type ExtractCanopyPatternsResult,
} from '../extract/canopy-patterns';
import { CodeGraphEngine } from '../engine';
import { openCodeGraphDatabase } from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { fileQualifiedName, fileRowId, symbolRowId } from '../ids';

const REPO = 'fixture';

// Drives extractCanopyPatterns through the SAME plumbing engine.ts uses in
// production: extractFileFacts's `onTree` hook, which hands over both the
// live tree and the in-progress definitions list synchronously (mirrors
// rationale.test.ts's extractRationaleFromSource helper).
async function extractCanopyPatternsFromSource(
  runtime: CodeGraphParserRuntime,
  source: string,
  relativePath: string,
  isTestFile: boolean = false,
): Promise<ExtractCanopyPatternsResult> {
  const grammar = await runtime.getGrammar('typescript');
  const fileId = fileRowId(REPO, relativePath);
  const fileSymbolId = symbolRowId(REPO, fileQualifiedName(relativePath));
  let captured: ExtractCanopyPatternsResult | null = null;
  extractFileFacts({
    grammar,
    runtime,
    repoId: REPO,
    relativePath,
    absolutePath: `/repo/${relativePath}`,
    source,
    sizeBytes: Buffer.byteLength(source, 'utf8'),
    mtimeNs: '1',
    contentHash: 'h',
    isTestFile,
    onTree: (tree, definitions) => {
      captured = extractCanopyPatterns({
        tree,
        source,
        repoId: REPO,
        relativePath,
        fileId,
        fileSymbolId,
        definitions,
      });
    },
  });
  if (captured === null) {
    throw new Error('onTree callback did not run; parse must have failed');
  }
  return captured;
}

describe('extractCanopyPatterns', () => {
  let runtime: CodeGraphParserRuntime;

  beforeAll(async () => {
    runtime = await CodeGraphParserRuntime.create();
  });
  afterAll(() => {
    runtime.dispose();
  });

  describe('channel declarations', () => {
    it('extracts an ipc_channel symbol per property, including a JSDoc-interleaved and a wrapped-value entry', async () => {
      // Mirrors the real shape in packages/desktop-shared/src/types.ts.
      const source = `export const IPC_CHANNELS = {
  appWindowReload: 'app-window:reload',
  /**
   * Main -> renderer broadcast.
   */
  preferencesChanged: 'preferences:changed',
  activityReadWorkflowAgentTranscript:
    'activity:read-workflow-agent-transcript',
};
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/types.ts',
      );
      expect(result.symbols).toHaveLength(3);
      const [first, second, third] = result.symbols;

      expect(first.kind).toBe('ipc_channel');
      expect(first.name).toBe('appWindowReload');
      expect(first.qualifiedName).toBe('src/types.ts::ipc.appWindowReload');
      expect(first.signature).toBe('app-window:reload');
      expect(first.lineStart).toBe(2);
      expect(first.lineEnd).toBe(2);

      expect(second.name).toBe('preferencesChanged');
      expect(second.qualifiedName).toBe('src/types.ts::ipc.preferencesChanged');
      expect(second.signature).toBe('preferences:changed');
      // Line 6 is the property's own key line, not affected by the JSDoc
      // comment above it (a sibling node, not a container).
      expect(second.lineStart).toBe(6);

      // Wrapped value: `line` is the property's own (key) line, not the
      // line the string value itself sits on.
      expect(third.name).toBe('activityReadWorkflowAgentTranscript');
      expect(third.signature).toBe('activity:read-workflow-agent-transcript');
      expect(third.lineStart).toBe(7);
    });

    it('extracts channels from an `as const` declaration (the real types.ts closer)', async () => {
      // The REAL declaration in packages/desktop-shared/src/types.ts ends
      // with `} as const;`, which wraps the object literal in an
      // as_expression node -- the declarator's `value` field is NOT a bare
      // `object`. Verified by live parse against the vendored typescript
      // grammar.
      const source = `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
  barSave: 'bar:save',
} as const;
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/types.ts',
      );
      const channels = result.symbols.filter((s) => s.kind === 'ipc_channel');
      expect(channels).toHaveLength(2);
      expect(channels.map((s) => s.name)).toEqual(['fooLoad', 'barSave']);
      expect(channels[0].signature).toBe('foo:load');
    });

    it('does not extract channel symbols from a file that only references IPC_CHANNELS', async () => {
      const source = `import { IPC_CHANNELS } from './types';

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.fooLoad, () => {});
}
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/register.ts',
      );
      expect(
        result.symbols.filter((s) => s.kind === 'ipc_channel'),
      ).toHaveLength(0);
      // The reference itself still produces a handler edge -- ownership
      // only constrains where the *symbol* is declared, not where the
      // channel key can be referenced.
      const handlesEdges = result.edges.filter((e) => e.kind === 'IPC_HANDLES');
      expect(handlesEdges).toHaveLength(1);
    });

    it('ignores a locally shadowed IPC_CHANNELS declared inside a function, extracting only the real top-level/exported declaration (F3c)', async () => {
      // The shadowing local declarator intentionally comes FIRST in document
      // order -- descendantsOfType walks the whole tree in document order, so
      // without the top-level guard this would extract 'shadowed' (from the
      // function-local declarator) instead of (or in addition to) the real
      // top-level 'realChannel' entry.
      const source = `function helper(): void {
  const IPC_CHANNELS = {
    shadowed: 'shadow:value',
  };
  registerIpcHandler(IPC_CHANNELS.shadowed, () => {});
}

export const IPC_CHANNELS = {
  realChannel: 'real:value',
};
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/shadowed.ts',
      );
      const channels = result.symbols.filter((s) => s.kind === 'ipc_channel');
      expect(channels).toHaveLength(1);
      expect(channels[0].name).toBe('realChannel');
      expect(channels[0].signature).toBe('real:value');
    });

    it('caps channel declarations at IPC_CHANNEL_MAX_PER_FILE and reports the drop count', async () => {
      const entries = Array.from(
        { length: IPC_CHANNEL_MAX_PER_FILE + 200 },
        (_, i) => `  channel${i}: 'channel:${i}',`,
      ).join('\n');
      const source = `export const IPC_CHANNELS = {\n${entries}\n};\n`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/types.ts',
      );
      expect(result.symbols).toHaveLength(IPC_CHANNEL_MAX_PER_FILE);
      expect(result.truncatedFacts).toBe(200);
    });
  });

  describe('handler registrations', () => {
    it('emits an IPC_HANDLES edge for registerIpcHandler(IPC_CHANNELS.<key>, ...) sourced from the enclosing function', async () => {
      const source = `import { IPC_CHANNELS } from '../shared/types';

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.agentsList, async () => ({}));
}
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/main/ipc/agent-models.ts',
      );
      expect(result.edges).toHaveLength(1);
      const edge = result.edges[0];
      expect(edge.kind).toBe('IPC_HANDLES');
      expect(edge.targetSymbolId).toBeNull();
      expect(edge.targetRef).toBe('ipc:agentsList');
      expect(edge.confidenceTier).toBe('EXTRACTED');
      expect(edge.confidenceScore).toBe(1.0);
      expect(edge.evidence.callee).toBe('registerIpcHandler');
      const enclosingFn = symbolRowId(
        REPO,
        'src/main/ipc/agent-models.ts::registerHandlers',
      );
      expect(edge.sourceSymbolId).toBe(enclosingFn);
    });

    it('emits an IPC_HANDLES edge for a direct ipcMain.handle(IPC_CHANNELS.<key>, ...) call', async () => {
      // No electron import in the fixture: extractCanopyPatterns matches on
      // CALLEE TEXT alone (isHandlerCalleeText), and a literal electron
      // specifier here (even inside a template string) would trip the
      // regex-based check:electron-boundary scanner. A declare-const shim
      // keeps the fixture parseable and line counts stable.
      const source = `declare const ipcMain: { handle: Function };
import { IPC_CHANNELS } from '../shared/types';

ipcMain.handle(IPC_CHANNELS.agentsGet, (_event, id: string) => {});
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/main/ipc/register.ts',
      );
      expect(result.edges).toHaveLength(1);
      const edge = result.edges[0];
      expect(edge.kind).toBe('IPC_HANDLES');
      expect(edge.targetRef).toBe('ipc:agentsGet');
      expect(edge.evidence.callee).toBe('ipcMain.handle');
      // No enclosing definition -- top-level call falls back to the file symbol.
      const fileSymbolId = symbolRowId(
        REPO,
        fileQualifiedName('src/main/ipc/register.ts'),
      );
      expect(edge.sourceSymbolId).toBe(fileSymbolId);
    });
  });

  describe('invocations', () => {
    it.each([
      ['ipcRenderer.invoke', 'invoke'],
      ['ipcRenderer.send', 'send'],
      ['ipcRenderer.on', 'on'],
    ])(
      'emits an IPC_INVOKES edge for %s(IPC_CHANNELS.<key>, ...)',
      async (calleeText, method) => {
        const source = `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../shared/types';

export const api = {
  call: () => ipcRenderer.${method}(IPC_CHANNELS.ollamaGetState, 1),
};
`;
        const result = await extractCanopyPatternsFromSource(
          runtime,
          source,
          'src/preload/index.ts',
        );
        const invokeEdges = result.edges.filter(
          (e) => e.kind === 'IPC_INVOKES',
        );
        expect(invokeEdges).toHaveLength(1);
        expect(invokeEdges[0].targetRef).toBe('ipc:ollamaGetState');
        expect(invokeEdges[0].evidence.callee).toBe(calleeText);
      },
    );

    it('skips computed access (IPC_CHANNELS[expr]) without emitting an edge', async () => {
      const source = `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../shared/types';

function dynamicKey(): string {
  return 'agentsList';
}

registerIpcHandler(IPC_CHANNELS[dynamicKey()], () => {});
ipcRenderer.invoke(IPC_CHANNELS[dynamicKey()]);
// A real, non-computed reference in the same file still produces an edge.
registerIpcHandler(IPC_CHANNELS.agentsList, () => {});
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/preload/mixed.ts',
      );
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].targetRef).toBe('ipc:agentsList');
    });

    it('still produces an invoker edge for a channel reference inside a test file', async () => {
      const source = `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../../shared/types';

ipcRenderer.invoke(IPC_CHANNELS.agentsList);
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/__tests__/preload.test.ts',
        true,
      );
      const invokeEdges = result.edges.filter((e) => e.kind === 'IPC_INVOKES');
      expect(invokeEdges).toHaveLength(1);
    });
  });

  describe('generalized channel registries (P6)', () => {
    it('extracts ipc_channel symbols from a SKILLS_CHANNELS-style registry with registry evidence (mirrors the real skill-channels.ts)', async () => {
      // Mirrors packages/desktop-shared/src/constants/skill-channels.ts:
      // `as const` closer, section comments between entries, and a derived
      // type alias referencing the constant below the declaration.
      const source = `export const SKILLS_CHANNELS = {
  LOAD: 'skills:load',
  INSTALL: 'skills:install',

  // ---- Shared (Canopy Cloud) CRUD -----------------------------------------
  SHARED_LIST: 'skills:shared-list',
} as const;

export type SkillsChannel =
  (typeof SKILLS_CHANNELS)[keyof typeof SKILLS_CHANNELS];
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/constants/skill-channels.ts',
      );
      const channels = result.symbols.filter((s) => s.kind === 'ipc_channel');
      expect(channels).toHaveLength(3);
      expect(channels.map((s) => s.name)).toEqual([
        'LOAD',
        'INSTALL',
        'SHARED_LIST',
      ]);
      expect(channels[0].qualifiedName).toBe(
        'src/constants/skill-channels.ts::ipc.LOAD',
      );
      expect(channels[0].signature).toBe('skills:load');
      expect(channels[0].extra).toEqual({ registry: 'SKILLS_CHANNELS' });
      expect(channels[2].extra).toEqual({ registry: 'SKILLS_CHANNELS' });
    });

    it('records the registry constant name on IPC_CHANNELS symbols too', async () => {
      const source = `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
} as const;
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/types.ts',
      );
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].extra).toEqual({ registry: 'IPC_CHANNELS' });
    });

    it('extracts every registry when one file declares more than one', async () => {
      const source = `export const SKILLS_CHANNELS = {
  LOAD: 'skills:load',
} as const;

export const PLUGINS_CHANNELS = {
  SCAN: 'plugins:scan',
} as const;
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/constants/channels.ts',
      );
      const channels = result.symbols.filter((s) => s.kind === 'ipc_channel');
      expect(channels).toHaveLength(2);
      expect(channels.map((s) => [s.name, s.extra.registry])).toEqual([
        ['LOAD', 'SKILLS_CHANNELS'],
        ['SCAN', 'PLUGINS_CHANNELS'],
      ]);
    });

    it('keeps only the FIRST declaration when two same-file registries declare the same key', async () => {
      // Both symbols would share the qualified name `${rel}::ipc.LOAD` and
      // therefore the same symbol row id; extraction keeps the first in
      // declaration-scan order instead of letting the store's INSERT OR
      // REPLACE silently keep whichever landed last.
      const source = `export const SKILLS_CHANNELS = {
  LOAD: 'skills:load',
} as const;

export const PLUGINS_CHANNELS = {
  LOAD: 'plugins:load',
} as const;
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/constants/channels.ts',
      );
      const channels = result.symbols.filter((s) => s.kind === 'ipc_channel');
      expect(channels).toHaveLength(1);
      expect(channels[0].signature).toBe('skills:load');
      expect(channels[0].extra).toEqual({ registry: 'SKILLS_CHANNELS' });
    });

    it('does not treat non-matching constant names as channel registries', async () => {
      // None of these match /^[A-Z][A-Z0-9_]*_CHANNELS$/: no segment before
      // the suffix, trailing text after the suffix, lowercase name.
      const source = `export const CHANNELS = {
  a: 'a:a',
} as const;

export const IPC_CHANNELS_LEGACY = {
  b: 'b:b',
} as const;

export const myChannels = {
  c: 'c:c',
} as const;

registerIpcHandler(CHANNELS.a, () => {});
registerIpcHandler(IPC_CHANNELS_LEGACY.b, () => {});
registerIpcHandler(myChannels.c, () => {});
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/constants/not-registries.ts',
      );
      expect(
        result.symbols.filter((s) => s.kind === 'ipc_channel'),
      ).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it('emits handler/invoker edges for <NAME>_CHANNELS member references with registry evidence', async () => {
      const source = `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { SKILLS_CHANNELS } from '../../constants/skill-channels';

export function registerHandlers(): void {
  registerIpcHandler(SKILLS_CHANNELS.LOAD, () => {});
}

export const api = {
  load: () => ipcRenderer.invoke(SKILLS_CHANNELS.LOAD),
};
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/main/skills/skill-handlers.ts',
      );
      const handles = result.edges.filter((e) => e.kind === 'IPC_HANDLES');
      expect(handles).toHaveLength(1);
      expect(handles[0].targetRef).toBe('ipc:LOAD');
      expect(handles[0].evidence).toEqual({
        callee: 'registerIpcHandler',
        registry: 'SKILLS_CHANNELS',
      });
      const invokes = result.edges.filter((e) => e.kind === 'IPC_INVOKES');
      expect(invokes).toHaveLength(1);
      expect(invokes[0].targetRef).toBe('ipc:LOAD');
      expect(invokes[0].evidence.registry).toBe('SKILLS_CHANNELS');
    });

    it('records registry evidence on IPC_CHANNELS handler edges too', async () => {
      const source = `import { IPC_CHANNELS } from '../shared/types';

registerIpcHandler(IPC_CHANNELS.agentsList, () => {});
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/main/ipc/agents.ts',
      );
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].evidence.registry).toBe('IPC_CHANNELS');
    });
  });

  describe('injected-tool registry', () => {
    it('extracts an mcp_tool symbol and DECLARES_MCP_TOOL edge per registry entry', async () => {
      const source = `export const CANOPY_INJECTED_TOOL_REGISTRY = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
    claudeToolName: 'mcp__canopy__AskUserQuestion',
  },
  get_script_output: {
    canonicalKey: 'get_script_output',
    displayName: 'GetScriptOutput',
    claudeToolName: 'mcp__canopy__GetScriptOutput',
  },
};
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/lib/canopy-injected-tools.ts',
      );
      const toolSymbols = result.symbols.filter((s) => s.kind === 'mcp_tool');
      expect(toolSymbols).toHaveLength(2);
      expect(toolSymbols[0].name).toBe('ask_user_question');
      expect(toolSymbols[0].qualifiedName).toBe(
        'src/lib/canopy-injected-tools.ts::tool.ask_user_question',
      );
      expect(toolSymbols[0].signature).toBe('AskUserQuestion');
      expect(toolSymbols[1].name).toBe('get_script_output');
      expect(toolSymbols[1].signature).toBe('GetScriptOutput');

      const declaresEdges = result.edges.filter(
        (e) => e.kind === 'DECLARES_MCP_TOOL',
      );
      expect(declaresEdges).toHaveLength(2);
      const fileSymbolId = symbolRowId(
        REPO,
        fileQualifiedName('src/lib/canopy-injected-tools.ts'),
      );
      expect(declaresEdges[0].sourceSymbolId).toBe(fileSymbolId);
      expect(declaresEdges[0].targetSymbolId).toBe(toolSymbols[0].id);
      expect(declaresEdges[0].confidenceTier).toBe('EXTRACTED');
    });

    it('extracts entries from a registry declarator carrying a Record type annotation (the real file shape)', async () => {
      // The REAL declaration in
      // packages/desktop-shared/src/lib/canopy-injected-tools.ts is
      // `export const CANOPY_INJECTED_TOOL_REGISTRY: Record<..., ...> = {`
      // -- the declarator has a `type` field between name and value.
      const source = `export const CANOPY_INJECTED_TOOL_REGISTRY: Record<
  CanopyInjectedToolKey,
  CanopyInjectedToolExposure
> = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
    claudeToolName: BRANDED_TOOL_NAMES.claude.askUserQuestion,
    codexToolName: BRANDED_TOOL_NAMES.codex.askUserQuestion,
    legacyToolNames: legacyAliasesFor('ask_user_question'),
  },
};
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/lib/canopy-injected-tools.ts',
      );
      const toolSymbols = result.symbols.filter((s) => s.kind === 'mcp_tool');
      expect(toolSymbols).toHaveLength(1);
      expect(toolSymbols[0].name).toBe('ask_user_question');
      expect(toolSymbols[0].signature).toBe('AskUserQuestion');
    });

    it('does not extract tool symbols from a file that only references the registry', async () => {
      const source = `import { CANOPY_INJECTED_TOOL_REGISTRY } from './canopy-injected-tools';

export function lookup(): unknown {
  return CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question;
}
`;
      const result = await extractCanopyPatternsFromSource(
        runtime,
        source,
        'src/lib/consumer.ts',
      );
      expect(result.symbols.filter((s) => s.kind === 'mcp_tool')).toHaveLength(
        0,
      );
      expect(
        result.edges.filter((e) => e.kind === 'DECLARES_MCP_TOOL'),
      ).toHaveLength(0);
    });
  });
});

describe('CodeGraphEngine canopy-pattern wiring (end to end)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-canopy-patterns-'));
    mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'main', 'ipc'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'preload'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
  });
  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('extracts real-repo-shaped IPC channel declarations, handler/invoker edges, and tool-registry declarations after a real build', async () => {
    // `as const` closer mirrors the REAL packages/desktop-shared/src/types.ts
    // declaration shape.
    writeFileSync(
      path.join(root, 'src', 'shared', 'types.ts'),
      `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
  barSave: 'bar:save',
} as const;
`,
    );
    writeFileSync(
      path.join(root, 'src', 'main', 'ipc', 'register.ts'),
      `import { IPC_CHANNELS } from '../../shared/types';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.fooLoad, () => {});
}
`,
    );
    writeFileSync(
      path.join(root, 'src', 'preload', 'index.ts'),
      `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../shared/types';

export const api = {
  loadFoo: () => ipcRenderer.invoke(IPC_CHANNELS.fooLoad),
};
`,
    );
    // Type-annotated declarator mirrors the REAL
    // packages/desktop-shared/src/lib/canopy-injected-tools.ts shape.
    writeFileSync(
      path.join(root, 'src', 'lib', 'canopy-injected-tools.ts'),
      `type Exposure = { canonicalKey: string; displayName: string };

export const CANOPY_INJECTED_TOOL_REGISTRY: Record<string, Exposure> = {
  ask_user_question: {
    canonicalKey: 'ask_user_question',
    displayName: 'AskUserQuestion',
  },
};
`,
    );

    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const typesFileId = fileRowId('fixture', 'src/shared/types.ts');
      const typesSymbols = store.listSymbolsForFile(typesFileId);
      const channelSymbols = typesSymbols.filter(
        (s) => s.kind === 'ipc_channel',
      );
      expect(channelSymbols).toHaveLength(2);
      expect(channelSymbols.map((s) => s.name).sort()).toEqual([
        'barSave',
        'fooLoad',
      ]);
      const fooLoadChannel = channelSymbols.find((s) => s.name === 'fooLoad');
      expect(fooLoadChannel).toBeDefined();

      // Ownership: no ipc_channel symbols leak into the referencing files.
      const registerFileId = fileRowId('fixture', 'src/main/ipc/register.ts');
      const registerSymbols = store.listSymbolsForFile(registerFileId);
      expect(
        registerSymbols.filter((s) => s.kind === 'ipc_channel'),
      ).toHaveLength(0);

      // resolve/ipc-resolver.ts (registered in engine.ts's post-processing)
      // binds both edges to the single matching channel symbol after this
      // real build, since 'fooLoad' is declared exactly once in this fixture.
      const handlesEdges = store.listEdges({
        kind: 'IPC_HANDLES',
        repoId: 'fixture',
      });
      expect(handlesEdges).toHaveLength(1);
      expect(handlesEdges[0].targetRef).toBe('ipc:fooLoad');
      expect(handlesEdges[0].targetSymbolId).toBe(fooLoadChannel?.id);
      expect(handlesEdges[0].confidenceTier).toBe('RESOLVED');
      expect(handlesEdges[0].resolverId).toBe('ipc-channel');

      const invokesEdges = store.listEdges({
        kind: 'IPC_INVOKES',
        repoId: 'fixture',
      });
      expect(invokesEdges).toHaveLength(1);
      expect(invokesEdges[0].targetRef).toBe('ipc:fooLoad');
      expect(invokesEdges[0].targetSymbolId).toBe(fooLoadChannel?.id);
      expect(invokesEdges[0].resolverId).toBe('ipc-channel');

      const toolFileId = fileRowId(
        'fixture',
        'src/lib/canopy-injected-tools.ts',
      );
      const toolSymbols = store
        .listSymbolsForFile(toolFileId)
        .filter((s) => s.kind === 'mcp_tool');
      expect(toolSymbols).toHaveLength(1);
      expect(toolSymbols[0].name).toBe('ask_user_question');
      expect(toolSymbols[0].signature).toBe('AskUserQuestion');

      const declaresEdges = store.listEdges({
        kind: 'DECLARES_MCP_TOOL',
        repoId: 'fixture',
      });
      expect(declaresEdges).toHaveLength(1);
      expect(declaresEdges[0].targetSymbolId).toBe(toolSymbols[0].id);
    } finally {
      db.close();
    }
  });

  it('extracts and resolves a secondary channel registry (SKILLS_CHANNELS) end to end (P6)', async () => {
    // Mirrors the real packages/desktop-shared/src/constants/skill-channels.ts
    // (subset) plus its real register/invoke sites in
    // apps/desktop-app/src/main/skills/skill-handlers.ts and the preload.
    mkdirSync(path.join(root, 'src', 'constants'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'main', 'skills'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'constants', 'skill-channels.ts'),
      `export const SKILLS_CHANNELS = {
  LOAD: 'skills:load',
  INSTALL: 'skills:install',

  // ---- Shared (Canopy Cloud) CRUD -----------------------------------------
  SHARED_LIST: 'skills:shared-list',
} as const;

export type SkillsChannel =
  (typeof SKILLS_CHANNELS)[keyof typeof SKILLS_CHANNELS];
`,
    );
    writeFileSync(
      path.join(root, 'src', 'main', 'skills', 'skill-handlers.ts'),
      `import { SKILLS_CHANNELS } from '../../constants/skill-channels';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerSkillHandlers(): void {
  registerIpcHandler(SKILLS_CHANNELS.LOAD, () => {});
}
`,
    );
    writeFileSync(
      path.join(root, 'src', 'preload', 'skills.ts'),
      `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { SKILLS_CHANNELS } from '../constants/skill-channels';

export const skillsApi = {
  load: () => ipcRenderer.invoke(SKILLS_CHANNELS.LOAD),
};
`,
    );

    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const channelsFileId = fileRowId(
        'fixture',
        'src/constants/skill-channels.ts',
      );
      const channelSymbols = store
        .listSymbolsForFile(channelsFileId)
        .filter((s) => s.kind === 'ipc_channel');
      expect(channelSymbols.map((s) => s.name).sort()).toEqual([
        'INSTALL',
        'LOAD',
        'SHARED_LIST',
      ]);
      const loadChannel = channelSymbols.find((s) => s.name === 'LOAD');
      expect(loadChannel?.extra).toEqual({ registry: 'SKILLS_CHANNELS' });

      const handlesEdges = store.listEdges({
        kind: 'IPC_HANDLES',
        repoId: 'fixture',
      });
      expect(handlesEdges).toHaveLength(1);
      expect(handlesEdges[0].targetRef).toBe('ipc:LOAD');
      expect(handlesEdges[0].targetSymbolId).toBe(loadChannel?.id);
      expect(handlesEdges[0].confidenceTier).toBe('RESOLVED');
      expect(handlesEdges[0].resolverId).toBe('ipc-channel');
      expect(handlesEdges[0].evidence.registry).toBe('SKILLS_CHANNELS');

      const invokesEdges = store.listEdges({
        kind: 'IPC_INVOKES',
        repoId: 'fixture',
      });
      expect(invokesEdges).toHaveLength(1);
      expect(invokesEdges[0].targetSymbolId).toBe(loadChannel?.id);
      expect(invokesEdges[0].evidence.registry).toBe('SKILLS_CHANNELS');
    } finally {
      db.close();
    }
  });
});
