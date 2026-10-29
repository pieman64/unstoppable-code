export interface WorkflowReceipt {
  taskId?: string;
  runId?: string;
  transcriptDir?: string;
  scriptFile?: string;
  summary?: string;
}

function grab(output: string, re: RegExp): string | undefined {
  const match = re.exec(output);
  return match ? match[1].trim() : undefined;
}

/**
 * True when `output` is the launch receipt the `Workflow` tool returns. Used to
 * distinguish the agent-SDK Workflow tool from the unrelated pipeline
 * "workflow" concept.
 */
export function isWorkflowLaunchReceipt(output: string): boolean {
  return (
    /Workflow launched in background\./.test(output) &&
    /Run ID:\s*wf_/.test(output)
  );
}

export function parseWorkflowReceipt(output: string): WorkflowReceipt {
  return {
    taskId: grab(output, /Task ID:\s*(\S+)/),
    runId: grab(output, /Run ID:\s*(\S+)/),
    transcriptDir: grab(output, /Transcript dir:\s*(\S+)/),
    scriptFile: grab(output, /Script file:\s*(\S+)/),
    summary: grab(output, /Summary:\s*(.+)/),
  };
}

/** Pull `name: '<x>'` from the first `meta` block of a Workflow script. */
export function extractWorkflowNameFromScript(
  script: string,
): string | undefined {
  return grab(script, /name:\s*['"]([^'"]+)['"]/);
}
