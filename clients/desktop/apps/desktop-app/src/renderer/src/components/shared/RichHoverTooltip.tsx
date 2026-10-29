// RichHoverTooltip now lives in `@canopy/ui-shared` so it can be reused by
// shared display components (e.g. WorktreeRow) as well as the desktop app.
// Re-exported here to keep existing `@/components/shared/RichHoverTooltip`
// import paths stable.
export {
  RichHoverTooltip,
  type TooltipTriggerProps,
} from '@canopy/ui-shared/components';
