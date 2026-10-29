import { renderToString } from 'react-dom/server';
import { AutoArchiveSettingsControl } from '../AutoArchiveSettingsControl';

describe('AutoArchiveSettingsControl', () => {
  it('renders the shared enabled controls and host-specific child option', () => {
    const html = renderToString(
      <AutoArchiveSettingsControl
        enabled
        days={7}
        maxDays={36500}
        fallbackDays={7}
        description="Delete idle worktrees."
        toggleTestId="auto-archive-toggle"
        daysTestId="auto-archive-days"
        onEnabledChange={jest.fn()}
        onDaysChange={jest.fn()}
      >
        <span>Delete local branches with the worktrees</span>
      </AutoArchiveSettingsControl>,
    );

    expect(html).toContain('Auto delete');
    expect(html).not.toContain('Auto Archive');
    expect(html).toContain('Delete idle worktrees.');
    expect(html).toContain('data-testid="auto-archive-days"');
    expect(html).toContain('Delete local branches with the worktrees');
  });

  it('hides inactivity controls while disabled', () => {
    const html = renderToString(
      <AutoArchiveSettingsControl
        enabled={false}
        days={7}
        maxDays={36500}
        fallbackDays={7}
        description="Delete idle worktrees."
        toggleTestId="auto-archive-toggle"
        daysTestId="auto-archive-days"
        onEnabledChange={jest.fn()}
        onDaysChange={jest.fn()}
      />,
    );

    expect(html).not.toContain('data-testid="auto-archive-days"');
  });
});
