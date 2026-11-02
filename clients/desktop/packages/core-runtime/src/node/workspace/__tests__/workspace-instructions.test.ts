import { join, resolve } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { UnsupportedInstructionLayoutError } from '../instruction-files';
import {
  applyProjectInstructionsChange,
  createCoreWorkspaceInstructionsHandlers,
  readInstructionTarget,
  regenerateProjectInstructions,
  restoreWorkspaceRootInstructions,
  scaffoldWorkspaceInstructions,
  writeInstructionTarget,
  type CoreWorkspaceInstructionsHost,
} from '../workspace-instructions';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'portal',
  grants: ['core.workspace.write'],
};
const context: CanopyHandlerContext = {
  requestId: 'request-1',
  caller,
  metadata: {},
  signal: new AbortController().signal,
};

const missing = (): Error =>
  Object.assign(new Error('missing'), { code: 'ENOENT' });

describe('readInstructionTarget and writeInstructionTarget', () => {
  it('treats only a missing file as empty', async () => {
    await expect(
      readInstructionTarget(
        { filePath: 'x' },
        { readText: () => Promise.reject(missing()) },
      ),
    ).resolves.toBe('');
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    await expect(
      readInstructionTarget(
        { filePath: 'x' },
        { readText: () => Promise.reject(denied) },
      ),
    ).rejects.toBe(denied);
  });

  it('creates the parent folder before writing the target and its mirror', async () => {
    const calls: string[] = [];
    const filePath = resolve('/ws/one/CLAUDE.md');
    await writeInstructionTarget({ filePath, mirrorPath: 'mirror' }, '# x', {
      ensureDirectory: (path) => {
        calls.push(`mkdir ${path}`);
        return Promise.resolve();
      },
      writeTarget: (target) => {
        calls.push(`write ${target.filePath} ${target.mirrorPath ?? ''}`);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([
      `mkdir ${resolve('/ws/one')}`,
      `write ${filePath} mirror`,
    ]);
  });
});

describe('core.workspace.instructions handlers', () => {
  function host(
    overrides: Partial<CoreWorkspaceInstructionsHost> = {},
  ): CoreWorkspaceInstructionsHost {
    return {
      read: () => Promise.resolve('# x'),
      write: () => Promise.resolve(),
      isInvalidWorkspaceId: () => false,
      ...overrides,
    };
  }

  it('returns content and an empty update receipt, passing the caller through', async () => {
    const write = jest.fn(() => Promise.resolve());
    const handlers = createCoreWorkspaceInstructionsHandlers(host({ write }));
    await expect(
      handlers.queries['core.workspace.instructions.get'](
        { workspaceId: 'a' },
        context,
      ),
    ).resolves.toEqual({ content: '# x' });
    await expect(
      handlers.instructions['core.workspace.instructions.update'](
        { workspaceId: 'a', content: '# y' },
        context,
      ),
    ).resolves.toEqual({});
    expect(write).toHaveBeenCalledWith('a', '# y', caller);
  });

  it('types identifier and layout failures and leaves others to the binding', async () => {
    const invalid = new Error('Invalid workspaceId');
    const layout = new UnsupportedInstructionLayoutError(
      'CLAUDE.md must be a regular file.',
    );
    const other = new Error('disk');
    const read = jest
      .fn<Promise<string>, [string]>()
      .mockRejectedValueOnce(invalid)
      .mockRejectedValueOnce(layout)
      .mockRejectedValueOnce(other);
    const handlers = createCoreWorkspaceInstructionsHandlers(
      host({ read, isInvalidWorkspaceId: (error) => error === invalid }),
    );
    const get = async (): Promise<unknown> => {
      try {
        await handlers.queries['core.workspace.instructions.get'](
          { workspaceId: 'a' },
          context,
        );
      } catch (error) {
        return error;
      }
      throw new Error('Expected a rejection.');
    };
    const first = await get();
    expect(first).toBeInstanceOf(CanopyOperationError);
    expect(first).toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.workspace.instructions.invalidWorkspaceId',
        retry: { kind: 'never' },
      },
      runtimeCause: invalid,
    });
    expect(await get()).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.workspace.instructions.unsupportedLayout',
      },
      runtimeCause: layout,
    });
    expect(await get()).toBe(other);
  });
});

