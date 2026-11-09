import { z } from 'zod';
import { basename, dirname } from 'node:path';
import type * as fs from 'node:fs/promises';
import type {
  McpServerData,
  McpServerFile,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import {
  McpConfigStateError,
  classifyIndexDocument,
  classifyServerDocument,
  indexEnvelope,
  isAbsentError,
  isServerFileName,
  overlayIndexEntry,
  overlayServerDocument,
  readDocument,
  requireMutableState,
  serializeIndexOutput,
  serializeServerOutput,
  type IndexDocument,
} from './config-repository-format';

// Display and deletion reader; deletion keeps this forgiving policy until A3.
const legacyIndex = z.custom<McpServersIndexFile>(
  (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'servers' in value &&
    Array.isArray(value.servers),
);

type Disk = Pick<
  typeof fs,
  'readFile' | 'writeFile' | 'mkdir' | 'unlink' | 'readdir'
>;

/** Observes a removal step; it must not change the step's effects or order. */
type RemoveStepObserver = <T>(
  step: 'serverUnlink' | 'indexUpdate',
  run: () => Promise<T>,
) => Promise<T>;
const unobserved: RemoveStepObserver = (_step, run) => run();

/** One instance per production writer. Always acquire server lease before disk queue. */
export class McpConfigRepository {
  private readonly serverMutations = new Map<string, Promise<unknown>>();
  private diskMutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: {
      index: () => string;
      server: (id: string) => string;
    },
    private readonly disk: Disk,
  ) {}

  withServerMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.serverMutations.get(id) ?? Promise.resolve();
    const next = previous.then(mutation, mutation);
    const settled = next.catch((): void => undefined);
    this.serverMutations.set(id, settled);
    void settled.then((): void => {
      if (this.serverMutations.get(id) === settled)
        this.serverMutations.delete(id);
    });
    return next;
  }

  private withDiskMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.diskMutation.then(mutation, mutation);
    this.diskMutation = next.catch((): void => undefined);
    return next;
  }

  async readIndex(): Promise<McpServersIndexFile> {
    try {
      return legacyIndex.parse(
        JSON.parse(await this.disk.readFile(this.paths.index(), 'utf8')),
      );
    } catch {
      return { version: 1, servers: [] };
    }
  }

  /** Read-only compatibility reader; mutations use `readServerForMutation`. */
  async readServer(id: string): Promise<McpServerFile> {
    const parsed: unknown = JSON.parse(
      await this.disk.readFile(this.paths.server(id), 'utf8'),
    );
    return normalizeMcpServerFile(parsed, id);
  }

  private readServerDocument(id: string): ReturnType<typeof readDocument> {
    return readDocument(() =>
      this.disk.readFile(this.paths.server(id), 'utf8'),
    );
  }

  private readIndexDocument(): ReturnType<typeof readDocument> {
    return readDocument(() => this.disk.readFile(this.paths.index(), 'utf8'));
  }

  /** Strict current server state; `undefined` only when the file is absent. */
  readServerForMutation(id: string): Promise<McpServerFile | undefined> {
    return this.withDiskMutation(
      async () =>
        requireMutableState(
          'server',
          classifyServerDocument(await this.readServerDocument(id), id),
        )?.file,
    );
  }

  /**
   * An absent index is empty only when no other server definition remains;
   * the target's own file is rewritten and indexed by this save.
   */
  private async readMutableIndex(
    id: string,
  ): Promise<IndexDocument | undefined> {
    const current = requireMutableState(
      'index',
      classifyIndexDocument(await this.readIndexDocument()),
    );
    if (current) return current;
    let names: string[];
    try {
      names = await this.disk.readdir(dirname(this.paths.index()));
    } catch (error) {
      if (isAbsentError(error)) return undefined;
      throw new McpConfigStateError(
        'index',
        'unreadable',
        error instanceof Error ? error.message : 'directory read failed',
      );
    }
    const target = basename(this.paths.server(id));
    if (names.some((name) => name !== target && isServerFileName(name)))
      throw new McpConfigStateError('index', 'orphaned', 'server files remain');
    return undefined;
  }

  private async writeText(path: string, text: string): Promise<void> {
    await this.disk.mkdir(dirname(path), { recursive: true });
    await this.disk.writeFile(path, text, 'utf8');
  }

  private writeIndex(servers: McpServerIndexEntry[]): Promise<void> {
    return this.writeText(
      this.paths.index(),
      JSON.stringify({ version: 1, servers }, null, 2),
    );
  }

  /**
   * Refuses unusable index or server state before any write, and preserves
   * unknown fields of the retained documents.
   */
  save(
    id: string,
    prepare: (index: McpServersIndexFile) => {
      server: McpServerData;
      entry: McpServerIndexEntry;
    },
  ): Promise<McpServerFile> {
    return this.withDiskMutation(async () => {
      const index = await this.readMutableIndex(id);
      const current = requireMutableState(
        'server',
        classifyServerDocument(await this.readServerDocument(id), id),
      );
      const { server, entry } = prepare(
        index?.index ?? { version: 1, servers: [] },
      );
      if (server.definition.id !== id || entry.id !== id)
        throw new Error('MCP server id changed during save.');
      const output = serializeServerOutput(
        overlayServerDocument(current?.raw, server),
        id,
      );
      const indexText = serializeIndexOutput(overlayIndexEntry(index, entry));
      await this.writeText(this.paths.server(id), output.text);
      await this.writeText(this.paths.index(), indexText);
      return output.file;
    });
  }

  /** Legacy forgiving deletion until A3: damaged index state is replaced. */
  remove(id: string, observe: RemoveStepObserver = unobserved): Promise<void> {
    return this.withDiskMutation(async () => {
      await observe('serverUnlink', async () => {
        try {
          await this.disk.unlink(this.paths.server(id));
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw error;
        }
      });
      await observe('indexUpdate', async () => {
        const index = await this.readIndex();
        await this.writeIndex(index.servers.filter((row) => row.id !== id));
      });
    });
  }

  /** Strict: an unusable index refuses; an unusable definition is skipped. */
  backfill(
    needsFields: (entry: McpServerIndexEntry) => boolean,
    fieldsFor: (
      server: McpServerData,
    ) => Pick<McpServerIndexEntry, 'urlHost' | 'urlScheme'>,
  ): Promise<{ index: McpServersIndexFile; changed: boolean }> {
    return this.withDiskMutation(async () => {
      const current = requireMutableState(
        'index',
        classifyIndexDocument(await this.readIndexDocument()),
      );
      if (!current)
        return { index: { version: 1, servers: [] }, changed: false };
      let changed = false;
      const servers = await Promise.all(
        current.index.servers.map(
          async (entry): Promise<McpServerIndexEntry> => {
            if (!needsFields(entry)) return entry;
            const definition = classifyServerDocument(
              await this.readServerDocument(entry.id),
              entry.id,
            );
            if (definition.kind !== 'valid') return entry;
            const fields = fieldsFor(definition.value.file.server);
            if (fields.urlHost === undefined) return entry;
            changed = true;
            return { ...entry, ...fields };
          },
        ),
      );
      if (changed)
        await this.writeText(
          this.paths.index(),
          serializeIndexOutput(indexEnvelope(current.raw, servers)),
        );
      return { index: { ...current.index, servers }, changed };
    });
  }
}
