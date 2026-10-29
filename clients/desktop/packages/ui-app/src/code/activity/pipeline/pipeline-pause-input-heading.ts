/**
 * Heading for paused pipeline input, shared by `PipelineRunPauseForm` and the
 * desktop `PauseInputPanel`.
 */
export function pipelinePauseInputHeading(checkpointCount: number): string {
  return checkpointCount === 1 ? 'Input required' : 'Inputs required';
}
