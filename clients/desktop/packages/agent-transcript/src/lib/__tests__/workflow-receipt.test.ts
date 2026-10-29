import {
  parseWorkflowReceipt,
  isWorkflowLaunchReceipt,
  extractWorkflowNameFromScript,
} from '../workflow-receipt';

const RECEIPT = `Workflow launched in background. Task ID: whh8c9i0g
Summary: Audit how Canopy desktop interacts with git
Transcript dir: /home/u/.claude/projects/-p/sess/subagents/workflows/wf_48dd5689-0a8
Script file: /home/u/.claude/projects/-p/sess/workflows/scripts/git-ci-audit-wf_48dd5689-0a8.js
Run ID: wf_48dd5689-0a8
You will be notified when it completes. Use /workflows to watch live progress.`;

describe('workflow-receipt', () => {
  it('recognizes a workflow launch receipt', () => {
    expect(isWorkflowLaunchReceipt(RECEIPT)).toBe(true);
    expect(isWorkflowLaunchReceipt('some other tool output')).toBe(false);
  });

  it('parses task id, run id, transcript dir, script file, and summary', () => {
    const r = parseWorkflowReceipt(RECEIPT);
    expect(r.taskId).toBe('whh8c9i0g');
    expect(r.runId).toBe('wf_48dd5689-0a8');
    expect(r.transcriptDir).toBe(
      '/home/u/.claude/projects/-p/sess/subagents/workflows/wf_48dd5689-0a8',
    );
    expect(r.scriptFile).toBe(
      '/home/u/.claude/projects/-p/sess/workflows/scripts/git-ci-audit-wf_48dd5689-0a8.js',
    );
    expect(r.summary).toBe('Audit how Canopy desktop interacts with git');
  });

  it('extracts the workflow name from a script meta block', () => {
    const script = `export const meta = {\n  name: 'git-ci-audit',\n  description: 'Audit git',\n}`;
    expect(extractWorkflowNameFromScript(script)).toBe('git-ci-audit');
    expect(extractWorkflowNameFromScript('no meta here')).toBeUndefined();
  });
});
