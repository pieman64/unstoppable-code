import type { JSX, Ref } from 'react';
import {
  Button,
  FormField,
  TextInput,
  type TextInputDensity,
} from '@canopy/ui-shared/components';
import { EyeIcon, EyeOffIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface CanopyCloudApiKeyFieldProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  visible: boolean;
  onToggleVisible: () => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** `settings` (28px) in a Settings row; `default` (36px) elsewhere. */
  density?: Exclude<TextInputDensity, 'compact'>;
}

/**
 * The masked Canopy Cloud API-key input with its show/hide toggle. Shared by
 * the Settings → Accounts row and the modal/splash auth panel so the testid,
 * the toggle's dynamic accessible name, and the field geometry have one home.
 */
export function CanopyCloudApiKeyField({
  value,
  onChange,
  visible,
  onToggleVisible,
  disabled = false,
  inputRef,
  density = 'default',
}: CanopyCloudApiKeyFieldProps): JSX.Element {
  return (
    <FormField label="API key">
      {(control) => (
        <TextInput
          {...control}
          ref={inputRef}
          density={density}
          type={visible ? 'text' : 'password'}
          mono
          value={value}
          onChange={onChange}
          disabled={disabled}
          placeholder="csk_xxxxxxxxxxxxxxxxxxxx"
          data-testid="settings-account-canopy-cloud-api-key-input"
          trailing={
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              data-settings-control="field"
              onClick={onToggleVisible}
              aria-label={visible ? 'Hide API key' : 'Show API key'}
            >
              {visible ? (
                <EyeOffIcon size={16} aria-hidden />
              ) : (
                <EyeIcon size={16} aria-hidden />
              )}
            </Button>
          }
        />
      )}
    </FormField>
  );
}
