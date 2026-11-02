import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { delegationBlockId } from '@canopy/agent-transcript';
import type { AgentDelegationBrokerOptions } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  readMetadataOfRecord,
  type StoredDelegationV3,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import type { DelegationTranscriptPortResult } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  baseTask,
  createBrokerHarness,
  waitForLaunch,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import type { DeltaJournalBoundary } from '../../lib/chat-delta-journal/writer';
import { format4Scope } from './chat-format4-scope';
import { scopeSource } from './chat-delta-journal-harness';
import {
  chatId,
  delegationId,
  directory,
  parent,
  paths,
  scopes,
  target,
} from './delegation-two-scope-backing';

export { chatId, delegationId, target };

export function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export async function eventually(
  check: () => Promise<boolean>,
  label = 'eventual predicate',
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect({ [label]: await check() }).toEqual({ [label]: true });
}

/** Distinguishes a real failed step from a rejection AFTER the step completed. */
export class PhysicalFault {
  hits = 0;
  enabled = true;
  published = false;
  completed = false;
  constructor(
    readonly family: 'record' | 'artifact' | 'frame',
    readonly step: 'open' | 'write' | 'sync' | 'rename' | 'directory-sync',
    readonly root: string,
    readonly cut: 'before' | 'after' = 'before',
  ) {}

  private matches(path: string): boolean {
    if (!path.startsWith(this.root)) return false;
    if (this.family === 'record') return path.includes('/delegation/runs');
    if (this.family === 'artifact') return path.includes('/tool-output/');
    return (
      path.endsWith('/delta-journal.log') ||
      /\/delta-journal[^/]*\.log$/.test(path)
    );
  }

  private fail(): never {
    this.hits++;
    this.enabled = false;
    throw Object.assign(new Error(`C12 ${this.family} ${this.step}`), {
      code: 'EIO',
    });
  }

  install(): void {
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const selected = this.enabled && this.matches(String(path));
      const writing = flags === 'wx' || flags === 'r+';
      if (selected && writing && this.step === 'open' && this.cut === 'before')
        this.fail();
      const handle = await open(path, flags, mode);
      if (!selected) return handle;
      if (writing && this.step === 'open' && this.cut === 'after') {
        this.completed = true;
        await handle.close();
        this.fail();
      }
      if (writing && this.step === 'write') {
        if (this.family === 'frame')
          jest.spyOn(handle, 'write').mockImplementationOnce(() => this.fail());
        else {
          const writeFile = handle.writeFile.bind(handle);
          jest
            .spyOn(handle, 'writeFile')
            .mockImplementationOnce(async (...args) => {
              if (this.cut === 'after') {
                await writeFile(...args);
                this.completed = true;
              }
              this.fail();
            });
        }
      }
      if (
        (writing && this.step === 'sync') ||
        (flags === 'r' &&
          this.step === 'directory-sync' &&
          (this.family === 'record' || this.published))
      ) {
        const sync = handle.sync.bind(handle);
        jest.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          if (this.cut === 'after') {
            await sync();
            this.completed = true;
          }
          this.fail();
        });
      }
      return handle;
    });
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (this.enabled && this.matches(String(from))) {
        if (this.step === 'rename' && this.cut === 'before') this.fail();
        await rename(from, to);
        this.published = true;
        if (this.step === 'rename') {
          this.completed = true;
          this.fail();
        }
      } else await rename(from, to);
    });
  }
}

export interface C12Backing {
  scope: (typeof scopes)[number];
  service: ChatStateService;
  repository: ChatStateV2Repository;
  storage: FileDelegationStorage;
  port: RepositoryDelegationTranscriptPort;
  notifications: Parameters<
    NonNullable<AgentDelegationBrokerOptions['onSettled']>
  >[];
  errors: unknown[];
  /** Provider ingestion failures; the host reports these and retries creation. */
  ingressErrors: unknown[];
  harness: ReturnType<typeof createBrokerHarness>;
  spawn(): ReturnType<
    ReturnType<typeof createBrokerHarness>['broker']['spawn']
  >;
  start(): Promise<void>;
  terminal(text?: string): Promise<void>;
  record(): Promise<StoredDelegationV3>;
  rawCard(): ReturnType<ChatStateService['readStoredParentMessage']>;
  restart(preserveCrashImage?: boolean): Promise<void>;
  reopenRepository(): Promise<void>;
  simulateExit(): Promise<void>;
  dispose(): Promise<void>;
}

