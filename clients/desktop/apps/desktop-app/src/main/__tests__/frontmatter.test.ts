import { parseFrontmatterAndBody } from '../lib/frontmatter';

describe('parseFrontmatterAndBody', () => {
  it('splits leading YAML frontmatter from the markdown body', () => {
    const raw = '---\ntitle: Hello\ncount: 3\n---\n\n# Heading\n\nBody.';
    const { frontmatter, body } = parseFrontmatterAndBody(raw);
    expect(frontmatter).toEqual({ title: 'Hello', count: 3 });
    expect(body).toBe('\n# Heading\n\nBody.');
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
});
