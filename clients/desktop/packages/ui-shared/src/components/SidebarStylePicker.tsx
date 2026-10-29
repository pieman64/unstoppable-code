import type { JSX } from 'react';
import { AppearanceSelect } from './AppearanceSelect';

export type SidebarStyle = 'advanced' | 'compact';
export interface SidebarStylePickerProps {
  readonly value: SidebarStyle;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onChange: (value: SidebarStyle) => void;
}
const OPTIONS: readonly {
  value: SidebarStyle;
  label: string;
}[] = [
  {
    value: 'advanced',
    label: 'Advanced',
  },
  {
    value: 'compact',
    label: 'Compact',
  },
];
/** Pure display: hosts own persistence and map their saved choice to a style. */
export function SidebarStylePicker({
  value,
  disabled = false,
  busy = false,
  onChange,
}: SidebarStylePickerProps): JSX.Element {
  return (
    <AppearanceSelect
      label="Sidebar style"
      value={value}
      disabled={disabled}
      busy={busy}
      onChange={onChange}
      testId="sidebar-style-picker"
      options={OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        testId: `sidebar-style-${option.value}`,
      }))}
    />
  );
}
