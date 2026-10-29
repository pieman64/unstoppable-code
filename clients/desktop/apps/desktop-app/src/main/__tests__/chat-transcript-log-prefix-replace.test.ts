import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import * as cooperativeJson from '../lib/cooperative-json';
import * as directorySync from '../lib/fsync-directory';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

const CHAT = 'chat-1';

// Each case writes several hundred-row stores; sharded runs share the disk.
jest.setTimeout(60_000);

function text(id: number, role: PersistedChatMessage['role']): string {
  return `${role} ${id} ${'x'.repeat(id % 7)}\n🌲`;
}

/** Turns of: user prompt, a completed turn timer, and assistant rows. */
function transcript(count: number, seed = 0): PersistedChatMessage[] {
  return Array.from({ length: count }, (_, id): PersistedChatMessage => {
    const position = id % 5;
    if (position === 0)
      return {
        id: `m-${id}`,
        role: 'user',
        timestamp: id,
        blocks: [{ type: 'text', text: text(id + seed, 'user') }],
      };
    if (position === 1)
      return {
        id: `m-${id}`,
        role: 'system',
        timestamp: id,
        blocks: [
          { type: 'turn_timer', startedAt: id, completedAt: id + 4 + seed },
        ],
      };
    return {
      id: `m-${id}`,
      role: 'assistant',
      timestamp: id,
      blocks: [{ type: 'text', text: text(id + seed, 'assistant') }],
    };
  });
}

function patched(
  rows: readonly PersistedChatMessage[],
  ordinal: number,
  suffix = ' (patched)',
): PersistedChatMessage[] {
  return rows.map((row, i) =>
    i === ordinal
      ? {
          ...row,
          blocks: [{ type: 'text', text: `patched ${row.id}${suffix}` }],
        }
      : row,
  );
}

/** The incident shape: a timer row toggling between completed and running. */
function reopenedTimer(
  rows: readonly PersistedChatMessage[],
  ordinal: number,
): PersistedChatMessage[] {
  return rows.map((row, i) =>
    i === ordinal
      ? {
          ...row,
          blocks: [{ type: 'turn_timer', startedAt: i, completedAt: null }],
        }
      : row,
  );
}

function sameLengthEdit(
  rows: readonly PersistedChatMessage[],
  ordinal: number,
): PersistedChatMessage[] {
  return rows.map((row, i) => {
    const [block] = row.blocks;
    if (i !== ordinal || block.type !== 'text') return row;
    return {
      ...row,
      blocks: [{ ...block, text: block.text.replace('x', 'y') }],
    };
  });
}

/** Spied fs calls receive paths as strings here; handles are not locators. */
function pathText(path: unknown): string {
  return typeof path === 'string' ? path : '';
}

function locatorName(messageId: string): string {
  return `${createHash('sha256').update(messageId).digest('hex')}.json`;
}

async function* streamed(
  rows: readonly PersistedChatMessage[],
): AsyncGenerator<PersistedChatMessage> {
  for (const row of rows) yield await Promise.resolve(row);
}

async function locatorContents(
  directory: string,
): Promise<Record<string, string>> {
  const locatorDirectory = join(directory, 'message-index', CHAT);
  const names = (await readdir(locatorDirectory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(
        async (name): Promise<[string, string]> => [
          name,
          await readFile(join(locatorDirectory, name), 'utf8'),
        ],
      ),
    ),
  );
}

/** Every derived locator must describe exactly one committed JSONL row. */
async function expectLocatorsMatchLog(directory: string): Promise<void> {
  const log = await readFile(join(directory, `${CHAT}.jsonl`), 'utf8');
  const expected: Record<string, string> = {};
  let offset = 0;
  for (const line of log.split('\n').filter(Boolean)) {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('id' in parsed) ||
      typeof parsed.id !== 'string'
    )
      throw new Error('Invalid fixture row');
    const end = offset + Buffer.byteLength(line) + 1;
    expected[locatorName(parsed.id)] = JSON.stringify({
      version: 1,
      messageId: parsed.id,
      offset,
      end,
      digest: createHash('sha256').update(line).digest('hex'),
    });
    offset = end;
  }
  expect(await locatorContents(directory)).toEqual(expected);
}

