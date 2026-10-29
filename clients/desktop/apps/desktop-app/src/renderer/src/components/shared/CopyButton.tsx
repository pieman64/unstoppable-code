// Thin re-export over the shared display-only CopyButton. Desktop call
// sites import `CopyButton` from `../shared` and get the same component
// the web portal uses.
export { CopyButton, type CopyButtonProps } from '@canopy/ui-shared/components';
