import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
  buildClaudeCodeGraphPreToolUseContext,
  isClaudeCodeGraphToolName,
  loadConfiguredClaudeCodeGraphSourceExtensions,
} from '../lib/claude-code-graph-steering';

describe('Claude code-graph steering', () => {
  const cwd = '/workspace/repo';
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('nudges broad in-worktree structural searches when a graph is available', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'createSession', path: '/workspace/repo/src' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);

    expect(CLAUDE_CODE_GRAPH_STEERING_CONTEXT).toContain(
      'mcp__canopy__GetCodeGraphContext',
    );
    expect(CLAUDE_CODE_GRAPH_STEERING_CONTEXT).toContain(
      'mcp__canopy__QueryCodeGraph',
    );
    expect(CLAUDE_CODE_GRAPH_STEERING_CONTEXT).toContain('subagents');
  });

  it('does not nudge before a graph exists or after graph orientation', () => {
    const base = {
      toolName: 'Glob',
      toolInput: { pattern: '**/*.ts', path: cwd },
      cwd,
    };

    expect(
      buildClaudeCodeGraphPreToolUseContext({
        ...base,
        graphAvailable: false,
        graphOriented: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        ...base,
        graphAvailable: true,
        graphOriented: true,
      }),
    ).toBeUndefined();
  });

  it('keeps targeted reads and paths outside the worktree out of the reminder', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: {
          file_path: '/workspace/repo/src/session.ts',
          offset: 120,
          limit: 40,
        },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'secret', path: '/tmp/other-repo' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'secret', path: 'D:\\other-repo' },
        cwd: 'C:\\workspace\\repo',
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
  });

  it('nudges broad source reads but not non-source or dependency reads', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/src/session.ts' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/node_modules/pkg/index.ts' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/.next/server/app.js' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/assets/logo.png' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      }),
    ).toBeUndefined();
  });

  it('nudges broad reads of configured custom-language sources', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/src/main.zig' },
        cwd,
        graphAvailable: true,
        graphOriented: false,
        customSourceExtensions: ['.zig'],
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
  });

  it('loads validated custom-language source extensions from the worktree config', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'graph-steering-'));
    tempDirs.push(worktree);
    const configDir = path.join(worktree, '.canopy', 'code-graph');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'languages.json'),
      JSON.stringify({
        version: 1,
        languages: [
          {
            id: 'zig',
            extensions: ['.zig'],
            wasmFile: 'tree-sitter-zig.wasm',
            tagsFiles: ['tags.scm'],
          },
        ],
      }),
    );

    await expect(
      loadConfiguredClaudeCodeGraphSourceExtensions(worktree),
    ).resolves.toEqual(['.zig']);
  });

  it('only nudges search-like Bash commands', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("rg -n 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("git grep 'createSession' -- '*.ts'")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("SEARCH_ROOT=src rg -n 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("cd src && rg -n 'createSession' .")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg 'createSession' '/tmp/other-repo'")).toBeUndefined();
    expect(build("rg 'createSession' ../other-repo")).toBeUndefined();
    expect(build("rg 'createSession' ./../other-repo")).toBeUndefined();
    expect(build("rg 'createSession' src/../../other-repo")).toBeUndefined();
    expect(
      build("rg 'createSession' src/../src/../../other-repo"),
    ).toBeUndefined();
    expect(build("cd ../other-repo && rg 'createSession' .")).toBeUndefined();
    expect(build('git commit -m "fix grep handling"')).toBeUndefined();
    expect(build('ps aux | grep node')).toBeUndefined();
    expect(build('git log --oneline | grep fix')).toBeUndefined();
    expect(build("find . -name '*.snap' -delete")).toBeUndefined();
    for (const executor of ['-exec', '-execdir', '-ok', '-okdir']) {
      expect(
        build(`find . -name '*.ts' ${executor} rm {} \\;`),
      ).toBeUndefined();
    }
    expect(build('npm test')).toBeUndefined();
  });

  it('splits unquoted newlines while preserving escaped line continuations', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("npm test\nrg 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("npm test\r\nrg 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("npm test \\\nrg 'createSession' src")).toBeUndefined();
  });

  it('splits background commands without mistaking redirects for separators', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("printf ready & rg 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("printf 'grep handling' &> output.txt")).toBeUndefined();
    expect(build("printf 'grep handling' 2>&1")).toBeUndefined();
  });

  it('ignores shell redirect destinations when classifying search targets', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("rg 'createSession' src > /tmp/results.txt")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg 'createSession' src 2> /tmp/errors.txt")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg 'createSession' src &> /tmp/output.txt")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg 'createSession' src >/tmp/results.txt")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg > /tmp/results.txt 'createSession' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg '>' /tmp/other-repo")).toBeUndefined();
    expect(build('rg \\> /tmp/other-repo')).toBeUndefined();
  });

  it('treats ripgrep no-pattern mode operands as search targets', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build('rg --files')).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(build('rg --files src')).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(build('rg --files /tmp/other-repo')).toBeUndefined();
    expect(build('rg --type-list /tmp/other-repo')).toBeUndefined();
  });

  it('does not treat search expressions that look like paths as targets', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("rg '../shared' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("git grep '../shared' -- src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg -e '../shared' --glob '../*.ts' src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg -e '../shared' ../other-repo")).toBeUndefined();
  });

  it('keeps Windows Bash searches scoped to the worktree volume', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd: 'C:\\workspace\\repo',
        graphAvailable: true,
        graphOriented: false,
      });

    expect(build("rg 'createSession' C:\\workspace\\repo\\src")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg 'createSession' D:\\other-repo")).toBeUndefined();
  });

  it('recognises every provider spelling of an injected graph tool', () => {
    expect(isClaudeCodeGraphToolName('mcp__canopy__GetCodeGraphContext')).toBe(
      true,
    );
    expect(isClaudeCodeGraphToolName('canopy_query_code_graph')).toBe(true);
    expect(isClaudeCodeGraphToolName('Grep')).toBe(false);
  });
});
