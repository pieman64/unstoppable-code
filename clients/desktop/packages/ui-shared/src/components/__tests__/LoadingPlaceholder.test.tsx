/**
 * @jest-environment jsdom
 */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingIndicatorStyleProvider } from '../LoadingIndicatorStyle';
import {
  LoadingPlaceholder,
  type LoadingPlaceholderSpace,
} from '../StatusBlocks';

describe('LoadingPlaceholder', () => {
  it('holds panel room and centers its label by default', () => {
    const markup = renderToStaticMarkup(<LoadingPlaceholder />);
    expect(markup).toContain('py-12');
    expect(markup).toContain('justify-center');
    expect(markup).toContain('Loading…');
  });

  it.each<[LoadingPlaceholderSpace, string]>([
    ['compact', 'py-4'],
    ['section', 'py-8'],
    ['panel', 'py-12'],
    ['page', 'py-16'],
    ['fill', 'h-full'],
  ])('holds %s room with %s', (space, className) => {
    expect(
      renderToStaticMarkup(<LoadingPlaceholder space={space} />),
    ).toContain(className);
  });

  it('sits in flow with no vertical room when inline', () => {
    const markup = renderToStaticMarkup(<LoadingPlaceholder space="inline" />);
    expect(markup).not.toMatch(/\bpy-/);
    expect(markup).not.toContain('h-full');
  });

  it('adds placement classes without dropping its room', () => {
    // A placement class used to replace the default padding outright.
    const markup = renderToStaticMarkup(
      <LoadingPlaceholder className="flex-1" />,
    );
    expect(markup).toContain('flex-1');
    expect(markup).toContain('py-12');
  });

  it('shows a secondary spinner when asked', () => {
    expect(renderToStaticMarkup(<LoadingPlaceholder showSpinner />)).toContain(
      'fg-secondary',
    );
    expect(renderToStaticMarkup(<LoadingPlaceholder />)).not.toContain(
      'aria-label="Loading"',
    );
  });

  describe('under the spinner loading style', () => {
    function inSpinnerStyle(element: JSX.Element): string {
      return renderToStaticMarkup(
        <LoadingIndicatorStyleProvider value="spinner">
          {element}
        </LoadingIndicatorStyleProvider>,
      );
    }

    it('centers a spinner with no text when there is no label', () => {
      const markup = inSpinnerStyle(<LoadingPlaceholder />);
      expect(markup).toContain('py-12');
      expect(markup).toContain('aria-label="Loading"');
      expect(markup).not.toContain('Loading…');
    });

    it('still shows a label that says what is loading', () => {
      const markup = inSpinnerStyle(
        <LoadingPlaceholder label="Loading plugins…" />,
      );
      expect(markup).toContain('Loading plugins…');
      expect(markup).not.toContain('aria-label="Loading"');
      expect(
        inSpinnerStyle(
          <LoadingPlaceholder label="Loading plugins…" showSpinner />,
        ),
      ).toContain('aria-label="Loading"');
    });
  });
});
