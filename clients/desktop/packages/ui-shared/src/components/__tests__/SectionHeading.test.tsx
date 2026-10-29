/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomizeSectionHeading, SectionHeading } from '../SectionHeading';

describe('SectionHeading', () => {
  it('renders one level-one heading over its subtitle', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <SectionHeading title="Usage" subtitle="See what ran." />,
    );

    const headings = container.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe('Usage');
    expect(headings[0]?.className).toBe('text-xl font-semibold fg-primary');
    expect(container.querySelector('p')?.textContent).toBe('See what ran.');
    expect(container.querySelector('p')?.className).toBe('text-s fg-secondary');
    expect(container.firstElementChild?.className).toBe('min-w-0 space-y-2');
  });

  it('keeps its own rhythm when a host adds placement classes', () => {
    const markup = renderToStaticMarkup(
      <SectionHeading
        title="Usage"
        subtitle="See what ran."
        className="mt-2"
      />,
    );
    expect(markup).toContain('class="min-w-0 space-y-2 mt-2"');
  });
});

describe('CustomizeSectionHeading', () => {
  it('names the section Customize on every host', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<CustomizeSectionHeading />);

    expect(container.querySelector('h1')?.textContent).toBe('Customize');
    expect(container.querySelector('p')?.textContent).toBe(
      'Add and manage plugins, MCP servers, skills, workflows, collections, and agents.',
    );
    expect(container.textContent).not.toContain('Marketplace');
  });
});
