/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { RunSpinner } from '../RunSpinner';

function renderSpinner(): Element | null {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<RunSpinner />);
  return container.firstElementChild;
}

describe('RunSpinner', () => {
  it('names itself as an image, so assistive technology reads "Running"', () => {
    const spinner = renderSpinner();
    expect(spinner?.getAttribute('role')).toBe('img');
    expect(spinner?.getAttribute('aria-label')).toBe('Running');
  });

  it('stops the sweep under reduced motion, leaving the dots visible', () => {
    // The global reduced-motion rule runs an animation once for 0.01ms and
    // the sweep's last frame hides its dot, so each sweeping dot opts out of
    // the animation and keeps its own (visible) opacity instead.
    const dots = Array.from(renderSpinner()?.children ?? []);
    const sweeping = dots.filter((dot) =>
      dot.classList.contains('animate-run-dot'),
    );
    expect(dots).toHaveLength(9);
    expect(sweeping).toHaveLength(8);
    for (const dot of sweeping) {
      expect(dot.classList.contains('motion-reduce:animate-none')).toBe(true);
    }
  });
});
