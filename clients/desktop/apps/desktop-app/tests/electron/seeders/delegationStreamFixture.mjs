import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Only a request spec, never a storage manifest. Electron's E2E startup hook
// writes the retained fixture through the production chat-state APIs.
export function prepareStreamFixture({
  userDataDir,
  workspaceId = 'demo-ts-pnpm-vite',
  worktreeId = 'demo-main',
  chatId = 'stream-parent',
}) {
  const specPath = path.join(userDataDir, `${chatId}-stream-fixture.json`);
  const template = JSON.parse(
    readFileSync(
      new URL('../fixtures/delegation-stream.json', import.meta.url),
      'utf8',
    ),
  );
  writeFileSync(
    specPath,
    JSON.stringify({
      ...template,
      projectId: workspaceId,
      worktreeId,
      chatId,
    }),
  );
  return {
    chatId,
    delegationId: `${chatId}-child`,
    blocksDelegationId: `${chatId}-blocks`,
    liveDelegationId: `${chatId}-live`,
    specPath,
    extraEnv: {
      CANOPY_E2E_CHAT_FORMAT4: '1',
      CANOPY_E2E_SEED_STREAM_FIXTURE: specPath,
    },
  };
}
