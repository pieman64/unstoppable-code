import { PANEL_TITLE_MAX_LENGTH } from '@canopy/protocol';
import {
  SUBAGENT_CHAT_PANEL_FALLBACK_TITLE,
  SUBAGENTS_PANEL_ID,
  SUBAGENTS_PANEL_TITLE,
  subagentChatPanelIdFor,
  subagentChatPanelInstanceKey,
  subagentChatPanelSeed,
  subagentChatPanelTitle,
  subagentsPanelSeed,
} from '../subagent-panel-identity';

describe('subagent panel identity', () => {
  it('builds the Subagents singleton seed', () => {
    expect(subagentsPanelSeed()).toEqual({
      kind: 'subagents',
      panelId: SUBAGENTS_PANEL_ID,
      title: SUBAGENTS_PANEL_TITLE,
      instance: {},
    });
  });

  it('sanitizes deterministic subagent panel ids', () => {
    expect(subagentChatPanelIdFor('root/chat', 'child:one')).toBe(
      'panel-subagent-chat-root_chat-child_one',
    );
  });

  it('trims, clamps, and falls back for subagent chat titles', () => {
    expect(subagentChatPanelTitle('  Research agent  ')).toBe('Research agent');
    expect(subagentChatPanelTitle('   ')).toBe(
      SUBAGENT_CHAT_PANEL_FALLBACK_TITLE,
    );
    const longTitle = 'x'.repeat(PANEL_TITLE_MAX_LENGTH + 1);
    expect(subagentChatPanelTitle(longTitle)).toBe(
      'x'.repeat(PANEL_TITLE_MAX_LENGTH),
    );
  });

  it('builds a bound subagent-chat seed with the display title', () => {
    expect(
      subagentChatPanelSeed({
        rootChatId: 'root-chat',
        subagentId: 'subagent-1',
        subagentKind: 'managed',
        title: ' Inspect files ',
      }),
    ).toEqual({
      kind: 'subagent-chat',
      panelId: 'panel-subagent-chat-root-chat-subagent-1',
      title: 'Inspect files',
      instance: {
        rootChatId: 'root-chat',
        subagentId: 'subagent-1',
        subagentKind: 'managed',
      },
    });
  });

  it('uses the encoded root-chat/subagent pair as the instance key', () => {
    expect(
      subagentChatPanelInstanceKey({
        rootChatId: 'root/chat',
        subagentId: 'child:one',
      }),
    ).toBe('subagent-chat:root%2Fchat/child%3Aone');
  });
});
