import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import { validateId } from '../identifiers';

export type HookQueueKind = 'chat' | 'pipeline';

export interface HookQueueSavedEntry {
  version: 1;
  kind: HookQueueKind;
  queueId: string;
  runOperationId: string;
  actionIndex: number;
  revision: number;
  savedAt: string;
  payload: CanopyJsonValue;
}

export type HookQueueRead =
  | { status: 'ok'; entry: HookQueueSavedEntry }
  | { status: 'missing' }
  | { status: 'damaged' }
  | { status: 'newer'; version: number };

export interface HookQueueFiles {
  directory(): string;
  writeFileAtomically(path: string, text: string): Promise<void>;
  quarantine(path: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  try {
    validateId(value, 'queueId');
    return true;
  } catch {
    return false;
  }
}

function json(value: unknown): value is CanopyJsonValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(json)) ||
    (record(value) && Object.values(value).every(json))
  );
}

function envelope(
  value: unknown,
  queueId: string,
): value is HookQueueSavedEntry {
  return (
    record(value) &&
    value.version === 1 &&
    (value.kind === 'chat' || value.kind === 'pipeline') &&
    value.queueId === queueId &&
    validId(value.runOperationId) &&
    typeof value.actionIndex === 'number' &&
    Number.isInteger(value.actionIndex) &&
    value.actionIndex >= 0 &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.savedAt === 'string' &&
    'payload' in value &&
    json(value.payload)
  );
}

export class HookQueuePayloadStore {
  constructor(private readonly files: HookQueueFiles) {}

  async write(entry: HookQueueSavedEntry): Promise<void> {
    validateId(entry.queueId, 'queueId');
    const directory = this.files.directory();
    await mkdir(directory, { recursive: true });
    await this.files.writeFileAtomically(
      join(directory, `${entry.queueId}.json`),
      JSON.stringify(entry),
    );
  }

  async read(queueId: string): Promise<HookQueueRead> {
    validateId(queueId, 'queueId');
    const path = join(this.files.directory(), `${queueId}.json`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (record(error) && error.code === 'ENOENT')
        return { status: 'missing' };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (record(value) && typeof value.version === 'number' && value.version > 1)
      return { status: 'newer', version: value.version };
    if (envelope(value, queueId)) return { status: 'ok', entry: value };
    await this.files.quarantine(path);
    return { status: 'damaged' };
  }

  async remove(queueId: string): Promise<void> {
    validateId(queueId, 'queueId');
    try {
      await rm(join(this.files.directory(), `${queueId}.json`), {
        force: true,
      });
    } catch {
      return;
    }
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.files.directory());
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter(validId);
  }
}
