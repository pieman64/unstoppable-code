/* eslint-disable react-refresh/only-export-components */
/**
 * Re-export of the shared tool-display helpers so existing desktop call
 * sites keep working. The shared module owns the icon + rich-label
 * dispatch for both Canopy surfaces; new code should import directly from
 * `@canopy/ui-shared/components`.
 */
export {
  getToolDisplayInfo,
  getSendMessageDisplayInfo,
  getToolFamilyFromName,
  isAppActionToolName,
  isCodeGraphToolName,
  type ToolDisplayInfo,
  type ToolDisplayScope,
} from '@canopy/ui-shared/components';
