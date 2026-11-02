import { dirname, join, resolve } from 'node:path';
import {
  EDITABLE_INSTRUCTION_ALIAS_RULES,
  ensureRelativeAlias,
  hasExpectedRelativeAlias,
  isDirectInstructionAlias,
  isProjectInstructionFileReadable,
  mergeMultiRepoGuidance,
  resolveOptionalProjectInstructionFile,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  UnsupportedInstructionLayoutError,
  type InstructionAliasPort,
  type InstructionFilePorts,
} from '../instruction-files';

type Node =
  | { kind: 'file'; content: string }
  | { kind: 'link'; target: string }
  | { kind: 'dir' };

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** An in-memory folder tree with the port surface; records every write. */
function memoryFs(initial: Record<string, Node>): {
  ports: InstructionFilePorts & InstructionAliasPort;
  nodes: Map<string, Node>;
  writes: string[];
  failSymlink: (code: string) => void;
  failHardLink: () => void;
} {
  const nodes = new Map(
    Object.entries(initial).map(([path, node]) => [resolve(path), node]),
  );
  const writes: string[] = [];
  let symlinkFailure: string | undefined;
  let hardLinkFails = false;
  const follow = (path: string, depth = 0): Node | undefined => {
    const node = nodes.get(resolve(path));
    if (node?.kind !== 'link') return node;
    if (depth > 8) throw errno('ELOOP');
    return follow(resolve(dirname(path), node.target), depth + 1);
  };
  const readText = (path: string): Promise<string> => {
    const node = follow(path);
    if (!node) return Promise.reject(errno('ENOENT'));
    if (node.kind === 'dir') return Promise.reject(errno('EISDIR'));
    if (node.kind !== 'file') return Promise.reject(errno('EINVAL'));
    return Promise.resolve(node.content);
  };
  const writeThrough = (path: string, content: string): void => {
    let target = resolve(path);
    for (let node = nodes.get(target); node?.kind === 'link'; ) {
      target = resolve(dirname(target), node.target);
      node = nodes.get(target);
    }
    nodes.set(target, { kind: 'file', content });
  };
  const ports: InstructionFilePorts & InstructionAliasPort = {
    lstat: (path) => {
      const node = nodes.get(resolve(path));
      if (!node) return Promise.reject(errno('ENOENT'));
      return Promise.resolve({
        isFile: () => node.kind === 'file',
        isSymbolicLink: () => node.kind === 'link',
      });
    },
    readlink: (path) => {
      const node = nodes.get(resolve(path));
      return node?.kind === 'link'
        ? Promise.resolve(node.target)
        : Promise.reject(errno('EINVAL'));
    },
    readText,
    assertReadable: async (path) => {
      await readText(path);
    },
    writeText: (path, content) => {
      writes.push(`write ${path}`);
      writeThrough(path, content);
      return Promise.resolve();
    },
    copyFileExclusive: async (source, destination) => {
      writes.push(`copy-excl ${source} -> ${destination}`);
      if (nodes.has(resolve(destination))) throw errno('EEXIST');
      nodes.set(resolve(destination), {
        kind: 'file',
        content: await readText(source),
      });
    },
    symlink: (target, path) => {
      writes.push(`symlink ${target} -> ${path}`);
      if (symlinkFailure) {
        const code = symlinkFailure;
        symlinkFailure = undefined;
        return Promise.reject(errno(code));
      }
      if (nodes.has(resolve(path))) return Promise.reject(errno('EEXIST'));
      nodes.set(resolve(path), { kind: 'link', target });
      return Promise.resolve();
    },
    remove: (path) => {
      writes.push(`remove ${path}`);
      nodes.delete(resolve(path));
      return Promise.resolve();
    },
    hardLink: async (existingPath, path) => {
      writes.push(`hard-link ${existingPath} -> ${path}`);
      if (hardLinkFails) {
        hardLinkFails = false;
        throw errno('EXDEV');
      }
      nodes.set(resolve(path), {
        kind: 'file',
        content: await readText(existingPath),
      });
    },
    copyFile: async (source, destination) => {
      writes.push(`copy ${source} -> ${destination}`);
      nodes.set(resolve(destination), {
        kind: 'file',
        content: await readText(source),
      });
    },
  };
  return {
    ports,
    nodes,
    writes,
    failSymlink: (code): void => {
      symlinkFailure = code;
    },
    failHardLink: (): void => {
      hardLinkFails = true;
    },
  };
}

