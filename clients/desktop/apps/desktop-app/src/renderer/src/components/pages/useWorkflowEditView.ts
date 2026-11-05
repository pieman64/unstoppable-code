import { useRef, useState } from 'react';

/**
 * The assistant's share of an open pipeline's edit view, beside the editor.
 * It leads, but the editor beside it keeps room for the workflow's name and
 * flow. The rail between them resizes it.
 */
const EDIT_CHAT_PERCENT = 40;

export interface WorkflowEditViewState {
  /** A pipeline is open in the edit view. */
  readonly open: boolean;
  /** Whether a pipeline is open, for handlers that outlive a render. */
  readonly openRef: { readonly current: boolean };
  /** The assistant's share of the edit view. */
  readonly chatPercent: number;
  readonly setChatPercent: (percent: number) => void;
}

/**
 * An open pipeline, new or saved, always shows the assistant chat on the
 * left of the editor (CAN-4319), each in its own card under the page's bar.
 */
export function useWorkflowEditView(
  pipelineEditorOpen: boolean,
): WorkflowEditViewState {
  const [chatPercent, setChatPercent] = useState(EDIT_CHAT_PERCENT);
  const openRef = useRef(pipelineEditorOpen);
  openRef.current = pipelineEditorOpen;
  return {
    open: pipelineEditorOpen,
    openRef,
    chatPercent,
    setChatPercent,
  };
}
