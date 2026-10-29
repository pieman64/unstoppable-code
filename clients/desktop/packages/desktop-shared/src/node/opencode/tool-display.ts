import { openCodeNativeOperations } from './tool-input';

export function openCodeToolDisplay(
  tool: { name: string; input: unknown; kind?: string },
  cwd: string,
): { name: string; input: unknown } {
  if (
    !tool.input ||
    typeof tool.input !== 'object' ||
    Array.isArray(tool.input)
  )
    return tool;
  const input: Record<string, unknown> = Object.fromEntries(
    Object.entries(tool.input),
  );
  const operation = openCodeNativeOperations(tool.name, input, cwd);
  if (
    operation?.length === 1 &&
    tool.name !== 'apply_patch' &&
    tool.name !== 'patch'
  )
    return { name: operation[0].tool, input: operation[0].input };
  if (tool.name === 'apply_patch' || tool.name === 'patch')
    return { name: 'apply_patch', input: input.patchText };
  if (tool.name === 'todowrite') return { name: 'TodoWrite', input };
  if (tool.name === 'skill')
    return { name: 'Skill', input: { skill: input.name } };
  return tool;
}