async function snapshot(directory: string): Promise<Record<string, unknown>> {
  return {
    entries: (await readdir(directory)).sort(),
    messageIndex: (await readdir(join(directory, 'message-index'))).sort(),
    jsonl: await readFile(join(directory, `${CHAT}.jsonl`), 'utf8'),
    index: await readFile(join(directory, `${CHAT}.index.json`), 'utf8'),
    turns: await readFile(join(directory, `${CHAT}.turns.json`), 'utf8'),
    locators: await locatorContents(directory),
  };
}

const BASE = transcript(620);
const EXTRA: PersistedChatMessage[] = Array.from({ length: 7 }, (_, i) => ({
  id: `extra-${i}`,
  role: i === 0 ? 'user' : 'assistant',
  timestamp: 1000 + i,
  blocks: [{ type: 'text', text: `extra ${i}` }],
}));

const SHAPES: Array<[string, PersistedChatMessage[]]> = [
  ['an identical replacement', BASE],
  ['a patch in the middle', patched(BASE, 310)],
  ['a same-length patch in the middle', sameLengthEdit(BASE, 312)],
  ['a patch at the end', patched(BASE, BASE.length - 1)],
  ['a reopened turn timer near the end', reopenedTimer(BASE, 611)],
  ['a patch of the first row', patched(BASE, 0)],
  ['a removal in the middle', BASE.filter((_, i) => i !== 404)],
  ['a removal at the end', BASE.slice(0, -1)],
  [
    'an insertion in the middle',
    [...BASE.slice(0, 450), EXTRA[0], ...BASE.slice(450)],
  ],
  ['appended rows', [...BASE, ...EXTRA]],
  ['a much shorter replacement', BASE.slice(0, 120)],
  ['a reordered suffix', [...BASE.slice(0, 600), ...BASE.slice(600).reverse()]],
  ['a completely different transcript', transcript(530, 3)],
  ['an unrelated transcript', EXTRA],
  ['an empty replacement', []],
];

