export { getDesktopInstrumentationConfig } from './config';
export { createDesktopInstrumentationOperationKey } from './operation';
export {
  APP_ERROR_POSTHOG_EVENT,
  buildAppErrorPostHogProperties,
  buildAppErrorDatadogContext,
  buildAppErrorDatadogError,
} from './app-error-telemetry';
export type { AppErrorTelemetrySessions } from './app-error-telemetry';
export type { DesktopOperationName } from './operations';
export type {
  DesktopInstrumentationClientInitOptions,
  DesktopInstrumentationContext,
  DesktopInstrumentationContextValue,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFeatureFlagValue,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationInitResult,
  DesktopInstrumentationOperationOptions,
  DesktopInstrumentationPrivacyLevel,
  DesktopInstrumentationProvider,
  DesktopInstrumentationSurface,
} from './types';