export async function c12Backing(
  root: string,
  options: {
    boundary?: (point: DeltaJournalBoundary) => Promise<void>;
    broker?: Partial<AgentDelegationBrokerOptions>;
  } = {},
): Promise<C12Backing> {
  const scope = scopes[0];
  if (!scope) throw new Error('Missing scope');
  const { backend } = await format4Scope(
    directory(root, scope),
    scope.worktreeId,
    scopeSource([{ id: chatId, messages: [] }]),
  );
  await backend.flush();
  backend.releaseJournal();
  await backend.disposeArtifactMaintenance();
  const repositoryOptions = {
    resolvePaths: (key): ReturnType<typeof paths> => paths(root, key),
    enableFormat4: true,
    delegationReadMetadata: readMetadataOfRecord,
    deltaJournalOnBoundary: options.boundary,
    deltaJournalIdleCheckpointMs: 3600_000,
  } satisfies ConstructorParameters<typeof ChatStateV2Repository>[0];
  let repository = new ChatStateV2Repository(repositoryOptions);
  let service = new ChatStateService({
    repository,
    recordDiagnostic: jest.fn(),
  });
  // A host-port forwarding adapter lets the SAME broker/outbox survive a
  // repository reopen. It never reaches into a production object's internals.
  const servicePort = new Proxy(service, {
    get: (_target, key): unknown => {
      const member: unknown = Reflect.get(service, key);
      return typeof member === 'function' ? member.bind(service) : member;
    },
  });
  const port = new RepositoryDelegationTranscriptPort(servicePort, scope);
  const storage = new FileDelegationStorage(
    join(directory(root, scope), 'delegation', 'runs'),
  );
  const notifications: Parameters<
    NonNullable<AgentDelegationBrokerOptions['onSettled']>
  >[] = [];
  const errors: unknown[] = [];
  const ingressErrors: unknown[] = [];
  let ingress = Promise.resolve();
  const brokerOptions: Partial<AgentDelegationBrokerOptions> = {
    testOnlyStreamGeneration: true,
    transcriptPort: port,
    onError: (error) => {
      errors.push(error);
    },
    onTranscript: (_parent, transcript) => {
      // The host's ordinary provider ingestion: stream cards are write-once.
      // One failed ingestion (for example against a repository drained by a
      // reopen) must not reject the chain that dispose() awaits.
      ingress = ingress
        .then(async () => {
          await service.ingestProviderEventWithOutcome({
            ...scope,
            chatId,
            data: {
              type: 'canopy_delegation',
              delegation: transcript,
              canopy_turn_user_message_id: transcript.parentTurnId,
            },
            mutationId: `c12:${transcript.sequence}:${crypto.randomUUID()}`,
          });
        })
        .catch((error: unknown) => {
          ingressErrors.push(error);
        });
    },
    onSettled: (...args) => {
      notifications.push(args);
      return Promise.resolve();
    },
    ...options.broker,
  };
  let harness = createBrokerHarness(brokerOptions, storage);
  const all = [harness];
  await harness.broker.initialize();
  return {
    scope,
    storage,
    port,
    notifications,
    errors,
    ingressErrors,
    get service(): ChatStateService {
      return service;
    },
    get repository(): ChatStateV2Repository {
      return repository;
    },
    get harness(): ReturnType<typeof createBrokerHarness> {
      return harness;
    },
    async spawn(): Promise<Awaited<ReturnType<C12Backing['spawn']>>> {
      const uuid = jest
        .spyOn(crypto, 'randomUUID')
        .mockReturnValueOnce(delegationId);
      const spawned = await harness.broker.spawn(parent(scope), baseTask);
      uuid.mockRestore();
      await ingress;
      return spawned;
    },
    async start(this: C12Backing): Promise<void> {
      const spawned = await this.spawn();
      if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
      await waitForLaunch(harness.runner, delegationId);
      await harness.runner.sink?.({
        delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 100,
        event: { type: 'started', nativeSessionId: 'c12-native' },
      });
      await ingress;
      await harness.broker.flushCardPublication(target(1));
    },
    async terminal(text?: string): Promise<void> {
      await harness.runner.sink?.({
        delegationId,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          ...(text === undefined ? {} : { finalText: text }),
        },
      });
      await ingress;
    },
    async record(): Promise<StoredDelegationV3> {
      for (let attempt = 0; ; attempt++) {
        try {
          const record = await storage.loadOne(delegationId);
          if (!record || record.version !== 3)
            throw new Error('Missing v3 record');
          return record;
        } catch (error) {
          // A test observer can hold an old inode across an atomic replacement:
          // nlink becomes zero between open and stat. Production chain reads
          // are serialized; retry ONLY these two bounded observation races.
          if (
            attempt >= 20 ||
            !(error instanceof Error) ||
            ![
              'Invalid private delegation record',
              'Delegation record changed while reading',
            ].includes(error.message)
          )
            throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      }
    },
    async rawCard(): Promise<Awaited<ReturnType<C12Backing['rawCard']>>> {
      await ingress;
      return service.readStoredParentMessage(
        scope,
        chatId,
        delegationBlockId(delegationId, 1),
      );
    },
    async restart(preserveCrashImage = false): Promise<void> {
      const image = preserveCrashImage
        ? await storage.loadOne(delegationId)
        : undefined;
      await harness.broker.close();
      await ingress;
      if (image) await storage.commit(image);
      harness = createBrokerHarness(brokerOptions, storage);
      all.push(harness);
      await harness.broker.initialize();
    },
    async reopenRepository(): Promise<void> {
      // drain closes a poisoned writer without manufacturing a successful
      // content barrier. Reopening uses the real reader/recovery implementation.
      await service.drain().catch(() => undefined);
      repository = new ChatStateV2Repository(repositoryOptions);
      service = new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      });
    },
    async simulateExit(): Promise<void> {
      // close() is graceful cancellation, NOT a crash. Preserve both broker
      // AND repository bytes, then discard only the graceful-close writes.
      const source = directory(root, scope);
      const image = join(root, 'simulated-process-image');
      await ingress;
      await fs.cp(source, image, { recursive: true });
      await harness.broker.close();
      await ingress;
      await service.drain().catch(() => undefined);
      await fs.rm(source, { recursive: true, force: true });
      await fs.cp(image, source, { recursive: true });
      await fs.rm(image, { recursive: true, force: true });
      repository = new ChatStateV2Repository(repositoryOptions);
      service = new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      });
    },
    async dispose(): Promise<void> {
      for (const entry of all) await entry.broker.close();
      await ingress;
      await service.drain();
    },
  };
}
