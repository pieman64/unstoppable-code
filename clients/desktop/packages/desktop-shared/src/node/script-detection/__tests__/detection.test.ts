import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DETECTION_LIMITS,
  detectRepositoryScripts,
  detectShellAliases,
} from '../index';

describe('non-executing script detection', () => {
  let root: string;
  const scan = (): ReturnType<typeof detectRepositoryScripts> =>
    detectRepositoryScripts({
      root,
      repoId: 'repo',
      repoName: 'Repo',
      shell: 'bash',
      platform: 'posix',
    });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'script-detection-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const put = async (name: string, content: string): Promise<void> => {
    const parts = name.split('/');
    parts.pop();
    await mkdir(join(root, ...parts), { recursive: true });
    await writeFile(join(root, name), content);
  };
  it('detects manifests and literal targets without evaluating them', async () => {
    await put(
      'package.json',
      JSON.stringify({
        packageManager: 'pnpm@10',
        scripts: { test: 'touch NEVER', 'weird;echo owned': 'x' },
      }),
    );
    await put('Makefile', 'build: dep\n\techo x\n.secret:\n%.o:\nVAR := x\n');
    await put(
      'justfile',
      'hello name:\n  echo hi\n_private:\nset shell := ["sh"]\n',
    );
    await put(
      'Taskfile.yml',
      'version: "3"\ntasks:\n  hello:\n    cmds: [echo hi]\n  secret:\n    internal: true\n',
    );
    await put('deno.jsonc', '{// comment\n"tasks":{"serve":"x"}}');
    await put('composer.json', '{"scripts":{"test":"x","post-install":"x"}}');
    await put(
      'pyproject.toml',
      '[tool.poe.tasks]\nlint = "ruff"\n[tool.pdm.scripts]\ntest = "pytest"\n',
    );
    await put('Cargo.toml', '[package]\nname="fixture"\n');
    await put('src/main.rs', 'fn main() {}');
    await put('go.mod', 'module fixture');
    const result = await scan();
    expect(result.complete).toBe(true);
    expect(result.actions.map((a) => a.command)).toEqual(
      expect.arrayContaining([
        "pnpm 'run' 'test'",
        "pnpm 'run' 'weird;echo owned'",
        "make 'build'",
        "just 'hello'",
        "task 'hello'",
        "deno 'task' 'serve'",
        "composer 'run' 'test'",
        "poe 'lint'",
        "pdm 'run' 'test'",
        "cargo 'run'",
        "go 'test' './...'",
      ]),
    );
    expect(result.actions.every((a) => a.status === 'pending')).toBe(true);
    expect(
      result.actions.some(
        (a) =>
          a.name === '_private' ||
          a.name === 'secret' ||
          a.name === 'post-install',
      ),
    ).toBe(false);
  });
  it('enumerates packages, exclusions and chooses the root lockfile first', async () => {
    await put('package.json', '{"workspaces":["apps/*","!apps/skip"]}');
    await put('pnpm-lock.yaml', 'lockfileVersion: 9');
    await put('apps/web/package.json', '{"scripts":{"test":"x"}}');
    await put('apps/web/package-lock.json', '{}');
    await put('apps/skip/package.json', '{"scripts":{"test":"x"}}');
    const result = await scan();
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      packagePath: 'apps/web',
      command: "pnpm 'run' 'test'",
      target: { kind: 'repository', repoId: 'repo' },
    });
    const old = result.actions[0]?.revision;
    await put('apps/web/package.json', '{"scripts":{"test":"y"}}');
    expect((await scan()).actions[0]?.revision).not.toBe(old);
  });
  it('quotes shell files, keeps distinct identities and fingerprints executable metadata', async () => {
    await put('scripts/a b.sh', '#!/bin/bash\necho hello');
    await put('bin/a b.sh', '#!/bin/sh\necho hello');
    const before = await scan();
    expect(before.actions.map((a) => a.command)).toEqual(
      expect.arrayContaining(["bash './scripts/a b.sh'", "sh './bin/a b.sh'"]),
    );
    expect(new Set(before.actions.map((a) => a.id)).size).toBe(2);
    await chmod(join(root, 'scripts/a b.sh'), 0o755);
    const after = await scan();
    expect(
      after.actions.find((a) => a.source.file === 'scripts/a b.sh')?.revision,
    ).not.toBe(
      before.actions.find((a) => a.source.file === 'scripts/a b.sh')?.revision,
    );
  });
  it('reports malformed and oversized sources and rejects external symlinks', async () => {
    await put('package.json', '{bad');
    await put('Makefile', 'x'.repeat(DETECTION_LIMITS.sourceBytes + 1));
    await symlink(tmpdir(), join(root, 'scripts'));
    const result = await scan();
    expect(result.complete).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['malformed', 'truncated', 'outside-root']),
    );
  });
  it('parses only top-level static aliases, preserving duplicate names and line evidence', async () => {
    await put(
      '.bashrc',
      "alias test='pnpm test'; alias dev=\"npm run dev\" # ok\nif true; then\nalias nested='git status'\nfi\nalias dynamic='git $BRANCH'\nalias nope='echo hi'\n",
    );
    await put('.zshrc', "alias test='make test'\n");
    const result = await detectShellAliases({ home: root, shell: 'bash' });
    expect(result.actions.map((a) => a.command)).toEqual([
      'pnpm test',
      'npm run dev',
      'make test',
    ]);
    expect(new Set(result.actions.map((a) => a.id)).size).toBe(3);
    expect(result.actions[0]?.source).toMatchObject({
      file: '~/.bashrc',
      line: 1,
    });
  });
  it('binds package scripts to the selected lockfile rather than its contents', async () => {
    await put('package.json', '{"scripts":{"test":"echo x"}}');
    await writeFile(join(root, 'bun.lockb'), new Uint8Array([0x80]));
    const before = await scan();
    expect(before.actions[0]?.command).toBe("bun 'run' 'test'");
    await writeFile(join(root, 'bun.lockb'), new Uint8Array([0x81]));
    const unchanged = await scan();
    expect(unchanged.actions[0]?.revision).toBe(before.actions[0]?.revision);
    await put('pnpm-lock.yaml', 'lockfileVersion: 9');
    const switched = await scan();
    expect(switched.actions[0]?.command).toBe("pnpm 'run' 'test'");
    expect(switched.actions[0]?.revision).not.toBe(before.actions[0]?.revision);
  });
  it('selects the package manager from a lockfile larger than the read limit', async () => {
    await put('package.json', '{"scripts":{"test":"echo x"}}');
    await put('pnpm-lock.yaml', 'x'.repeat(DETECTION_LIMITS.sourceBytes + 1));
    const result = await scan();
    expect(result.actions[0]?.command).toBe("pnpm 'run' 'test'");
    expect(result.actions[0]?.unavailableReason).toBeUndefined();
    expect(result.complete).toBe(true);
  });
  it('reads sources larger than 1 MiB', async () => {
    await put('Makefile', `build:\n#${'x'.repeat(2 * 1024 * 1024)}\n`);
    const result = await scan();
    expect(result.complete).toBe(true);
    expect(result.actions.map((action) => action.command)).toContain(
      "make 'build'",
    );
  });
  it('excludes just directives containing colons and supports virtual Cargo workspaces', async () => {
    await put('justfile', 'import "elsewhere:recipes"\npublic:\n  echo hi\n');
    await put('Cargo.toml', '[workspace]\nmembers = []\n');
    const result = await scan();
    expect(result.actions.some((action) => action.name === 'import')).toBe(
      false,
    );
    expect(
      result.actions.some((action) => action.command === "cargo 'build'"),
    ).toBe(true);
  });
  it('deduplicates Make rules and distinguishes Poe from PDM source entries', async () => {
    await put('Makefile', 'build: one\nbuild: two\n');
    await put(
      'pyproject.toml',
      '[tool.poe.tasks]\ntest = "poe"\n[tool.pdm.scripts]\ntest = "pdm"\n',
    );
    const result = await scan();
    expect(
      result.actions.filter((action) => action.source.kind === 'makefile'),
    ).toHaveLength(1);
    const python = result.actions.filter(
      (action) => action.source.kind === 'pyproject',
    );
    expect(python).toHaveLength(2);
    expect(new Set(result.actions.map((action) => action.id)).size).toBe(
      result.actions.length,
    );
  });
  it('does not propose alias-looking text inside multiline quotes, heredocs or subshells', async () => {
    await put(
      '.bashrc',
      [
        "printf '%s' '",
        "alias quoted='git status'",
        "'",
        'cat <<EOF',
        "alias heredoc='git status'",
        'EOF',
        '(',
        "alias subshell='git status'",
        ')',
        "alias real='git status'",
      ].join('\n'),
    );
    const result = await detectShellAliases({ home: root, shell: 'bash' });
    expect(result.actions.map((action) => action.name)).toEqual(['real']);
  });

  it('uses the PowerShell call operator for executable shell paths', async () => {
    await put('scripts/task.sh', '#!/bin/sh\necho ok');
    await chmod(join(root, 'scripts/task.sh'), 0o755);
    const result = await detectRepositoryScripts({
      root,
      repoId: 'repo',
      repoName: 'Repo',
      shell: 'powershell',
      platform: 'posix',
    });
    expect(result.actions[0]?.command).toBe("& './scripts/task.sh'");
  });

  it('keeps unrepresentable newline filenames valid but unavailable', async () => {
    await put('scripts/a\nb.sh', 'echo ok');
    const result = await scan();
    expect(result.actions[0]).toMatchObject({
      multiline: true,
      unavailableReason:
        'Filename cannot be safely represented in this terminal shell.',
    });
  });
  it('reports unsupported Cargo member syntax as incomplete rather than observed removal', async () => {
    await put(
      'Cargo.toml',
      '[workspace]\nmembers = ["apps/*", include("other")]\n',
    );
    const result = await scan();
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'Cargo.toml', code: 'unsupported' }),
      ]),
    );
  });

  it('watches the existing parent of a not-yet-created nested script directory', async () => {
    await put('.github/workflows/ci.yml', 'name: fixture');
    expect((await scan()).watchedDirectories).toContain('.github');
  });
});
