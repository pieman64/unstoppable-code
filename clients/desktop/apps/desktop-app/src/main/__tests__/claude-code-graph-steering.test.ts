import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('keeps an artifact-named directory gated while a real artifact file passes', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'claude-graph-dir-'));
    tempDirs.push(worktree);
    await mkdir(path.join(worktree, 'fixtures.log'), { recursive: true });
    await writeFile(
      path.join(worktree, 'fixtures.log', 'source.ts'),
      'export {};',
    );
    await writeFile(path.join(worktree, 'run.log'), 'log');
    const steer = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName,
        toolInput,
        cwd: worktree,
        graphAvailable: true,
      });

    expect(steer('Bash', { command: 'rg symbol fixtures.log' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(steer('Grep', { pattern: 'symbol', path: 'fixtures.log' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(steer('Glob', { pattern: '**/*', path: 'fixtures.log' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(steer('Bash', { command: 'rg symbol run.log' })).toBeUndefined();
    expect(
      steer('Grep', { pattern: 'symbol', path: 'run.log' }),
    ).toBeUndefined();
  });

  it('keeps an artifact-named target gated when it cannot be stat-ed', async () => {
    const worktree = await mkdtemp(
      path.join(os.tmpdir(), 'claude-graph-loop-'),
    );
    tempDirs.push(worktree);
    await symlink('loop.log', path.join(worktree, 'loop.log'));
    const steer = (
      toolName: string,
      toolInput: Record<string, unknown>,
    ): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName,
        toolInput,
        cwd: worktree,
        graphAvailable: true,
      });

    expect(steer('Bash', { command: 'rg symbol loop.log' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(steer('Grep', { pattern: 'symbol', path: 'loop.log' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
  });

  // The shell expands these scopes into explicit paths before the search
  // runs, and rg/grep search a named path whatever its -g/--include filters.
  describe('shell-expanded Bash search scopes', () => {
    let worktree = '';
    const steer = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd: worktree,
        graphAvailable: true,
      });

    beforeEach(async () => {
      worktree = await mkdtemp(path.join(os.tmpdir(), 'claude-graph-glob-'));
      tempDirs.push(worktree);
      await mkdir(path.join(worktree, 'fixtures.log'), { recursive: true });
      await writeFile(
        path.join(worktree, 'fixtures.log', 'source.ts'),
        'export {};',
      );
      await mkdir(path.join(worktree, 'src'), { recursive: true });
      await writeFile(path.join(worktree, 'src', 'a.ts'), 'export {};');
      await mkdir(path.join(worktree, '.playwright', 'run-1'), {
        recursive: true,
      });
      await writeFile(path.join(worktree, 'run.log'), 'log');
      await mkdir(path.join(worktree, 'bin'), { recursive: true });
      await writeFile(path.join(worktree, 'bin', 'cli'), '#!/bin/sh');
    });

    it.each([
      "rg foo -g '*.log' $(git ls-files)",
      "rg foo -g '*.log' `git ls-files`",
      "rg foo -g '*.log' $FILES",
      'rg foo -g \'*.log\' "$FILES"',
      "rg foo -g '*.log' src/*",
      "rg foo -g '*.log' src/**",
      "rg foo -g '*.log' src/a.?s",
      "rg foo -g '*.log' src/[a]*",
      "grep -rn foo --include='*.log' src/*",
      "rg foo -g '*.log' .playwright src/*",
      "rg foo -g '*.log' run.log $FILES",
      'rg symbol *.log',
      'rg symbol {fixtures,other}.log',
      'rg symbol fixtures.{log,txt}',
      'rg symbol run.log *.log',
      'grep -rn symbol *.log',
      'git grep symbol -- *.log',
      'find *.log -type f',
      // Brace or dot-leading glob segments can step out of an artifact dir.
      'rg symbol .playwright/{run-1,../src}',
      'rg symbol .playwright/.*',
      'rg symbol .playwright/.?/src',
      'rg symbol .playwright/{a,{b,../../src}}',
    ])('steers a shell-expanded scope: %s', (command) => {
      expect(steer(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    });

    it.each([
      'rg symbol run.log',
      "rg symbol -g '*.log' src",
      "rg symbol -g '*.log' .playwright",
      'grep symbol .playwright/run-1/*.log',
      'rg symbol .playwright/*',
      'rg symbol .playwright/{run-1,run-2}/report.md',
      'rg symbol coverage/**/*.log',
      "git grep symbol -- '*.log'",
      "rg symbol '*.log'",
    ])('keeps an artifact-only scope ungated: %s', (command) => {
      expect(steer(command)).toBeUndefined();
    });

    // `rg symbol* run.log` can run as `rg symbol.ts src.ts run.log`.
    it.each([
      'rg symbol* run.log',
      'rg $PATTERN run.log',
      'grep {a,b} run.log',
    ])(
      'steers when an expandable pattern can shift the scopes: %s',
      (command) => {
        expect(steer(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
      },
    );

    it.each([
      "rg 'error$' run.log",
      'rg "error$" run.log',
      "rg -e 'a*' run.log",
    ])('keeps a quoted pattern from shifting the scopes: %s', (command) => {
      expect(steer(command)).toBeUndefined();
    });

    it.each([
      // An expandable option value can split and shift a source path into a
      // scope: `rg -e handle* run.log` can run as `rg -e handler.ts x.ts run.log`.
      'rg -e handle* run.log',
      'rg -e $PAT .playwright/',
      'rg --regexp=$PAT .playwright/',
      'grep -f pats* run.log',
      'rg symbol --glob=$G .playwright',
      'rg -g *.log symbol .playwright/',
      // A named dot-less file is searched whatever the selectors.
      "rg symbol -g '*.log' bin/cli",
      "grep -rn symbol --include='*.log' bin/cli",
      // An outside or ancestor scope never exempts a worktree scope.
      'rg symbol /tmp/other-repo src/a.ts',
      'grep -rn symbol src ../other-repo',
      'rg symbol ..',
      'rg symbol ../*',
      'rg symbol /',
      'rg symbol /tmp/{other,../..}',
      // An unknown working directory may be the worktree.
      'cd $DIR && rg symbol .playwright',
      'cd "$(git rev-parse --show-toplevel)" && rg symbol src',
      'cd && rg symbol',
      'cd .. && rg symbol',
      // An extglob group expands like a glob; `..` after a glob follows a
      // symlinked match out of the artifact directory.
      'rg symbol @(fixtures|other).log',
      'rg symbol .playwright/*/..',
    ])('steers an option, outside or cwd escape: %s', (command) => {
      expect(steer(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    });

    it.each([
      "rg symbol -g '*.log' bin",
      "rg symbol -g '*.log' bin/",
      "rg symbol -g '*.log' ..",
      'rg symbol --glob *.log src',
      'rg symbol ../other-repo/*',
      'cd ../other-repo && rg symbol .',
      "rg -e '../shared' ../other-repo",
    ])('keeps a filtered or outside search ungated: %s', (command) => {
      expect(steer(command)).toBeUndefined();
    });
  });

  const steerBash = (command: string): string | undefined =>
    buildClaudeCodeGraphPreToolUseContext({
      toolName: 'Bash',
      toolInput: { command },
      cwd,
      graphAvailable: true,
    });

  // An empty pattern must not swallow the source operand that follows it.
  it.each([
    "grep -e '' src/index.ts out.log",
    'grep -e "" src/index.ts out.log',
    "grep '' src/index.ts out.log",
    'rg -e "" src/index.ts out.log',
    "rg '' src/index.ts out.log",
  ])('keeps an empty quoted word in its shell position: %s', (command) => {
    expect(steerBash(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
  });

  it('still exempts artifact-only searches with an empty quoted pattern', () => {
    expect(steerBash("grep -e '' out.log")).toBeUndefined();
    expect(steerBash('rg "" out.log')).toBeUndefined();
  });

  it('nudges broad in-worktree structural searches when a graph is available', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'createSession', path: '/workspace/repo/src' },
        cwd,
        graphAvailable: true,
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

  it('nudges gated calls when a graph exists; callers own orientation', () => {
    const base = {
      toolName: 'Glob',
      toolInput: { pattern: '**/*.ts', path: cwd },
      cwd,
    };

    expect(
      buildClaudeCodeGraphPreToolUseContext({
        ...base,
        graphAvailable: false,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        ...base,
        graphAvailable: true,
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
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
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'secret', path: '/tmp/other-repo' },
        cwd,
        graphAvailable: true,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Grep',
        toolInput: { pattern: 'secret', path: 'D:\\other-repo' },
        cwd: 'C:\\workspace\\repo',
        graphAvailable: true,
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
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/node_modules/pkg/index.ts' },
        cwd,
        graphAvailable: true,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/.next/server/app.js' },
        cwd,
        graphAvailable: true,
      }),
    ).toBeUndefined();
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/workspace/repo/assets/logo.png' },
        cwd,
        graphAvailable: true,
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

  describe('Bash artifact-only searches', () => {
    const build = (
      command: string,
      worktree = cwd,
      customSourceExtensions: readonly string[] = [],
    ): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd: worktree,
        graphAvailable: true,
        customSourceExtensions,
      });

    it.each([
      'grep foo .playwright/run-1/*.log',
      'rg foo coverage/',
      'rg foo dist',
      'grep -rn foo .playwright/run-1/report.md',
      "rg foo -g '*.log'",
      'rg foo --glob *.log',
      'rg foo --glob=*.log',
      'rg foo --iglob=*.LOG',
      'rg foo -g*.log',
      "grep -rn foo --include='*.log' .",
      "grep -rn foo --include '*.log' .",
      "find . -name '*.log'",
      "find . -path 'coverage/**/*.ts'",
      "find . -maxdepth 2 -type f -name '*.log' -print",
      'fd -e log foo',
      'fd --extension=log foo',
      "git grep foo -- '*.log'",
      "rg foo -g '*.{log,txt}'",
      'rg foo test-results/',
      "find . -name '*.log' -a -type f",
      "find . -type f -and -name '*.snap'",
      "rg foo -g '*.snap'",
      "find . -name '*.log' 2>/dev/null",
      "find . -name '*.log' 2> /dev/null",
      "find . -name '*.log' -print 2>/dev/null",
      'find .playwright 2>/dev/null',
    ])('does not steer artifact-only search: %s', (command) => {
      expect(build(command)).toBeUndefined();
    });

    it.each([
      'rg foo src .playwright/a.log',
      "rg -g '*.log' foo src/a.ts",
      "rg foo -g '*.log' -g '*.ts'",
      "rg foo -g '!*.ts'",
      "find . -name '*.ts' -o -name '*.log'",
      "find src -print -name '*.log'",
      'rg foo',
      'grep foo report.md',
      "rg foo -g '*.json'",
      "git grep foo -- ':!*.ts'",
      "git grep foo -- ':(exclude,glob)*.ts'",
      'rg foo "$DIR"',
      'rg -t log foo',
      "rg foo -g '/tmp/build/repo/src/*.ts'",
      "find . -name '*.log' -a -name '*.ts'",
      "find . '(' -name '*.log' ')'",
      "ag -G '\\.log$' foo",
      'ack -g log',
      "find . -name '*.ts' 2>/dev/null",
      'find src 2>/dev/null',
      // A `cd` can fail or run in a subshell, so it never grants the exemption.
      'cd .playwright && rg foo',
      "cd src && rg foo -g 'coverage/*.ts'",
      'cd build; rg needle',
      "cd test-results; find . -name '*.ts'",
      'cd coverage; grep needle -R .',
      '(cd node_modules && rg foo); rg needle',
      "(cd node_modules; rg foo); find . -name '*.ts'",
    ])('still steers source-possible search: %s', (command) => {
      expect(build(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    });

    it('treats configured source extensions as source selectors', () => {
      expect(build("rg foo -g '*.txt'", cwd, ['.txt'])).toBe(
        CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      );
    });

    it.each([
      // The `cd` ran in a subshell, may have failed, or is otherwise not
      // proven to apply to the later search.
      '(cd /tmp && rg x .); rg foo src',
      '(cd /tmp && rg x .) && rg foo src',
      '(cd /tmp) && rg foo src',
      '(rg a /tmp && cd /tmp && rg x .) && rg foo src',
      'cd /missing; rg foo src',
      'cd /tmp || rg foo src',
      'cd /tmp & rg foo src',
      'cd /tmp\nrg foo src',
      'cd /tmp | cat && rg foo src',
      'cd /tmp && rg x . ; rg foo src',
      'cd /tmp && rg x . || rg foo src',
      '{ cd src; } && rg foo ../sibling',
      'builtin cd src && rg foo ../sibling',
      'command cd src && rg foo ../sibling',
      // Unparsed directory changers leave the directory unknown.
      'pushd src && rg foo ../sibling',
      'pushd src >/dev/null; rg foo ../sibling',
      'chdir src && rg foo ../sibling',
      'popd && rg foo ../sibling',
      // `cd -` and `~` do not name the target literally.
      'cd - && rg foo ../../x',
      'cd ~ && rg foo ../../x',
      // A `cd` after `||` is skipped when the left side succeeds.
      'true || cd /tmp && rg foo src',
      'false && true || cd /tmp && rg foo src',
      'true ||\ncd /tmp && rg foo src',
      // zsh `cd old new` replaces `old` in $PWD: this stays in /workspace/repo.
      'cd /repo /repo && rg foo src',
      'cd /tmp extra 2>/dev/null && rg foo src',
    ])('steers a search whose directory change is unproven: %s', (command) => {
      expect(build(command)).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    });

    it.each([
      'cd /outside && rg foo .',
      'cd /missing && rg foo src',
      'cd /tmp && cd /var && rg foo .',
      '(cd /tmp && rg x .)',
      'cd /tmp && rg x . && rg y src',
      'ls; cd /tmp && rg foo .',
      '(rg a /tmp) && cd /tmp && rg foo src',
      'cd /tmp &&\nrg foo src',
      'cd /tmp && rg foo . | head',
      'rg cd /tmp; rg foo /var',
      'true && cd /tmp && rg foo src',
      'false || true && cd /tmp && rg foo src',
      'cd /tmp 2>/dev/null && rg foo src',
      'cd /tmp >/dev/null 2>&1 && rg foo src',
    ])('keeps a search after a proven outside `cd` ungated: %s', (command) => {
      expect(build(command)).toBeUndefined();
    });

    it('still steers an artifact search after a literal `cd`', () => {
      expect(build('cd test-results && rg foo .')).toBe(
        CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      );
    });

    it('classifies Bash scopes relative to the worktree, not its absolute root', () => {
      expect(build('rg foo src', '/tmp/build/repo')).toBe(
        CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      );
      expect(
        build('rg foo -g /tmp/build/repo/src/*.ts', '/tmp/build/repo'),
      ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    });
  });

  it('does not steer built-in tool searches scoped to artifact files or selectors', () => {
    const build = (
      toolName: string,
      toolInput: Record<string, unknown>,
      worktree = cwd,
    ): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName,
        toolInput,
        cwd: worktree,
        graphAvailable: true,
      });

    expect(build('Grep', { pattern: 'foo', path: '.playwright/run' })).toBe(
      undefined,
    );
    expect(build('Grep', { pattern: 'foo', glob: '*.log' })).toBeUndefined();
    expect(
      build('Grep', {
        pattern: 'foo',
        path: 'src/session.ts',
        glob: '*.log',
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(build('Glob', { pattern: '**/*.log' })).toBeUndefined();
    expect(build('Glob', { pattern: '.playwright/**/*.md' })).toBeUndefined();
    expect(
      build('Read', { file_path: '/workspace/repo/.playwright/run/report.md' }),
    ).toBeUndefined();
    expect(
      build(
        'Read',
        { file_path: '/tmp/build/repo/src/session.ts' },
        '/tmp/build/repo',
      ),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
    expect(build('Glob', { pattern: '**/*.ts' })).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
  });

  it('classifies built-in source paths relative to the worktree root', () => {
    expect(
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Read',
        toolInput: { file_path: '/tmp/build/repo/src/session.ts' },
        cwd: '/tmp/build/repo',
        graphAvailable: true,
      }),
    ).toBe(CLAUDE_CODE_GRAPH_STEERING_CONTEXT);
  });

  it('splits unquoted newlines while preserving escaped line continuations', () => {
    const build = (command: string): string | undefined =>
      buildClaudeCodeGraphPreToolUseContext({
        toolName: 'Bash',
        toolInput: { command },
        cwd,
        graphAvailable: true,
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
      });

    expect(build("rg 'createSession' src > /tmp/results.txt")).toBe(
      CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
    );
    expect(build("rg foo src > -g '*.log'")).toBe(
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
