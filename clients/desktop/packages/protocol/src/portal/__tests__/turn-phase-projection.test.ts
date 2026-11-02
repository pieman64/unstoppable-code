import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const queueProjectionFiles = [
  'apps/desktop-app/src/main/services/chat-service.ts',
  'apps/desktop-app/src/main/services/standalone-chat-service.ts',
];
const desktopSharedTypesPath = 'packages/desktop-shared/src/types.ts';

describe('chat turn phase projections', () => {
  it('re-exports the retry block on the host view without persisting it', () => {
    const source = readFileSync(
      resolve(process.cwd(), desktopSharedTypesPath),
      'utf8',
    );
    const hostQueueType = source.match(
      /export interface HostQueuedMessageView\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    const persistedQueueType = source.match(
      /export interface PersistedHostQueuedMessage\s*\{([\s\S]*?)^\}/m,
    )?.[1];
    expect(source).toContain(
      "export type { QueuedMessageRetryBlockedReason } from '@canopy/protocol/portal';",
    );
    expect(hostQueueType).toMatch(
      /retryBlockedReason\?: QueuedMessageRetryBlockedReason;/,
    );
    expect(persistedQueueType).toBeDefined();
    expect(persistedQueueType).not.toMatch(/retryBlockedReason\??\s*:/);
  });

  it.each(queueProjectionFiles)(
    'projects the message turn phase from %s',
    (filePath) => {
      const source = readFileSync(resolve(process.cwd(), filePath), 'utf8');

      expect(source).toMatch(
        /\.\.\.\(message\.turnPhase !== undefined\s*\?\s*\{\s*turnPhase:\s*message\.turnPhase\s*\}\s*:\s*\{\}\),/,
      );
    },
  );

  it.each(queueProjectionFiles)(
    'projects the message waiting reason from %s',
    (filePath) => {
      const source = readFileSync(resolve(process.cwd(), filePath), 'utf8');

      expect(source).toMatch(
        /\.\.\.\(message\.waitingReason !== undefined\s*\?\s*\{\s*waitingReason:\s*message\.waitingReason\s*\}\s*:\s*\{\}\),/,
      );
    },
  );

  it('re-exports the phase on the host view without persisting it', () => {
    const source = readFileSync(
      resolve(process.cwd(), desktopSharedTypesPath),
      'utf8',
    );
    const persistedQueueType = source.match(
      /export interface PersistedHostQueuedMessage\s*\{([\s\S]*?)^\}/m,
    )?.[1];

    expect(source).toContain(
      "export type { ChatTurnPhase } from '@canopy/protocol/portal';",
    );
    expect(source).toMatch(/turnPhase\?: ChatTurnPhase;/);
    expect(persistedQueueType).toBeDefined();
    expect(persistedQueueType).not.toMatch(/turnPhase\??\s*:/);
  });

  it('re-exports the waiting reason on the host view without persisting it', () => {
    const source = readFileSync(
      resolve(process.cwd(), desktopSharedTypesPath),
      'utf8',
    );
    const persistedQueueType = source.match(
      /export interface PersistedHostQueuedMessage\s*\{([\s\S]*?)^\}/m,
    )?.[1];

    expect(source).toContain(
      "export type { QueuedMessageWaitingReason } from '@canopy/protocol/portal';",
    );
    expect(source).toMatch(/waitingReason\?: QueuedMessageWaitingReason;/);
    expect(persistedQueueType).toBeDefined();
    expect(persistedQueueType).not.toMatch(/waitingReason\??\s*:/);
  });
});
