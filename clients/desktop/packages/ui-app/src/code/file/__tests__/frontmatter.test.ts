import { parseFrontmatterAndBody } from '../frontmatter';

describe('parseFrontmatterAndBody', () => {
  it('returns the whole input as body when there is no frontmatter', () => {
    const raw = '# Title\n\nBody text.';
    expect(parseFrontmatterAndBody(raw)).toEqual({
      frontmatter: {},
      body: raw,
    });
  });

  it('splits leading YAML frontmatter from the markdown body', () => {
    const raw = '---\ntitle: Hello\ncount: 3\n---\n\n# Heading\n\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({ title: 'Hello', count: 3 });
    // Only the single newline directly after the closing fence is stripped, so
    // the blank line that followed it remains at the start of the body.
    expect(body).toBe('\n# Heading\n\nBody.');
  });

  it('handles CRLF line endings in the frontmatter fence', () => {
    const raw = '---\r\ntitle: Hi\r\n---\r\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({ title: 'Hi' });
    expect(body).toBe('Body.');
  });

  it('treats the entire input as body when the YAML is malformed', () => {
    const raw = '---\n: : : not valid\n  bad\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({});
    // The fence is still consumed; only parsing falls back to empty frontmatter.
    expect(body).toBe('Body.');
  });

  it('returns empty frontmatter for an empty frontmatter block', () => {
    const raw = '---\n\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Body.');
  });

  it('returns empty frontmatter when YAML parses to a scalar', () => {
    const raw = '---\njust a scalar\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Body.');
  });

  it('returns empty frontmatter when YAML parses to an array', () => {
    const raw = '---\n- first\n- second\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Body.');
  });

  it('drops cyclic YAML aliases from parsed frontmatter', () => {
    const raw = '---\ntitle: Safe\na: &a { b: *a }\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);

    expect(frontmatter).toEqual({ title: 'Safe', a: {} });
    expect(() => JSON.stringify(frontmatter)).not.toThrow();
    expect(body).toBe('Body.');
  });

  it('preserves shared non-cyclic YAML aliases in parsed frontmatter', () => {
    const raw =
      '---\ndefaults: &defaults { color: blue }\nprimary: *defaults\nsecondary: *defaults\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);

    expect(frontmatter).toEqual({
      defaults: { color: 'blue' },
      primary: { color: 'blue' },
      secondary: { color: 'blue' },
    });
    expect(body).toBe('Body.');
  });

  it('drops prototype-sensitive keys from parsed frontmatter', () => {
    const raw =
      '---\n__proto__:\n  name: Polluted\nconstructor:\n  description: Unsafe\nprototype:\n  title: Unsafe\nsafe: value\n---\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);

    expect(frontmatter).toEqual({ safe: 'value' });
    expect('name' in frontmatter).toBe(false);
    expect('description' in frontmatter).toBe(false);
    expect('title' in frontmatter).toBe(false);
    expect(body).toBe('Body.');
  });

  it('bounds hostile alias fan-out to a linear traversal and output budget', () => {
    const lines = ['l0: &l0 [x, x, x, x, x, x, x, x]'];
    for (let level = 1; level <= 7; level += 1) {
      const ref = `*l${level - 1}`;
      lines.push(
        `l${level}: &l${level} [${Array.from({ length: 8 }, () => ref).join(', ')}]`,
      );
    }
    const raw = `---\n${lines.join('\n')}\n---\nBody.`;

    const started = Date.now();
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(JSON.stringify(frontmatter).length).toBeLessThan(500_000);
    expect(body).toBe('Body.');
  });

  it('strips a valid empty frontmatter block', () => {
    const { frontmatter, body } = parseFrontmatterAndBody('---\n---\n# Body\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Body\n');
  });

  it('strips an empty CRLF frontmatter block', () => {
    const { frontmatter, body } = parseFrontmatterAndBody(
      '---\r\n---\r\n# Body',
    );
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Body');
  });

  it('leaves the document intact when the closing fence shares its line', () => {
    const raw = '---\nname: x\n---title\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('bounds null alias amplification in hostile frontmatter', () => {
    const anchored = `big: &big [${Array.from({ length: 1_000 }, () => '~').join(', ')}]`;
    const aliases = Array.from(
      { length: 5_000 },
      (_, index) => `a${String(index)}: *big`,
    );
    const raw = `---\n${anchored}\n${aliases.join('\n')}\n---\nBody.`;

    const started = Date.now();
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(JSON.stringify(frontmatter).length).toBeLessThan(500_000);
    expect(body).toBe('Body.');
  });

  it('bounds scalar alias amplification in hostile frontmatter', () => {
    const anchored = `big: &big [${Array.from(
      { length: 1_000 },
      (_, index) => `'${'v'.repeat(8)}${String(index)}'`,
    ).join(', ')}]`;
    const aliases = Array.from(
      { length: 5_000 },
      (_, index) => `a${String(index)}: *big`,
    );
    const raw = `---\n${anchored}\n${aliases.join('\n')}\n---\nBody.`;

    const started = Date.now();
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(JSON.stringify(frontmatter).length).toBeLessThan(500_000);
    expect(body).toBe('Body.');
  });
});