describe('create and regenerate library functions', () => {
  it('scaffolds CLAUDE.md and adds the alias only when asked', async () => {
    const calls: string[] = [];
    const port = {
      writeClaudeMd: (content: string): Promise<void> => {
        calls.push(`write ${content}`);
        return Promise.resolve();
      },
      ensureAgentsMdAlias: (): Promise<void> => {
        calls.push('alias');
        return Promise.resolve();
      },
    };
    await scaffoldWorkspaceInstructions(
      { content: '# d', agentsMdAlias: true },
      port,
    );
    await scaffoldWorkspaceInstructions(
      { content: '# e', agentsMdAlias: false },
      port,
    );
    expect(calls).toEqual(['write # d', 'alias', 'write # e']);
  });

  const headings = { current: '## Guide', legacy: '## Old guide' };
  function targetPort(content = '# Mine\n'): {
    readText: jest.Mock<Promise<string>, [string]>;
    write: jest.Mock<Promise<void>, [unknown, string]>;
  } {
    return {
      readText: jest.fn<Promise<string>, [string]>(() =>
        Promise.resolve(content),
      ),
      write: jest.fn<Promise<void>, [unknown, string]>(() => Promise.resolve()),
    };
  }

  it.each([
    ['replace', true, 'default'],
    ['update', true, 'merged'],
    ['update', false, 'default'],
    ['replace', false, 'default'],
    ['keep', false, 'default'],
  ] as const)(
    'regenerates in %s mode (exists=%s) with the %s content',
    async (mode, exists, expected) => {
      const port = targetPort();
      const target = { filePath: 'CLAUDE.md', exists };
      await regenerateProjectInstructions(
        { target, mode, defaultContent: 'Use repos.', headings },
        port,
      );
      expect(port.write).toHaveBeenCalledWith(
        target,
        expected === 'default'
          ? 'Use repos.'
          : '# Mine\n\n## Guide\n\nUse repos.\n\n',
      );
      expect(port.readText).toHaveBeenCalledTimes(
        expected === 'merged' ? 1 : 0,
      );
    },
  );

  it('keeps existing instructions in keep mode', async () => {
    const port = targetPort();
    await regenerateProjectInstructions(
      {
        target: { filePath: 'CLAUDE.md', exists: true },
        mode: 'keep',
        defaultContent: 'Use repos.',
        headings,
      },
      port,
    );
    expect(port.readText).not.toHaveBeenCalled();
    expect(port.write).not.toHaveBeenCalled();
  });

  it('never writes an unchanged or unsupported project', async () => {
    const port = targetPort();
    await regenerateProjectInstructions(
      { target: undefined, mode: 'replace', defaultContent: 'x', headings },
      port,
    );
    await applyProjectInstructionsChange(undefined, 'x', port);
    expect(port.write).not.toHaveBeenCalled();
  });

  it('skips a source change whose content is already present', async () => {
    const port = targetPort('# Same');
    await applyProjectInstructionsChange(
      { filePath: 'A', exists: true },
      '# Same',
      port,
    );
    expect(port.write).not.toHaveBeenCalled();
    await applyProjectInstructionsChange(
      { filePath: 'A', exists: false },
      '',
      port,
    );
    expect(port.write).not.toHaveBeenCalled();
    await applyProjectInstructionsChange(
      { filePath: 'A', exists: true },
      '# New',
      port,
    );
    expect(port.write).toHaveBeenCalledWith(
      { filePath: 'A', exists: true },
      '# New',
    );
  });

  describe('restoreWorkspaceRootInstructions', () => {
    const targetDir = resolve('/root');
    const sourceDir = resolve('/source');
    function rootPort(
      layouts: Record<
        string,
        { filePath: string; exists: boolean; aliasPath?: string }
      >,
      agentsMdExists = false,
    ): {
      calls: string[];
      port: Parameters<typeof restoreWorkspaceRootInstructions>[1];
    } {
      const calls: string[] = [];
      return {
        calls,
        port: {
          resolve: (dir) => Promise.resolve(layouts[dir]),
          agentsMdExists: () => Promise.resolve(agentsMdExists),
          ensureAgentsMdAlias: (): Promise<void> => {
            calls.push('alias');
            return Promise.resolve();
          },
          restore: (source): Promise<void> => {
            calls.push(`restore ${source.filePath}`);
            return Promise.resolve();
          },
        },
      };
    }

    it('adds an alias beside an existing CLAUDE.md only when AGENTS.md is absent', async () => {
      const layouts = {
        [targetDir]: { filePath: join(targetDir, 'CLAUDE.md'), exists: true },
      };
      const absent = rootPort(layouts);
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: true },
        absent.port,
      );
      expect(absent.calls).toEqual(['alias']);
      const present = rootPort(layouts, true);
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: true },
        present.port,
      );
      expect(present.calls).toEqual([]);
    });

    it('restores a CLAUDE.md source and aliases it unless the target has its own alias', async () => {
      const source = { filePath: join(sourceDir, 'CLAUDE.md'), exists: true };
      const plain = rootPort({
        [targetDir]: { filePath: join(targetDir, 'AGENTS.md'), exists: false },
        [sourceDir]: source,
      });
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: true },
        plain.port,
      );
      expect(plain.calls).toEqual([`restore ${source.filePath}`, 'alias']);

      const aliased = rootPort({
        [targetDir]: {
          filePath: join(targetDir, 'CLAUDE.md'),
          exists: false,
          aliasPath: join(targetDir, 'AGENTS.md'),
        },
        [sourceDir]: source,
      });
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: true },
        aliased.port,
      );
      expect(aliased.calls).toEqual([`restore ${source.filePath}`]);
    });

    it('does nothing when restore is off or the source has no instructions', async () => {
      const layouts = {
        [targetDir]: { filePath: join(targetDir, 'AGENTS.md'), exists: false },
        [sourceDir]: { filePath: join(sourceDir, 'AGENTS.md'), exists: false },
      };
      const off = rootPort(layouts);
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: false },
        off.port,
      );
      const empty = rootPort(layouts);
      await restoreWorkspaceRootInstructions(
        { targetDir, sourceDir, restore: true },
        empty.port,
      );
      expect([...off.calls, ...empty.calls]).toEqual([]);
    });
  });
});
