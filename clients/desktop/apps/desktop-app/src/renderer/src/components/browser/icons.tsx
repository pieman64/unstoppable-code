import type { JSX } from 'react';
import {
  BackIcon as AppCatalogBackIcon,
  ForwardIcon as AppCatalogForwardIcon,
  RefreshIcon as AppCatalogRefreshIcon,
  ExternalIcon as AppCatalogExternalIcon,
  SunIcon as AppCatalogSunIcon,
  MoonIcon as AppCatalogMoonIcon,
  RecordIcon as AppCatalogRecordIcon,
  PickIcon as AppCatalogPickIcon,
  CameraIcon as AppCatalogCameraIcon,
  DetailsIcon as AppCatalogDetailsIcon,
  PlusIcon as AppCatalogPlusIcon,
  SplitIcon as AppCatalogSplitIcon,
  CircleStopIcon as AppCatalogCircleStopIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

interface IconProps {
  className?: string;
}

function svgProps(className?: string): {
  width: number;
  height: number;
  viewBox: string;
  fill: string;
  'aria-hidden': true;
  className?: string;
} {
  return {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
    ...(className ? { className } : {}),
  };
}

export function BackIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogBackIcon {...svgProps(className)} />;
}

export function ForwardIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogForwardIcon {...svgProps(className)} />;
}

export function RefreshIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogRefreshIcon {...svgProps(className)} />;
}

export function ExternalIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogExternalIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function SunIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogSunIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function MoonIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogMoonIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function RecordIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogRecordIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function PickIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogPickIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function CameraIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogCameraIcon {...svgProps(className)} />;
}

export function DetailsIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogDetailsIcon {...svgProps(className)} />;
}

export function PlusIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogPlusIcon {...svgProps(className)} />;
}

export function SplitIcon({ className }: IconProps): JSX.Element {
  return (
    <AppCatalogSplitIcon
      width="14"
      height="14"
      aria-hidden
      className={className}
    />
  );
}

export function StopIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogCircleStopIcon {...svgProps(className)} />;
}

export function CloseIcon({ className }: IconProps): JSX.Element {
  return <AppCatalogCloseIcon {...svgProps(className)} />;
}
