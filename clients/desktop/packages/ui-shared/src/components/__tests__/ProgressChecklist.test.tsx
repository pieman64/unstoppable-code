/**
 * Static-render tests for the shared {@link ProgressChecklist}. Verifies each
 * step status renders its expected icon/label color, and that the optional
 * badge and error text render.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProgressChecklist,
  type ProgressChecklistStep,
} from '../ProgressChecklist';

describe('ProgressChecklist', () => {
  const steps: ProgressChecklistStep[] = [
    { key: 'a', label: 'First step', status: 'completed' },
    { key: 'b', label: 'Second step', status: 'active' },
    { key: 'c', label: 'Third step', status: 'pending' },
  ];

  it('renders one row per step with labels', () => {
    const html = renderToStaticMarkup(<ProgressChecklist steps={steps} />);
    expect(html).toContain('First step');
    expect(html).toContain('Second step');
    expect(html).toContain('Third step');
  });

  it('renders the completed checkmark and emerald color', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[{ key: 'a', label: 'Done step', status: 'completed' }]}
      />,
    );
    expect(html).toContain('✓');
    expect(html).toContain('fg-success-strong');
  });

  it('renders the active spinner', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[{ key: 'a', label: 'Busy step', status: 'active' }]}
      />,
    );
    // LoadingSpinner exposes an aria-label of "Loading".
    expect(html).toContain('aria-label="Loading"');
  });

  it('renders a pending step with a hollow dot and muted label', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[{ key: 'a', label: 'Waiting step', status: 'pending' }]}
      />,
    );
    expect(html).toContain('Waiting step');
    expect(html).toContain('fg-secondary/50');
    // pending shows no spinner and no checkmark
    expect(html).not.toContain('aria-label="Loading"');
    expect(html).not.toContain('✓');
  });

  it('renders the error mark, color, and error text', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[{ key: 'a', label: 'Bad step', status: 'error' }]}
        error="boom failed"
      />,
    );
    expect(html).toContain('✗');
    expect(html).toContain('fg-destructive-strong');
    expect(html).toContain('boom failed');
  });

  it('renders a status badge when provided', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={steps}
        badge={{ label: 'In progress', tone: 'progress' }}
      />,
    );
    expect(html).toContain('In progress');
    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-info-subtle');
  });

  it('renders nested substeps as their own list under the parent step', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[
          {
            key: 'parent',
            label: 'Parent step',
            status: 'active',
            testId: 'parent-step',
            substeps: [
              { key: 'child-a', label: 'Child done', status: 'completed' },
              { key: 'child-b', label: 'Child busy', status: 'active' },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('data-testid="parent-step"');
    expect(html).toContain('data-step-status="active"');
    expect(html).toContain('data-step-status="completed"');
    // The children render inside the parent's own list, after its label.
    const parentAt = html.indexOf('Parent step');
    expect(html.indexOf('Child done')).toBeGreaterThan(parentAt);
    expect(html.indexOf('Child busy')).toBeGreaterThan(parentAt);
    expect(html.match(/role="list"/g)?.length).toBe(2);
  });

  it('renders step detail content and a label title', () => {
    const html = renderToStaticMarkup(
      <ProgressChecklist
        steps={[
          {
            key: 'a',
            label: 'Failed step',
            status: 'error',
            title: 'Revision 3',
            detail: <p>Fix the thing, then retry.</p>,
          },
        ]}
      />,
    );
    expect(html).toContain('title="Revision 3"');
    expect(html).toContain('<p>Fix the thing, then retry.</p>');
  });
});
