/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import {
  PanelChatTabQuestionMarker,
  PanelTabBar,
  type PanelTabStyle,
} from '../PanelTabBar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABS: PanelTabModel[] = [
  { panelId: 'panel-1', kind: 'chat', title: 'Release notes' },
];

let root: Root | null = null;

function render(node: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function renderBar(
  tabStyle: PanelTabStyle,
  seam: 'icon' | 'trailing',
): HTMLDivElement {
  const marker = (): JSX.Element => (
    <PanelChatTabQuestionMarker chatId="chat-1" />
  );
  return render(
    <PanelTabBar
      groupId="group-1"
      tabs={TABS}
      activePanelId="panel-1"
      onSelectTab={jest.fn()}
      onCloseTab={jest.fn()}
      tabStyle={tabStyle}
      {...(seam === 'icon'
        ? { renderTabIcon: marker }
        : { renderTabTrailing: marker })}
    />,
  );
}

describe('PanelChatTabQuestionMarker', () => {
  it.each([
    ['classic', 'icon'],
    ['fill', 'trailing'],
  ] as const)(
    'is a named image inside the %s tab (%s slot)',
    (tabStyle, seam) => {
      const container = renderBar(tabStyle, seam);
      const tab = container.querySelector('[data-testid="panel-tab-panel-1"]');
      const marker = tab?.querySelector(
        '[data-testid="panel-tab-question-chat-1"]',
      );
      expect(marker).not.toBeNull();
      expect(marker?.getAttribute('role')).toBe('img');
      expect(marker?.getAttribute('aria-label')).toBe('Question waiting');
      expect(marker?.getAttribute('title')).toBe('Question waiting');
      expect(marker?.className).toContain('fg-warning');
      // The glyph is decoration; the wrapper carries the name.
      const svg = marker?.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('data-glyph')).toBe('circle-help');
      expect(tab?.querySelectorAll('[role="img"]')).toHaveLength(1);
    },
  );

  it("is part of a fill tab's accessible content, outside any hidden slot", () => {
    const container = renderBar('fill', 'trailing');
    const marker = container.querySelector(
      '[data-testid="panel-tab-question-chat-1"]',
    );
    expect(marker?.closest('[aria-hidden="true"]')).toBeNull();
    expect(marker?.closest('[role="tab"]')).not.toBeNull();
  });
});

it('describes a pinned question tab even though its title overrides descendant names', () => {
  const container = render(
    <PanelTabBar
      groupId="group-1"
      tabs={TABS.map((tab) => ({ ...tab, pinned: true }))}
      activePanelId="panel-1"
      onSelectTab={jest.fn()}
      onCloseTab={jest.fn()}
      tabStyle="fill"
      renderTabTrailing={() => <PanelChatTabQuestionMarker chatId="chat-1" />}
      renderTabAccessibleStatus={() => 'Question waiting'}
    />,
  );
  const tab = container.querySelector('[role="tab"]');
  const descriptionId = tab?.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
    'Question waiting',
  );
});

it('keeps one persistent fill marker outside the label that wraps away', () => {
  const container = render(
    <PanelTabBar
      groupId="group-1"
      tabs={TABS}
      activePanelId="panel-1"
      onSelectTab={jest.fn()}
      onCloseTab={jest.fn()}
      tabStyle="fill"
      renderTabAttention={() => <PanelChatTabQuestionMarker chatId="chat-1" />}
    />,
  );
  const marker = container.querySelector(
    '[data-testid="panel-tab-question-chat-1"]',
  );
  expect(marker?.closest('.canopy-panel-tab-label')).toBeNull();
  expect(marker?.closest('[role="tab"]')).not.toBeNull();
  expect(
    container.querySelectorAll('[data-testid="panel-tab-question-chat-1"]'),
  ).toHaveLength(1);
});
