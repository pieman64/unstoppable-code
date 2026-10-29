import { McpActivationHandoff } from '../mcp/activation-handoff';
import type { McpSessionBinding } from '../mcp/session-availability';

const binding: McpSessionBinding = {
  ownerId: 'owner',
  scope: { projectId: 'project', worktreeId: 'tree', chatId: 'chat' },
  provider: 'claude',
  sessionId: 'session',
  generation: 4,
};
function setup(canSend: () => Promise<boolean> = () => Promise.resolve(true)): {
  handoff: McpActivationHandoff;
  controller: AbortController;
} {
  const controller = new AbortController();
  const handoff = new McpActivationHandoff(
    4,
    'original',
    controller.signal,
    canSend,
  );
  handoff.preparedSession(binding);
  return { handoff, controller };
}

test('holds the original prompt until dispatch and completes only on native admission', async () => {
  const { handoff } = setup();
  let sent = false;
  const prompt = handoff.beforePrompt('original').then(() => {
    sent = true;
  });
  await Promise.resolve();
  expect(sent).toBe(false);
  const admission = handoff.dispatch();
  await prompt;
  expect(handoff.pending).toBe(true);
  await expect(handoff.beforePrompt('original')).rejects.toThrow(
    'already submitted',
  );
  handoff.accepted();
  await expect(admission).resolves.toBe('accepted');
});

test('rejects a changed original task without granting submission', async () => {
  const { handoff } = setup();
  await expect(handoff.beforePrompt('new-user')).rejects.toThrow(
    'task changed',
  );
  handoff.failed();
  await expect(handoff.admission).resolves.toBe('not_sent');
});

test('Stop during the last ownership check prevents submission', async () => {
  let release: (value: boolean) => void = () => {};
  const { handoff, controller } = setup(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const admission = handoff.dispatch();
  const prompt = handoff.beforePrompt('original');
  await Promise.resolve();
  controller.abort();
  release(true);
  await expect(prompt).rejects.toThrow();
  await expect(admission).resolves.toBe('not_sent');
  handoff.accepted();
  await expect(handoff.admission).resolves.toBe('not_sent');
});

test('loss after submission records uncertainty instead of replay authority', async () => {
  const { handoff, controller } = setup();
  const admission = handoff.dispatch();
  await handoff.beforePrompt('original');
  controller.abort();
  await expect(admission).resolves.toBe('uncertain');
  await expect(handoff.beforePrompt('original')).rejects.toThrow();
});
