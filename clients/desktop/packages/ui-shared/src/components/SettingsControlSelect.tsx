import { forwardRef, type JSX } from 'react';
import { ControlSelect, type ControlSelectProps } from './ControlSelect';

export type SettingsControlSelectProps = Omit<ControlSelectProps, 'shape'>;

/** The shared 28px capsule dropdown for desktop and web Settings. */
export const SettingsControlSelect = forwardRef<
  HTMLSelectElement,
  SettingsControlSelectProps
>(function SettingsControlSelect(props, ref): JSX.Element {
  return <ControlSelect {...props} ref={ref} shape="capsule" />;
});
