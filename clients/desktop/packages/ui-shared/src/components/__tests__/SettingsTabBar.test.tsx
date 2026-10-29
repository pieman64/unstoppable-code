// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsTabBar } from '../SettingsTabBar';

const tabStyles = readFileSync(
  path.join(
    process.cwd(),
    'packages/ui-shared/src/styles/canopy-tokens-core.css',
  ),
  'utf8',
);

const tabs = [
  { id: 'details', label: 'Details' },
  { id: 'danger', label: 'Danger', danger: true },
] as const;

describe('SettingsTabBar', () => {
  it('keeps the selected indicator flush with and above the shared divider', () => {
    expect(tabStyles).toMatch(
      /\.canopy-tab-list\s*\{[^}]*position:\s*relative;[^}]*border-bottom:\s*0;[^}]*column-gap:\s*32px\s*!important;[^}]*scrollbar-width:\s*none;/s,
    );
    expect(tabStyles).toMatch(
      /\.canopy-tab-list::after\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0;[^}]*z-index:\s*0;[^}]*border-bottom:\s*var\(--default-border-width\) solid var\(--line-base\);[^}]*content:\s*'';/s,
    );
    expect(tabStyles).toMatch(
      /\.canopy-tab-list::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s,
    );
    expect(tabStyles).toMatch(
      /\.canopy-tab-trigger\s*\{[^}]*border:\s*0;[^}]*padding-right:\s*0\s*!important;[^}]*padding-bottom:\s*16px\s*!important;[^}]*padding-left:\s*0\s*!important;[^}]*touch-action:\s*manipulation;/s,
    );
    expect(tabStyles).toMatch(
      /\.canopy-tab-trigger::before\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0 -8px;[^}]*content:\s*'';/s,
    );
    expect(tabStyles).toMatch(
      /\.canopy-tab-trigger\[aria-selected='true'\]::after\s*\{[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0;[^}]*z-index:\s*1;[^}]*height:\s*2px;[^}]*border-radius:\s*0;/s,
    );
  });

  it.each(['details', 'danger'] as const)(
    'uses the shared underline treatment for the selected %s tab',
    (activeTab) => {
      const html = renderToStaticMarkup(
        <SettingsTabBar
          tabs={tabs}
          activeTab={activeTab}
          onChange={jest.fn()}
        />,
      );

      expect(html).toContain('class="canopy-tab-list');
      expect(html).toContain('role="tablist"');

      const selectedButton = html.match(
        new RegExp(
          `<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*class="([^"]*canopy-tab-trigger[^"]*)"[^>]*>${activeTab === 'details' ? 'Details' : 'Danger'}</button>`,
        ),
      );
      expect(selectedButton?.[1]).not.toContain('border-b-2');
      expect(selectedButton?.[1]).not.toContain('tab-accent-line');
    },
  );
});
