import { useLayoutEffect, useState, type JSX, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Portal the teaching outline above clipping composer rails without intercepting input. */
export function ComposerControlHighlight({
  target,
  testId,
}: {
  target: RefObject<HTMLElement | null>;
  testId: string;
}): JSX.Element | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const button = target.current;
    if (!button) return;
    const update = (): void => setRect(button.getBoundingClientRect());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(button);
    if (button.parentElement) observer.observe(button.parentElement);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return (): void => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [target]);
  if (!rect || !rect.width) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-testid={testId}
      className="pointer-events-none fixed z-spotlight rounded-full ring-2 ring-line-accent"
      style={{
        left: rect.left - 2,
        top: rect.top - 2,
        width: rect.width + 4,
        height: rect.height + 4,
      }}
    />,
    document.body,
  );
}

export function PlanModeHighlight({
  target,
}: {
  target: RefObject<HTMLButtonElement | null>;
}): JSX.Element | null {
  return (
    <ComposerControlHighlight
      target={target}
      testId="home-plan-mode-highlight"
    />
  );
}
