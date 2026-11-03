'use client';

import { createContext, useContext } from 'react';

/**
 * What a `DialogFormField` tells the controls inside it: the id of the
 * control its label names, and the ids that describe that control (its help
 * text). `null` outside a dialog form field.
 */
export interface DialogFormFieldDescription {
  readonly controlId: string | undefined;
  readonly describedBy: string | undefined;
}

export const DialogFormFieldContext =
  createContext<DialogFormFieldDescription | null>(null);

/**
 * The control's `aria-describedby` with its `DialogFormField`'s help text
 * added, so a dialog form never wires the help text by hand. Only the control
 * the field's label names (`id` equal to `htmlFor`) takes it; ids the caller
 * already lists stay first and are not repeated.
 */
export function useDialogFormFieldDescribedBy(
  id: string | undefined,
  describedBy: string | undefined,
): string | undefined {
  const field = useContext(DialogFormFieldContext);
  if (
    field?.describedBy === undefined ||
    id === undefined ||
    id !== field.controlId
  ) {
    return describedBy;
  }
  const ids = (describedBy ?? '').split(/\s+/).filter(Boolean);
  for (const added of field.describedBy.split(' ')) {
    if (!ids.includes(added)) ids.push(added);
  }
  return ids.join(' ');
}
