import { selectPreferredOpenApp } from '../openInAppSelection';

const apps = [
  {
    id: 'vscode',
    name: 'VS Code',
    category: 'editor' as const,
    icon: 'vscode-icon',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    category: 'editor' as const,
    icon: 'cursor-icon',
  },
];

describe('selectPreferredOpenApp', () => {
  it('returns the same enabled last-used app as the top-bar split action', () => {
    expect(
      selectPreferredOpenApp(apps, {
        lastOpenApp: 'cursor',
        disabledOpenApps: [],
      }),
    ).toBe(apps[1]);
  });

  it('falls back to the first icon-bearing enabled app', () => {
    expect(
      selectPreferredOpenApp(apps, {
        lastOpenApp: 'cursor',
        disabledOpenApps: ['cursor'],
      }),
    ).toBe(apps[0]);
  });
});
