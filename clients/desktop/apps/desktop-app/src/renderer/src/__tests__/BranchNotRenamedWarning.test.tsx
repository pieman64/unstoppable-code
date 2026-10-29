import { renderToStaticMarkup } from 'react-dom/server';
import { BranchNotRenamedWarning } from '@/components/github/BranchNotRenamedWarning';

describe('BranchNotRenamedWarning', () => {
  it('renders the raw default branch name in code format', () => {
    const markup = renderToStaticMarkup(
      <BranchNotRenamedWarning
        isMultiRepo={false}
        branchNames={['dormouse-1713571200123']}
        unrenamedRepos={[]}
        onContinue={(): void => undefined}
        onRename={(): void => undefined}
        onClose={(): void => undefined}
      />,
    );

    expect(markup).toMatch(
      /<code class="[^"]*\bfont-mono\b[^"]*">dormouse-1713571200123<\/code>/,
    );
  });

  it('gives the destructive confirm button a hover fill distinct from its resting fill', () => {
    const markup = renderToStaticMarkup(
      <BranchNotRenamedWarning
        isMultiRepo={false}
        branchNames={['dormouse-1713571200123']}
        unrenamedRepos={[]}
        onContinue={(): void => undefined}
        onRename={(): void => undefined}
        onClose={(): void => undefined}
      />,
    );
    const confirm =
      /<button[^>]*class="([^"]*)"[^>]*>Continue anyway<\/button>/.exec(markup);
    const classes = (confirm?.[1] ?? '').split(/\s+/);

    // A hover utility that repeats the resting token paints nothing on hover.
    expect(classes).toContain('bg-destructive');
    expect(classes).toContain('hover:bg-destructive-hover');
    expect(classes).not.toContain('hover:bg-destructive');
  });
});