describe('prefix-preserving transcript replacement', () => {
  let parent: string;
  let root: string;
  let log: ChatTranscriptLog;
  let references = 0;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'chat-log-prefix-'));
    root = join(parent, 'store');
    log = new ChatTranscriptLog(root);
    await log.initialize(CHAT);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(parent, { recursive: true, force: true });
  });

  /** A full replacement into a fresh store is the reference end state. */
  async function fullReplacement(
    rows: readonly PersistedChatMessage[],
    revision: number,
  ): Promise<{ directory: string; log: ChatTranscriptLog }> {
    references += 1;
    const directory = join(parent, `reference-${references}`);
    const reference = new ChatTranscriptLog(directory);
    await reference.initialize(CHAT);
    await reference.replace(CHAT, streamed(rows), revision);
    return { directory, log: reference };
  }

  it('rewrites only the changed suffix when one message near the end of a long transcript changes', async () => {
    const original = transcript(2000);
    await log.replace(CHAT, streamed(original), 1);
    const locatorDirectory = join(root, 'message-index', CHAT);
    const prefixLocator = join(locatorDirectory, locatorName('m-0'));
    const lateLocator = join(locatorDirectory, locatorName('m-1500'));
    const before = {
      prefix: await stat(prefixLocator, { bigint: true }),
      late: await stat(lateLocator, { bigint: true }),
      directory: await stat(locatorDirectory, { bigint: true }),
    };

    const writeFile = fsPromises.writeFile;
    const remove = fsPromises.rm;
    const locatorWrites: string[] = [];
    const locatorRemovals: string[] = [];
    jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation(async (path, data, options) => {
        if (pathText(path).includes(join(root, 'message-index')))
          locatorWrites.push(pathText(path));
        await writeFile(path, data, options);
      });
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (pathText(path).includes(join(root, 'message-index')))
        locatorRemovals.push(pathText(path));
      await remove(path, options);
    });
    const write = cooperativeJson.writeJsonValuesCooperatively;
    let rewrittenBytes = 0;
    jest
      .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
      .mockImplementation(async (path, values, options) => {
        const written = await write(path, values, options);
        if (path.endsWith('.rewrite.tmp')) rewrittenBytes += written;
        return written;
      });

    // A changed row near the end changes size, so every later row moves.
    const replacement = patched(original, 1990);
    await log.replace(CHAT, streamed(replacement), 2);

    // Only the patched row and the nine rows after it changed locators.
    expect(locatorWrites).toHaveLength(10);
    expect(locatorRemovals).toHaveLength(10);
    const transcriptBytes = (await stat(join(root, `${CHAT}.jsonl`))).size;
    expect(rewrittenBytes).toBeGreaterThan(0);
    expect(rewrittenBytes).toBeLessThan(transcriptBytes / 100);
    const after = {
      prefix: await stat(prefixLocator, { bigint: true }),
      late: await stat(lateLocator, { bigint: true }),
      directory: await stat(locatorDirectory, { bigint: true }),
    };
    expect(after.directory.ino).toBe(before.directory.ino);
    for (const key of ['prefix', 'late'] as const) {
      expect(after[key].ino).toBe(before[key].ino);
      expect(after[key].mtimeNs).toBe(before[key].mtimeNs);
    }
    jest.restoreAllMocks();

    const reader = new ChatTranscriptLog(root);
    expect((await reader.page(CHAT)).messages).toEqual(replacement.slice(-500));
    await expect(
      reader.committedMessageState(CHAT, replacement[1990]),
    ).resolves.toBe('identical');
    await expect(
      reader.committedMessageState(CHAT, replacement[1999]),
    ).resolves.toBe('identical');
    expect(await readdir(locatorDirectory)).toHaveLength(2000);
    await expectLocatorsMatchLog(root);
  }, 60_000);

  it('does not rewrite the log or any locator for an identical replacement', async () => {
    await log.replace(CHAT, streamed(BASE), 1);
    const before = await stat(join(root, `${CHAT}.jsonl`), { bigint: true });
    const writeFile = fsPromises.writeFile;
    const remove = fsPromises.rm;
    let locatorOperations = 0;
    jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation(async (path, data, options) => {
        if (pathText(path).includes(join(root, 'message-index')))
          locatorOperations += 1;
        await writeFile(path, data, options);
      });
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (pathText(path).includes(join(root, 'message-index')))
        locatorOperations += 1;
      await remove(path, options);
    });
    await log.replace(CHAT, streamed(BASE), 2);
    expect(locatorOperations).toBe(0);
    const after = await stat(join(root, `${CHAT}.jsonl`), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect((await log.descriptor(CHAT)).transcriptRevision).toBe(2);
  });

  it('appends a new turn by cloning the committed prefix without rewriting its locators', async () => {
    // Turn start: the user row commits while its timer stays active, so the
    // replacement is the whole committed log plus the new prompt.
    const original = transcript(2000);
    await log.replace(CHAT, streamed(original), 1);
    const logPath = join(root, `${CHAT}.jsonl`);
    const locatorDirectory = join(root, 'message-index', CHAT);
    const before = {
      log: await stat(logPath, { bigint: true }),
      locator: await stat(join(locatorDirectory, locatorName('m-1999')), {
        bigint: true,
      }),
    };
    const writeFile = fsPromises.writeFile;
    const remove = fsPromises.rm;
    const locatorWrites: string[] = [];
    let locatorRemovals = 0;
    jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation(async (path, data, options) => {
        if (pathText(path).includes(join(root, 'message-index')))
          locatorWrites.push(pathText(path));
        await writeFile(path, data, options);
      });
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (pathText(path).includes(join(root, 'message-index')))
        locatorRemovals += 1;
      await remove(path, options);
    });
    const copy = jest.spyOn(fsPromises, 'copyFile');
    const write = cooperativeJson.writeJsonValuesCooperatively;
    let stagedBytes = 0;
    jest
      .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
      .mockImplementation(async (path, values, options) => {
        const written = await write(path, values, options);
        if (path.endsWith('.rewrite.tmp')) stagedBytes += written;
        return written;
      });

    const prompt: PersistedChatMessage = {
      id: 'next-prompt',
      role: 'user',
      timestamp: 5000,
      blocks: [{ type: 'text', text: 'next prompt' }],
    };
    const replacement = [...original, prompt];
    await log.replace(CHAT, streamed(replacement), 2);
    await log.writeActive(CHAT, [
      {
        id: 'next-timer',
        role: 'system',
        timestamp: 5000,
        blocks: [{ type: 'turn_timer', startedAt: 5000, completedAt: null }],
      },
    ]);

    // The prefix is cloned (copy-on-write where supported), never serialized.
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0][0]).toBe(logPath);
    expect(copy.mock.calls[0][2]).toBe(fs.constants.COPYFILE_FICLONE);
    expect(locatorWrites).toEqual([
      join(locatorDirectory, locatorName('next-prompt')),
    ]);
    expect(locatorRemovals).toBe(0);
    expect(stagedBytes).toBe(Buffer.byteLength(JSON.stringify(prompt)) + 1);
    const after = {
      log: await stat(logPath, { bigint: true }),
      locator: await stat(join(locatorDirectory, locatorName('m-1999')), {
        bigint: true,
      }),
    };
    // Atomic publication: a new inode replaces the old log.
    expect(after.log.ino).not.toBe(before.log.ino);
    expect(after.log.size).toBe(before.log.size + BigInt(stagedBytes));
    expect(after.locator.ino).toBe(before.locator.ino);
    expect(after.locator.mtimeNs).toBe(before.locator.mtimeNs);
    jest.restoreAllMocks();

    expect(await readdir(root)).not.toContainEqual(
      expect.stringMatching(/\.tmp$/),
    );
    await expectLocatorsMatchLog(root);
    const reference = await fullReplacement(replacement, 2);
    await reference.log.writeActive(CHAT, await log.activeMessages(CHAT));
    expect(await log.descriptor(CHAT)).toEqual(
      await reference.log.descriptor(CHAT),
    );
    expect(await log.page(CHAT, undefined, { view: 'turns' })).toEqual(
      await reference.log.page(CHAT, undefined, { view: 'turns' }),
    );
  }, 60_000);

  it('clones the committed prefix copy-on-write when a row changes', async () => {
    await log.replace(CHAT, streamed(BASE), 1);
    const copy = jest.spyOn(fsPromises, 'copyFile');
    await log.replace(CHAT, streamed(patched(BASE, 600)), 2);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0][0]).toBe(join(root, `${CHAT}.jsonl`));
    expect(copy.mock.calls[0][2]).toBe(fs.constants.COPYFILE_FICLONE);
  });

  it.each(SHAPES)(
    'produces the same storage as a full replacement for %s',
    async (_label, replacement) => {
      await log.replace(CHAT, streamed(BASE), 1);
      const previousDigest = (await log.descriptor(CHAT)).committedDigest;
      await log.replace(CHAT, streamed(replacement), 7);
      const reference = await fullReplacement(replacement, 7);

      expect(await snapshot(root)).toEqual(await snapshot(reference.directory));
      await expectLocatorsMatchLog(root);
      const descriptor = await log.descriptor(CHAT);
      expect(descriptor).toEqual(await reference.log.descriptor(CHAT));
      // Search identity: only a byte-identical log keeps the committed digest.
      expect(descriptor.committedDigest === previousDigest).toBe(
        replacement === BASE,
      );

      // A restarted reader agrees through every read path.
      const reader = new ChatTranscriptLog(root);
      const rows: PersistedChatMessage[] = [];
      for await (const row of reader.iterate(CHAT)) rows.push(row);
      expect(rows).toEqual(replacement);
      expect(await reader.page(CHAT)).toEqual(await reference.log.page(CHAT));
      expect(await reader.page(CHAT, undefined, { view: 'turns' })).toEqual(
        await reference.log.page(CHAT, undefined, { view: 'turns' }),
      );
      const present = new Set(replacement.map((row) => row.id));
      for (const row of [...BASE, ...EXTRA])
        await expect(reader.hasCommittedMessage(CHAT, row.id)).resolves.toBe(
          present.has(row.id),
        );
      for (const row of replacement.slice(-12))
        await expect(reader.committedMessageState(CHAT, row)).resolves.toBe(
          'identical',
        );
    },
    60_000,
  );

  it('reuses a lagging turn index only for turns before the changed row', async () => {
    await log.replace(CHAT, streamed(BASE), 1);
    // Appends without a completed timer leave the derived turn index behind.
    await log.append(CHAT, EXTRA);
    const lagging: unknown = JSON.parse(
      await readFile(join(root, `${CHAT}.turns.json`), 'utf8'),
    );
    expect(lagging).toMatchObject({ committedMessageCount: BASE.length });
    const replacement = patched([...BASE, ...EXTRA], 503);
    await log.replace(CHAT, streamed(replacement), 4);
    const reference = await fullReplacement(replacement, 4);
    expect(await snapshot(root)).toEqual(await snapshot(reference.directory));
  });

  it('keeps an active tail split by the caller out of the preserved committed prefix', async () => {
    await log.replace(CHAT, streamed(BASE), 1);
    const replacement = reopenedTimer(BASE, 616);
    await log.replace(CHAT, streamed(replacement.slice(0, -3)), 2);
    await log.writeActive(CHAT, replacement.slice(-3));
    const reference = await fullReplacement(replacement.slice(0, -3), 2);
    await reference.log.writeActive(CHAT, replacement.slice(-3));
    expect(await log.descriptor(CHAT)).toEqual(
      await reference.log.descriptor(CHAT),
    );
    expect(await log.page(CHAT)).toEqual(await reference.log.page(CHAT));
    await expectLocatorsMatchLog(root);
  });

  it.each([
    ['repeats a preserved prefix row', [...BASE, BASE[3]]],
    [
      'repeats a replacement suffix row',
      [...BASE.slice(0, 600), EXTRA[1], EXTRA[1]],
    ],
  ])(
    'rejects a replacement that %s without changing committed history',
    async (_label, replacement) => {
      await log.replace(CHAT, streamed(BASE), 1);
      const before = await snapshot(root);
      await expect(log.replace(CHAT, streamed(replacement), 2)).rejects.toThrow(
        /duplicate/i,
      );
      expect(await snapshot(root)).toEqual(before);
      expect((await new ChatTranscriptLog(root).page(CHAT)).messages).toEqual(
        BASE.slice(-500),
      );
    },
  );

  it('rebuilds every locator when the replaced suffix of the old log is unreadable', async () => {
    await log.replace(CHAT, streamed(BASE), 1);
    const path = join(root, `${CHAT}.jsonl`);
    const bytes = await readFile(path);
    // Corrupt a row after the change without changing the log length, so the
    // checksummed sparse index still trusts the log.
    const corrupt = bytes.indexOf('assistant 603');
    if (corrupt < 0) throw new Error('Missing fixture row');
    bytes[corrupt] = 0xff;
    await fsPromises.writeFile(path, bytes);
    const replacement = patched(BASE, 600);
    await log.replace(CHAT, streamed(replacement), 2);
    const reference = await fullReplacement(replacement, 2);
    expect(await snapshot(root)).toEqual(await snapshot(reference.directory));
    await expectLocatorsMatchLog(root);
  });

  type Step = readonly [
    label: string,
    published: boolean,
    install: (fail: () => Error) => void,
  ];
  const isLocator = (path: unknown): boolean =>
    pathText(path).includes(`${'message-index'}`);
  const steps: Step[] = [
    [
      'while cloning the shared prefix',
      false,
      (fail): void => {
        jest
          .spyOn(fsPromises, 'copyFile')
          .mockImplementation(() => Promise.reject(fail()));
      },
    ],
    [
      'after writing the temporary log',
      false,
      (fail): void => {
        const write = cooperativeJson.writeJsonValuesCooperatively;
        jest
          .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
          .mockImplementation(async (path, values, options) => {
            const written = await write(path, values, options);
            if (path.endsWith('.rewrite.tmp')) throw fail();
            return written;
          });
      },
    ],
    [
      'after removing the sparse index',
      false,
      (fail): void => {
        const remove = fsPromises.rm;
        jest
          .spyOn(fsPromises, 'rm')
          .mockImplementation(async (path, options) => {
            await remove(path, options);
            if (pathText(path).endsWith(`${CHAT}.index.json`)) throw fail();
          });
      },
    ],
    [
      'after renaming the log',
      true,
      (fail): void => {
        const rename = fsPromises.rename;
        jest
          .spyOn(fsPromises, 'rename')
          .mockImplementation(async (source, destination) => {
            await rename(source, destination);
            if (String(destination).endsWith(`${CHAT}.jsonl`)) throw fail();
          });
      },
    ],
    [
      'midway through locator removal',
      true,
      (fail): void => {
        const remove = fsPromises.rm;
        let removed = 0;
        jest
          .spyOn(fsPromises, 'rm')
          .mockImplementation(async (path, options) => {
            if (isLocator(path) && ++removed === 3) throw fail();
            await remove(path, options);
          });
      },
    ],
    [
      'midway through locator writes',
      true,
      (fail): void => {
        const writeFile = fsPromises.writeFile;
        let written = 0;
        jest
          .spyOn(fsPromises, 'writeFile')
          .mockImplementation(async (path, data, options) => {
            if (isLocator(path) && ++written === 3) throw fail();
            await writeFile(path, data, options);
          });
      },
    ],
    [
      'before syncing the locator directory',
      true,
      (fail): void => {
        const sync = directorySync.fsyncDirectory;
        jest
          .spyOn(directorySync, 'fsyncDirectory')
          .mockImplementation(async (directory) => {
            if (directory.endsWith(join('message-index', CHAT))) throw fail();
            await sync(directory);
          });
      },
    ],
    [
      'before writing the sparse index',
      true,
      (fail): void => {
        const rename = fsPromises.rename;
        jest
          .spyOn(fsPromises, 'rename')
          .mockImplementation(async (source, destination) => {
            if (String(destination).endsWith(`${CHAT}.index.json`))
              throw fail();
            await rename(source, destination);
          });
      },
    ],
    [
      'before removing the active sidecar',
      true,
      (fail): void => {
        const remove = fsPromises.rm;
        jest
          .spyOn(fsPromises, 'rm')
          .mockImplementation(async (path, options) => {
            if (pathText(path).endsWith(`${CHAT}.active.json`)) throw fail();
            await remove(path, options);
          });
      },
    ],
    [
      'before writing the turn index',
      true,
      (fail): void => {
        const rename = fsPromises.rename;
        jest
          .spyOn(fsPromises, 'rename')
          .mockImplementation(async (source, destination) => {
            if (String(destination).endsWith(`${CHAT}.turns.json`))
              throw fail();
            await rename(source, destination);
          });
      },
    ],
  ];

  // A removal moves every later row, so suffix locators are rewritten and a
  // removed id's locator is deleted. A pure append (a turn start) removes no
  // locator, so it has no locator-removal step.
  const rewriteReplacement = reopenedTimer(
    BASE.filter((_, i) => i !== 605),
    611,
  );
  const appendReplacement = [...BASE, ...EXTRA];
  const faultCases: Array<
    readonly [string, PersistedChatMessage[], boolean, Step[2], string]
  > = [
    ...steps.map(
      ([label, published, install]) =>
        ['a rewrite', rewriteReplacement, published, install, label] as const,
    ),
    ...steps
      .filter(([label]) => label !== 'midway through locator removal')
      .map(
        ([label, published, install]) =>
          [
            'a pure append',
            appendReplacement,
            published,
            install,
            label,
          ] as const,
      ),
  ];

  it.each(faultCases)(
    'recovers %s interrupted %s',
    async (_kind, replacement, published, install) => {
      await log.replace(CHAT, streamed(BASE), 1);
      await log.writeActive(CHAT, [EXTRA[0]]);
      const logPath = join(root, `${CHAT}.jsonl`);
      const committedBytes = await readFile(logPath);
      let fired = false;
      install(() => {
        fired = true;
        return new Error('injected failure');
      });
      await expect(log.replace(CHAT, streamed(replacement), 2)).rejects.toThrow(
        'injected failure',
      );
      expect(fired).toBe(true);
      jest.restoreAllMocks();

      // Without replay, a restarted reader sees one coherent log: the old one
      // (byte for byte) before publication, the replacement after it.
      // Locators never disagree with it, and no temporary log is left behind.
      if (!published) expect(await readFile(logPath)).toEqual(committedBytes);
      expect(await readdir(root)).not.toContainEqual(
        expect.stringMatching(/\.rewrite\.tmp$/),
      );
      const expected = published ? replacement : BASE;
      const reader = new ChatTranscriptLog(root);
      const rows: PersistedChatMessage[] = [];
      for await (const row of reader.iterate(CHAT)) rows.push(row);
      expect(rows).toEqual(expected);
      for (const row of expected.slice(-20))
        await expect(reader.committedMessageState(CHAT, row)).resolves.toBe(
          'identical',
        );
      for (const id of ['m-605', 'extra-6'])
        await expect(reader.hasCommittedMessage(CHAT, id)).resolves.toBe(
          expected.some((row) => row.id === id),
        );
      await expectLocatorsMatchLog(root);

      // The durable transaction replays the same replacement after a crash.
      await new ChatTranscriptLog(root).replace(CHAT, streamed(replacement), 2);
      const reference = await fullReplacement(replacement, 2);
      expect(await snapshot(root)).toEqual(await snapshot(reference.directory));
      await expectLocatorsMatchLog(root);
    },
    60_000,
  );
});
