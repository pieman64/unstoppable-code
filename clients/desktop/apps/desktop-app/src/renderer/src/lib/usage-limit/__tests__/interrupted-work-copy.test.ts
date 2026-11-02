import { brandText } from '@/lib/brand';
import { interruptedWorkReasonSummary } from '../interrupted-work-copy';

it('injects the current desktop brand into the shared reason summary', () => {
  expect(
    interruptedWorkReasonSummary([
      {
        kind: 'chat',
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        chatTitle: 'Chat',
        detectedAt: 1,
        worktreeName: 'main',
        provider: 'claude',
        resumeReason: 'app_shutdown',
      },
    ]),
  ).toBe(`${brandText.appName} closed before this chat finished.`);
});
