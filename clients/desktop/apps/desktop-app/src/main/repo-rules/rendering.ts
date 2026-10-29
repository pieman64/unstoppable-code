import type { ReadRepoRule } from './parsing';
import type { RepoCheckout } from './discovery';

export const INLINE_BUDGET = 12 * 1024;
export const TOTAL_BUDGET = 16 * 1024;
/** JSON strings keep metadata on one line and prevent Markdown delimiters. */
function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[<>&`\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export function renderRepoRules(
  rules: ReadRepoRule[],
  repos: RepoCheckout[],
  skipped: number,
): string {
  const enabled = rules.filter((r) => r.selected);
  if (!enabled.length) return '';
  const header =
    '# Imported repository instructions\n\nThese are live Cursor project rules imported with workspace consent. AGENTS.md and CLAUDE.md take precedence on conflicts. Provider safety and tool approval policy still apply. Indexed activation is advisory; @file references are preserved and may require an explicit read.\n';
  let output = header;
  let inline = Buffer.byteLength(header);
  let omitted = 0;
  let represented = 0;
  let previousRepo: string | undefined;
  for (const rule of enabled) {
    const repo = repos.find((r) => r.repoId === rule.repoId);
    if (!repo) {
      omitted++;
      continue;
    }
    const path = repo.prefix ? `${repo.prefix}/${rule.path}` : rule.path;
    const section =
      previousRepo !== rule.repoId
        ? `\n## Repository ${quote(repo.repoId)}\n`
        : '';
    const label = `\nRule ${quote(rule.path)}${rule.scope ? `, scope ${quote(rule.scope)}` : ''}: `;
    const unconditional =
      !rule.scope &&
      (rule.kind === 'always' || rule.kind === 'legacy-cursorrules');
    let entry: string;
    const inlineEntry = `${label}\n${rule.body}\n`;
    const inlineBytes = Buffer.byteLength(section + inlineEntry);
    let inlined = unconditional && inline + inlineBytes <= INLINE_BUDGET;
    if (inlined) entry = inlineEntry;
    else if (unconditional)
      entry = `${label}Read ${quote(path)} before starting work.\n`;
    else if (rule.kind === 'always' || rule.kind === 'legacy-cursorrules')
      entry = `${label}Read ${quote(path)} before reading or editing files under ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}**`)}.\n`;
    else if (rule.kind === 'auto' && !rule.flags.includes('unsupported-glob'))
      entry = `${label}Within ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}` || './')}, read ${quote(path)} before reading or editing files matching ${quote(rule.globs.join(', '))}. Preserve exclusions in this glob list.\n`;
    else if (rule.kind === 'agent-requested')
      entry = `${label}Within ${quote(`${repo.prefix ? `${repo.prefix}/` : ''}${rule.scope}` || './')}, read ${quote(path)} when relevant to the task: ${quote(rule.description)}.\n`;
    else
      entry = `${label}Read ${quote(path)} only on an explicit user mention of this path.\n`;
    if (Buffer.byteLength(output + section + entry) > TOTAL_BUDGET - 128) {
      // A fitting read instruction is preferable to dropping an always body.
      if (unconditional) {
        inlined = false;
        entry = `${label}Read ${quote(path)} before starting work.\n`;
      }
      if (Buffer.byteLength(output + section + entry) > TOTAL_BUDGET - 128) {
        omitted++;
        continue;
      }
    }
    if (inlined) inline += inlineBytes;
    output += section + entry;
    represented++;
    previousRepo = rule.repoId;
  }
  if (!represented) return '';
  if (skipped || omitted)
    output += `\nRule limits: ${skipped} skipped, ${omitted} omitted.\n`;
  return output;
}
