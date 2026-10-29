import type { ChatContextUsageBreakdown } from '@canopy/desktop-shared/types';
import { captureClaudeContextSnapshot } from '../../observability/capture-fields';

function contextSummary(): ChatContextUsageBreakdown {
  return {
    categories: [
      { name: 'Messages', tokens: 8, kind: 'used' },
      { name: 'Free space', tokens: 92, kind: 'free' },
    ],
    totalTokens: 13,
    maxTokens: 100,
    percentage: 13,
  };
}

describe('Claude audit context snapshot', () => {
  it('does not wait for the live summary and omits categories when they are not asked for', async () => {
    let resolveSummary: (summary: ChatContextUsageBreakdown) => void = () => {};
    const summary = new Promise<ChatContextUsageBreakdown>((resolve) => {
      resolveSummary = resolve;
    });
    let resolveCapture: () => void = () => {};
    const captured = new Promise<void>((resolve) => {
      resolveCapture = resolve;
    });
    const onSnapshot = jest.fn(() => resolveCapture());

    captureClaudeContextSnapshot({
      summary,
      includeCategories: false,
      endTokens: 11,
      userMessageId: 'msg-1',
      onSnapshot,
    });

    expect(onSnapshot).not.toHaveBeenCalled();
    resolveSummary(contextSummary());
    await captured;

    expect(onSnapshot).toHaveBeenCalledWith({
      type: 'canopy_context_snapshot',
      userMessageId: 'msg-1',
      context: { endTokens: 11, windowTokens: 100 },
    });
  });

  it('includes only bounded categories when they are asked for', async () => {
    const onSnapshot = jest.fn();
    let resolveCapture: () => void = () => {};
    const captured = new Promise<void>((resolve) => {
      resolveCapture = resolve;
    });
    onSnapshot.mockImplementation(resolveCapture);

    captureClaudeContextSnapshot({
      summary: Promise.resolve(contextSummary()),
      includeCategories: true,
      onSnapshot,
    });
    await captured;

    expect(onSnapshot).toHaveBeenCalledWith({
      type: 'canopy_context_snapshot',
      context: {
        endTokens: 13,
        windowTokens: 100,
        categories: [
          { name: 'Messages', tokens: 8, kind: 'used' },
          { name: 'Free space', tokens: 92, kind: 'free' },
        ],
      },
    });
  });

  it('swallows a summary read failure without emitting an event', async () => {
    const onSnapshot = jest.fn();
    captureClaudeContextSnapshot({
      summary: Promise.reject(new Error('summary unavailable')),
      includeCategories: true,
      onSnapshot,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onSnapshot).not.toHaveBeenCalled();
  });
});