const dir = resolve('/project');
const agents = join(dir, 'AGENTS.md');
const claude = join(dir, 'CLAUDE.md');

describe('instruction alias rules', () => {
  it('makes the parent-segment and dangling-target rules explicit', async () => {
    const fs = memoryFs({
      [agents]: { kind: 'link', target: '../project/CLAUDE.md' },
    });
    await expect(
      isDirectInstructionAlias(
        agents,
        claude,
        fs.ports,
        EDITABLE_INSTRUCTION_ALIAS_RULES,
      ),
    ).resolves.toBe(false);
    await expect(
      isDirectInstructionAlias(agents, claude, fs.ports, {
        parentSegments: 'allow',
        danglingTarget: 'allow',
      }),
    ).resolves.toBe(true);
    // The default (editable) rules accept the dangling in-folder alias...
    const dangling = memoryFs({
      [agents]: { kind: 'link', target: 'CLAUDE.md' },
    });
    await expect(
      resolveProjectInstructionFile(dir, dangling.ports),
    ).resolves.toEqual({
      filePath: claude,
      exists: false,
      aliasPath: agents,
    });
    // ...readiness never does, and a strict caller can refuse it to edit.
    await expect(
      isProjectInstructionFileReadable(dir, 'AGENTS.md', dangling.ports),
    ).resolves.toBe(false);
    await expect(
      resolveProjectInstructionFile(dir, dangling.ports, {
        parentSegments: 'reject',
        danglingTarget: 'reject',
      }),
    ).rejects.toBeInstanceOf(UnsupportedInstructionLayoutError);
  });

  it('returns undefined only for unsupported layouts, not for read failures', async () => {
    const unsupported = memoryFs({ [agents]: { kind: 'dir' } });
    await expect(
      resolveOptionalProjectInstructionFile(dir, unsupported.ports),
    ).resolves.toBeUndefined();
    const failing = memoryFs({});
    failing.ports.lstat = (): Promise<never> => Promise.reject(errno('EACCES'));
    await expect(
      resolveOptionalProjectInstructionFile(dir, failing.ports),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('never reads through an escaping link', async () => {
    const fs = memoryFs({
      [agents]: { kind: 'link', target: '../outside.md' },
      [resolve('/outside.md')]: { kind: 'file', content: 'secret' },
    });
    const readText = jest.spyOn(fs.ports, 'readText');
    await expect(resolveProjectInstructionFile(dir, fs.ports)).rejects.toThrow(
      'Cannot edit AGENTS.md through this symbolic link.',
    );
    expect(readText).not.toHaveBeenCalled();
  });
});

describe('restoreProjectInstructionFiles platform rules', () => {
  const sourceDir = resolve('/source');
  const source = {
    filePath: join(sourceDir, 'CLAUDE.md'),
    exists: true,
  };
  const target = { filePath: join(dir, 'AGENTS.md'), exists: false };
  const linkedSource = (): Record<string, Node> => ({
    [join(sourceDir, 'CLAUDE.md')]: { kind: 'file', content: '# Rules' },
    [join(sourceDir, 'AGENTS.md')]: { kind: 'link', target: 'CLAUDE.md' },
  });

  it('symlinks the alias on POSIX and copies it on Windows', async () => {
    const posix = memoryFs(linkedSource());
    await restoreProjectInstructionFiles(source, target, 'darwin', posix.ports);
    expect(posix.nodes.get(agents)).toEqual({
      kind: 'link',
      target: 'CLAUDE.md',
    });

    const windows = memoryFs(linkedSource());
    await restoreProjectInstructionFiles(
      source,
      target,
      'win32',
      windows.ports,
    );
    expect(windows.nodes.get(agents)).toEqual({
      kind: 'file',
      content: '# Rules',
    });
    expect(windows.writes.some((write) => write.startsWith('symlink'))).toBe(
      false,
    );
  });

  it.each(['EPERM', 'EACCES'])(
    'copies after a %s symlink failure',
    async (code) => {
      const fs = memoryFs(linkedSource());
      fs.failSymlink(code);
      await restoreProjectInstructionFiles(source, target, 'linux', fs.ports);
      expect(fs.nodes.get(agents)).toEqual({
        kind: 'file',
        content: '# Rules',
      });
    },
  );

  it('rethrows other symlink failures', async () => {
    const fs = memoryFs(linkedSource());
    fs.failSymlink('ENOTSUP');
    await expect(
      restoreProjectInstructionFiles(source, target, 'darwin', fs.ports),
    ).rejects.toMatchObject({ code: 'ENOTSUP' });
  });

  it('never replaces an existing destination', async () => {
    const fs = memoryFs(linkedSource());
    await restoreProjectInstructionFiles(
      source,
      { ...target, exists: true },
      'darwin',
      fs.ports,
    );
    expect(fs.writes).toEqual([]);
  });
});

describe('ensureRelativeAlias options', () => {
  const start = (): ReturnType<typeof memoryFs> =>
    memoryFs({ [claude]: { kind: 'file', content: '# C' } });

  it('hard links on Windows without trying a symlink', async () => {
    const fs = start();
    await ensureRelativeAlias(
      agents,
      'CLAUDE.md',
      { platform: 'win32', posixPermissionFallback: false },
      fs.ports,
    );
    expect(fs.writes).toEqual([
      `remove ${agents}`,
      `hard-link ${claude} -> ${agents}`,
    ]);
  });

  it('copies on Windows when the hard link fails', async () => {
    const fs = start();
    fs.failHardLink();
    await ensureRelativeAlias(
      agents,
      'CLAUDE.md',
      { platform: 'win32', posixPermissionFallback: false },
      fs.ports,
    );
    expect(fs.writes.at(-1)).toBe(`copy ${claude} -> ${agents}`);
  });

  it('falls back on POSIX only when the caller allows it', async () => {
    const strict = start();
    strict.failSymlink('EPERM');
    await expect(
      ensureRelativeAlias(
        agents,
        'CLAUDE.md',
        { platform: 'darwin', posixPermissionFallback: false },
        strict.ports,
      ),
    ).rejects.toMatchObject({ code: 'EPERM' });

    const lenient = start();
    lenient.failSymlink('EACCES');
    await ensureRelativeAlias(
      agents,
      'CLAUDE.md',
      { platform: 'darwin', posixPermissionFallback: true },
      lenient.ports,
    );
    expect(lenient.nodes.get(agents)).toEqual({ kind: 'file', content: '# C' });
  });

  it('keeps an equivalent link and accepts a matching copy', async () => {
    const fs = memoryFs({
      [claude]: { kind: 'file', content: '# C' },
      [agents]: { kind: 'link', target: './CLAUDE.md' },
    });
    await ensureRelativeAlias(
      agents,
      'CLAUDE.md',
      { platform: 'darwin', posixPermissionFallback: false },
      fs.ports,
    );
    expect(fs.writes).toEqual([]);
    const copy = memoryFs({
      [claude]: { kind: 'file', content: '# C' },
      [agents]: { kind: 'file', content: '# C' },
    });
    await expect(
      hasExpectedRelativeAlias(agents, 'CLAUDE.md', copy.ports),
    ).resolves.toBe(true);
  });
});

describe('mergeMultiRepoGuidance', () => {
  const headings = { current: '## Current', legacy: '## Legacy' };
  it('replaces a legacy block and keeps user rules verbatim', () => {
    expect(
      mergeMultiRepoGuidance('# Mine\n\n## Legacy\n\nold\n', 'new', headings),
    ).toBe('# Mine\n\n## Current\n\nnew\n\n');
  });
});
