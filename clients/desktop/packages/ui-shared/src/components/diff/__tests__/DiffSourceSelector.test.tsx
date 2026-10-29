import { renderToString } from 'react-dom/server';
import { DiffSourceSelector } from '../DiffSourceSelector';

describe('DiffSourceSelector', () => {
  it('renders all three sources by default', () => {
    const html = renderToString(
      <DiffSourceSelector value="uncommitted" onChange={(): void => {}} />,
    );
    expect(html).toContain('Uncommitted');
    expect(html).toContain('Committed');
    expect(html).toContain('Combined');
  });

  it('marks the active option with aria-pressed and the primary palette', () => {
    const html = renderToString(
      <DiffSourceSelector value="combined" onChange={(): void => {}} />,
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>Combined/);
    expect(html).toContain('bg-accent-subtle');
  });

  it('honors a custom option list', () => {
    const html = renderToString(
      <DiffSourceSelector
        value="uncommitted"
        options={[
          { value: 'uncommitted', label: 'Local' },
          { value: 'committed', label: 'Pushed' },
        ]}
        onChange={(): void => {}}
      />,
    );
    expect(html).toContain('Local');
    expect(html).toContain('Pushed');
    expect(html).not.toContain('Combined');
  });
});
