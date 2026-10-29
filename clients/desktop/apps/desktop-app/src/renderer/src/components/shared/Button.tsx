// Thin re-export over the shared action-button primitive. Desktop call sites
// can keep using the local shared-components path while desktop and web retain
// one geometry and variant contract.
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
} from '@canopy/ui-shared/components';
