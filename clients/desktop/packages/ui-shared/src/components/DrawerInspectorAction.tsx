import { forwardRef, type ButtonHTMLAttributes, type JSX } from 'react';
import { Button } from './Button';

export interface DrawerInspectorActionProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style'
> {
  /** Align the label with the inspector's text or its trailing time column. */
  alignment?: 'leading' | 'trailing';
}

/** The drawer's single footer action treatment, including watcher management. */
export const DrawerInspectorAction = forwardRef<
  HTMLButtonElement,
  DrawerInspectorActionProps
>(function DrawerInspectorAction(
  { alignment = 'trailing', ...props },
  ref,
): JSX.Element {
  return (
    <Button
      {...props}
      ref={ref}
      variant="ghost-overlay"
      size="sm"
      className={alignment === 'trailing' ? '-mr-2.5' : '-ml-2.5'}
    />
  );
});
