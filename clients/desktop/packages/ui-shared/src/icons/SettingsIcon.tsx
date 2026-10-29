import type { JSX } from 'react';
import { SettingsIcon as AppCatalogSettingsIcon } from './AppIcons';

interface SettingsIconProps {
  className?: string;
  width?: number;
  height?: number;
}

export function SettingsIcon({
  className,
  width = 16,
  height = 16,
}: SettingsIconProps): JSX.Element {
  return (
    <AppCatalogSettingsIcon
      width={width}
      height={height}
      aria-hidden="true"
      className={className}
    />
  );
}
