import { type JSX, useState, useEffect } from 'react';
import { Button, TextArea, TextInput } from '@canopy/ui-shared/components';
import { DialogModal } from '../../shared/DialogModal';
import type { PipelineScalar } from '@canopy/desktop-shared/types/pipeline';

type ValueType = 'string' | 'number' | 'boolean';

interface EnlargeValueModalProps {
  inputKey: string;
  value: PipelineScalar;
  valueType: ValueType;
  onSave: (value: PipelineScalar) => void;
  onClose: () => void;
}

export function EnlargeValueModal({
  inputKey,
  value,
  valueType,
  onSave,
  onClose,
}: EnlargeValueModalProps): JSX.Element {
  const [localValue, setLocalValue] = useState<string>(String(value));
  const [boolValue, setBoolValue] = useState<boolean>(
    typeof value === 'boolean' ? value : false,
  );

  useEffect((): void => {
    setLocalValue(String(value));
    if (typeof value === 'boolean') {
      setBoolValue(value);
    }
  }, [value]);

  function handleSave(): void {
    if (valueType === 'boolean') {
      onSave(boolValue);
    } else if (valueType === 'number') {
      const num = Number(localValue);
      onSave(Number.isNaN(num) ? localValue : num);
    } else {
      onSave(localValue);
    }
    onClose();
  }

  return (
    <DialogModal
      onClose={onClose}
      title={inputKey}
      subtitle="Edit input value"
      maxWidth="2xl"
    >
      <div className="flex flex-col gap-4">
        {valueType === 'boolean' ? (
          <button
            type="button"
            onClick={(): void => setBoolValue(!boolValue)}
            className={`w-full px-4 py-3 text-s rounded-md border transition-colors text-left ${
              boolValue
                ? 'bg-accent-subtle border-line-accent fg-accent'
                : 'bg-base fg-secondary'
            }`}
          >
            {boolValue ? 'true' : 'false'}
          </button>
        ) : valueType === 'number' ? (
          <TextInput
            type="number"
            mono
            aria-label={inputKey}
            value={localValue}
            onChange={(e): void => setLocalValue(e.target.value)}
            autoFocus
          />
        ) : (
          <TextArea
            mono
            aria-label={inputKey}
            value={localValue}
            onChange={(e): void => setLocalValue(e.target.value)}
            autoFocus
            rows={12}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="compact" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
