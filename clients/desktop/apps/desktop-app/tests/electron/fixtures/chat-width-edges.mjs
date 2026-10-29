export const edgeCode =
  '+------+     +------+\n| In   | --> | Out  |\n+------+     +------+\n' +
  '    aligned_log_column '.repeat(18);
export const edgeMarkdown = [
  '## Width edge cases',
  '',
  '| ID | Name | Score |',
  '| --- | --- | --- |',
  '| 1 | Alex Morgan | 87 |',
  '| 2 | Jamie Chen | 94 |',
  '',
  '```text',
  edgeCode,
  '```',
  '',
  '$$',
  Array.from({ length: 24 }, (_, i) => `x_{${i}}`).join(' + ') +
    String.raw` = y \tag{1}`,
  '$$',
  '',
  '$$',
  String.raw`\begin{aligned} a &= b + c \\ d &= \frac{e}{f} \end{aligned}\tag{2}`,
  '$$',
].join('\n');
