import { isLastTabOfFixedGroup } from '../fixed-group-close';

const tab = (panelId: string): { panelId: string } => ({ panelId });

describe('isLastTabOfFixedGroup', () => {
  it('holds for the only tab of the chat group', () => {
    const groups = { 'group-chat': { tabs: [tab('chat-1')] } };
    expect(isLastTabOfFixedGroup(groups, 'chat-1')).toBe(true);
  });

  it('lets a tab close once its group has another', () => {
    const groups = { 'group-chat': { tabs: [tab('chat-1'), tab('chat-2')] } };
    expect(isLastTabOfFixedGroup(groups, 'chat-1')).toBe(false);
  });

  it('never holds in the Side Panel or the bottom drawer', () => {
    const groups = {
      'group-extras': { tabs: [tab('browser')] },
      'group-terminal': { tabs: [tab('terminal')] },
    };
    expect(isLastTabOfFixedGroup(groups, 'browser')).toBe(false);
    expect(isLastTabOfFixedGroup(groups, 'terminal')).toBe(false);
  });

  it('is false for an unknown tab or layout', () => {
    expect(isLastTabOfFixedGroup(undefined, 'chat-1')).toBe(false);
    expect(
      isLastTabOfFixedGroup({ 'group-chat': { tabs: [tab('a')] } }, 'b'),
    ).toBe(false);
  });
});
