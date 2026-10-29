import { spawn } from 'node:child_process';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { CursorModelAuthenticationError } from './model-discovery-error';
import { getObservabilityService } from '../observability';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { connectAcp, type AcpClient } from '@canopy/desktop-shared/node/acp';
import type { CursorModelEntry } from '@canopy/desktop-shared/types';
import {
  CURSOR_MODEL_NAMES_METHOD,
  cursorModelNamesFromAcp,
  cursorModelsFromAcp,
} from '@canopy/desktop-shared/lib/cursor-models';
import { cursorModelConfigOptionsFromListing } from '@canopy/desktop-shared/lib/cursor-thinking';
import { getManagedCursorRuntime } from './connection';
import { cursorConnectionStatus } from './runtime-status';
import {
  runCursorRuntimeCommand,
  stopCursorProcessGroup,
} from '@canopy/desktop-shared/node/cursor/runtime-process';

/** Catalog discovery never prompts, opens a repo, or runs a tool. */
export async function discoverCursorModels(
  signal: AbortSignal,
): Promise<CursorModelEntry[]> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'cursor-models-'));
  let client: AcpClient | undefined;
  let stop: (() => Promise<void>) | undefined;
  const abort = (): void => {
    client?.close();
    void stop?.();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // Discovery runs inside the managed profile Connect signed in to, with
    // HOME swapped for a private overlay under the temp directory, the same
    // layering chats and delegation use. A profile built from scratch here
    // only worked on macOS, where the Keychain is reachable from any HOME;
    // the CLI keeps its Windows sign-in in `%APPDATA%\Cursor\auth.json`, so a
    // fresh APPDATA reported signed out and emptied the picker. The CLI's
    // config and data directories are throwaway too: `session/new` writes a
    // session record and per-project worker state under them, and those die
    // with the temp directory instead of piling up in the shared profile.
    const managed = await getManagedCursorRuntime(signal, undefined, {
      homeOverlay: join(directory, 'home'),
      stateOverlay: join(directory, 'state'),
    });
    const env = managed.env;
    // Never initiate interactive sign-in from the model picker.
    const status = await runCursorRuntimeCommand(
      managed.launch,
      ['status', '--format', 'json'],
      env,
      signal,
    );
    let auth: unknown;
    try {
      auth = JSON.parse(status.stdout);
    } catch {
      throw new Error('Reconnect Cursor in Settings to load models.');
    }
    if (
      typeof auth === 'object' &&
      auth !== null &&
      'isAuthenticated' in auth &&
      auth.isAuthenticated === false
    ) {
      throw new CursorModelAuthenticationError();
    }
    if (
      status.code !== 0 ||
      typeof auth !== 'object' ||
      auth === null ||
      !('isAuthenticated' in auth) ||
      auth.isAuthenticated !== true
    ) {
      throw new Error('Reconnect Cursor in Settings to load models.');
    }
    signal.throwIfAborted();
    const child = spawn(
      managed.launch.command,
      [...managed.launch.prefix, '--disable-auto-update', 'acp'],
      {
        cwd: directory,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    let stopping: Promise<void> | undefined;
    stop = (): Promise<void> =>
      (stopping ??= stopCursorProcessGroup(child.pid, closed));
    child.stderr.resume();
    client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(child.stdin),
        close: (): void => {
          void stop?.();
        },
      },
      clientInfo: { name: 'canopy-cursor-models', version: '1' },
      resourceGeneration: 1,
      onUpdate: (): void => {},
      onPermission: () => Promise.resolve('deny'),
      timeouts: { initializeMs: 15_000, requestMs: 30_000 },
    });
    signal.throwIfAborted();
    if (
      client
        .getInitialization()
        .authMethods?.some((method) => method.id === 'cursor_login')
    ) {
      await client.authenticate({ methodId: 'cursor_login' }, signal);
    }
    const session = await client.newSession({ cwd: directory, mcpServers: [] });
    signal.throwIfAborted();
    // The vendor listing supplies display names and per-model thinking options.
    // Discovery still succeeds when an older runtime cannot answer it.
    let names = new Map<string, string>();
    let listing: Map<string, SessionConfigOption[]> | undefined;
    try {
      const response = await client.extMethod(
        CURSOR_MODEL_NAMES_METHOD,
        {},
        signal,
        5_000,
      );
      names = cursorModelNamesFromAcp(response);
      listing = cursorModelConfigOptionsFromListing(response);
    } catch (error) {
      // Unknown support hides the composer control. Record the failed vendor
      // request so an absent effort control can be diagnosed.
      signal.throwIfAborted();
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'cursor_model_listing_unavailable',
        reason: `${CURSOR_MODEL_NAMES_METHOD}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    signal.throwIfAborted();
    return cursorModelsFromAcp(session.configOptions ?? [], names, listing);
  } finally {
    signal.removeEventListener('abort', abort);
    client?.close();
    await stop?.();
    await rm(directory, { recursive: true, force: true });
  }
}

const CACHE_MS = 60_000;
let revision = 0;
let cached: { models: CursorModelEntry[]; expiresAt: number } | undefined;
let pending:
  | { controller: AbortController; done: Promise<CursorModelEntry[]> }
  | undefined;

/** One bounded discovery process for all pickers; refresh on reopen after a minute. */
export async function listCursorModels(): Promise<CursorModelEntry[]> {
  const generation = revision;
  const status = await cursorConnectionStatus();
  if (generation !== revision)
    throw new Error('Cursor model discovery stopped.');
  if (!(status.enabled && status.supported && status.installed)) {
    await invalidateCursorModels();
    return [];
  }
  if (cached && Date.now() < cached.expiresAt)
    return structuredClone(cached.models);
  if (!pending) {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45_000),
    ]);
    const done = discoverCursorModels(signal).then((models) => {
      signal.throwIfAborted();
      cached = { models, expiresAt: Date.now() + CACHE_MS };
      return models;
    });
    const operation = { controller, done };
    pending = operation;
    void done
      .finally(() => {
        if (pending === operation) pending = undefined;
      })
      .catch(() => {});
  }
  return structuredClone(await pending.done);
}

export async function invalidateCursorModels(): Promise<void> {
  revision++;
  cached = undefined;
  const operation = pending;
  operation?.controller.abort();
  await operation?.done.catch(() => undefined);
}
