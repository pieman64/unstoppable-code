/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanProvenance } from '../PlanProvenance';

function render(source: string | undefined, path: string | undefined): string {
  return renderToStaticMarkup(
    <PlanProvenance source={source} sourceFilePath={path} />,
  );
}

describe('PlanProvenance', () => {
  it('names the source file of an imported plan', () => {
    const html = render('imported', 'docs/plans/rollout.md');
    expect(html).toContain('data-testid="plan-provenance"');
    expect(html).toContain('Imported · docs/plans/rollout.md');
  });

  it('renders nothing for other sources or a missing path', () => {
    expect(render('claude', 'docs/plan.md')).toBe('');
    expect(render('imported', undefined)).toBe('');
    expect(render('imported', '  ')).toBe('');
  });

  it('truncates a long path and keeps the full path in its title', () => {
    const path = `docs/${'nested/'.repeat(20)}plan.md`;
    const html = render('imported', path);
    expect(html).toContain('truncate');
    expect(html).toContain(`title="${path}"`);
  });
});
