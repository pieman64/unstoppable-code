import { buildScheduledMessagePreviewRows } from '../worktreeRowPreviewRows';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';

// Seam coverage: the desktop builder fills `scheduleLabel`, which the shared
// `ChatPreviewPopover` renders in place of its generic "Scheduled for …" line.
describe('buildScheduledMessagePreviewRows scheduleLabel', () => {
  const LOCAL_NOW = new Date(2026, 8, 30, 12, 0, 0);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LOCAL_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function message(
    overrides: Partial<ScheduledQueuedMessage>,
  ): ScheduledQueuedMessage {
    return {
      automationId: 'automation-1',
      activityName: 'Runner savings report',
      chatId: 'chat-1',
      text: 'Summarize the runner savings.',
      scheduledAt: new Date(2026, 8, 30, 18, 0, 0).toISOString(),
      scheduleKind: 'one_time',
      ...overrides,
    };
  }

  function sixPm(): string {
    return new Date(2026, 8, 30, 18, 0, 0).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  it('labels recurring rows with cadence and next run', () => {
    const [row] = buildScheduledMessagePreviewRows({
      wtKey: 'ws/wt',
      messages: [
        message({ scheduleKind: 'cron', scheduleExpression: '0 * * * *' }),
      ],
    });
    expect(row?.scheduleLabel).toBe(`Every hour · next ${sixPm()}`);
  });

  it('labels one-time rows with the send time', () => {
    const [row] = buildScheduledMessagePreviewRows({
      wtKey: 'ws/wt',
      messages: [message({})],
    });
    expect(row?.scheduleLabel).toBe(`Sends ${sixPm()}`);
  });

  it('omits the label when the time cannot be formatted', () => {
    const [row] = buildScheduledMessagePreviewRows({
      wtKey: 'ws/wt',
      messages: [message({ scheduledAt: '' })],
    });
    expect(row).not.toHaveProperty('scheduleLabel');
  });
});
