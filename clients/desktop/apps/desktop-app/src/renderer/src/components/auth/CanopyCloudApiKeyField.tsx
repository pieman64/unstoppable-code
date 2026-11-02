import type { JSX, Ref } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { EyeIcon, EyeOffIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface CanopyCloudApiKeyFieldProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  visible: boolean;
  onToggleVisible: () => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Extra classes on the `<input>`, for surfaces that need more contrast. */
  inputClassName?: string;
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
  inputClassName = '',
}: CanopyCloudApiKeyFieldProps): JSX.Element {
  return (
    <div>
      <label className="block text-s">
        <span className="mb-1.5 block fg-secondary">API key</span>
        <div className="relative">
          <input
            ref={inputRef}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={onChange}
            disabled={disabled}
            placeholder="csk_xxxxxxxxxxxxxxxxxxxx"
            data-testid="settings-account-canopy-cloud-api-key-input"
            className={`focus-ring w-full rounded-lg border bg-base px-3 py-2 pr-10 text-s font-mono disabled:opacity-50 ${inputClassName}`}
          />
          <span className="absolute right-1 top-1/2 flex -translate-y-1/2">
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
          </span>
        </div>
      </label>
    </div>
  );
}
