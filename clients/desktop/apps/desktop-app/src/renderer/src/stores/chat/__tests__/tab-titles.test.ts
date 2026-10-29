import type { ChatTab } from '../types';
import {
  createBranchTabTitle,
  createContinuedTabTitle,
  createForkTabTitle,
  firstMessageTitlePatch,
} from '../tab-utils';

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'New Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

describe('derived chat titles', () => {
  it('derive from the source custom title before its generated name', () => {
    const source = tab({ customTitle: 'Mine', description: 'Generated' });
    expect(createForkTabTitle(source)).toBe('Fork: Mine');
    expect(createBranchTabTitle(source)).toBe('Mine');
    expect(createContinuedTabTitle(source, 'Codex')).toBe('Codex: Mine');
  });

  it('keep the generated name when the custom title is blank or absent', () => {
    expect(
      createForkTabTitle(tab({ customTitle: '  ', description: 'Generated' })),
    ).toBe('Fork: Generated');
    expect(createForkTabTitle(tab({ description: 'Generated' }))).toBe(
      'Fork: Generated',
    );
  });
});

describe('first-message tab titles', () => {
  it('derive a placeholder title and keep the chat eligible for naming', () => {
    expect(
      firstMessageTitlePatch(
        tab(),
        'Investigate the failing health-check endpoint.',
      ),
    ).toEqual({
      title: 'Investigate the failing health-check end...',
      automaticTitleState: 'pending',
    });
    expect(firstMessageTitlePatch(tab({ title: '  ' }), 'Short')).toEqual({
      title: 'Short',
      automaticTitleState: 'pending',
    });
  });

  it('never reopen naming that main has closed', () => {
    expect(
      firstMessageTitlePatch(tab({ automaticTitleState: 'closed' }), 'Hello'),
    ).toEqual({ title: 'Hello', automaticTitleState: 'closed' });
  });

  it('leave meaningful creation titles unchanged', () => {
    expect(
      firstMessageTitlePatch(tab({ title: 'Debug failed pipeline' }), 'Hi'),
    ).toBeNull();
    expect(firstMessageTitlePatch(tab(), '   ')).toBeNull();
  });
});
