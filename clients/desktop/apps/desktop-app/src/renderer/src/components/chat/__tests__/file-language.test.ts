import { getMonacoLanguage } from '../file-language';

describe('getMonacoLanguage', () => {
  it('maps TypeScript and JSX extensions to typescript', () => {
    expect(getMonacoLanguage('foo.ts')).toBe('typescript');
    expect(getMonacoLanguage('foo.tsx')).toBe('typescript');
  });

  it('maps JS / mjs / cjs / jsx to javascript', () => {
    expect(getMonacoLanguage('foo.js')).toBe('javascript');
    expect(getMonacoLanguage('foo.mjs')).toBe('javascript');
    expect(getMonacoLanguage('foo.cjs')).toBe('javascript');
    expect(getMonacoLanguage('foo.jsx')).toBe('javascript');
  });

  it('handles JSON, CSS, SCSS, LESS', () => {
    expect(getMonacoLanguage('a.json')).toBe('json');
    expect(getMonacoLanguage('a.css')).toBe('css');
    expect(getMonacoLanguage('a.scss')).toBe('scss');
    expect(getMonacoLanguage('a.less')).toBe('less');
  });

  it('handles HTML and Markdown', () => {
    expect(getMonacoLanguage('a.html')).toBe('html');
    expect(getMonacoLanguage('a.htm')).toBe('html');
    expect(getMonacoLanguage('a.md')).toBe('markdown');
    expect(getMonacoLanguage('a.mdx')).toBe('mdx');
  });

  it('maps LaTeX, BibTeX, and Lean extensions to their Monaco languages', () => {
    expect(getMonacoLanguage('paper.tex')).toBe('latex');
    expect(getMonacoLanguage('style.sty')).toBe('latex');
    expect(getMonacoLanguage('class.cls')).toBe('latex');
    expect(getMonacoLanguage('legacy.ltx')).toBe('latex');
    expect(getMonacoLanguage('references.bbl')).toBe('latex');
    expect(getMonacoLanguage('references.bib')).toBe('bibtex');
    expect(getMonacoLanguage('Main.lean')).toBe('lean');
  });

  it('prefers math language mappings over extension hints', () => {
    expect(getMonacoLanguage('paper.tex', 'tex')).toBe('latex');
    expect(getMonacoLanguage('references.bib', 'bib')).toBe('bibtex');
    expect(getMonacoLanguage('Main.lean', 'lean')).toBe('lean');
  });

  it('handles assorted server / scripting languages', () => {
    expect(getMonacoLanguage('a.yaml')).toBe('yaml');
    expect(getMonacoLanguage('a.yml')).toBe('yaml');
    expect(getMonacoLanguage('a.py')).toBe('python');
    expect(getMonacoLanguage('a.sh')).toBe('shell');
    expect(getMonacoLanguage('a.bash')).toBe('shell');
    expect(getMonacoLanguage('a.zsh')).toBe('shell');
    expect(getMonacoLanguage('a.go')).toBe('go');
    expect(getMonacoLanguage('a.rs')).toBe('rust');
    expect(getMonacoLanguage('a.java')).toBe('java');
    expect(getMonacoLanguage('a.c')).toBe('c');
    expect(getMonacoLanguage('a.h')).toBe('c');
    expect(getMonacoLanguage('a.cpp')).toBe('cpp');
    expect(getMonacoLanguage('a.cc')).toBe('cpp');
    expect(getMonacoLanguage('a.cxx')).toBe('cpp');
    expect(getMonacoLanguage('a.hpp')).toBe('cpp');
    expect(getMonacoLanguage('a.cs')).toBe('csharp');
    expect(getMonacoLanguage('a.php')).toBe('php');
    expect(getMonacoLanguage('a.rb')).toBe('ruby');
    expect(getMonacoLanguage('a.swift')).toBe('swift');
    expect(getMonacoLanguage('a.kt')).toBe('kotlin');
    expect(getMonacoLanguage('a.kts')).toBe('kotlin');
    expect(getMonacoLanguage('a.sql')).toBe('sql');
    expect(getMonacoLanguage('a.xml')).toBe('xml');
  });

  it('treats config-like extensions as plaintext', () => {
    expect(getMonacoLanguage('a.toml')).toBe('plaintext');
    expect(getMonacoLanguage('a.env')).toBe('plaintext');
    expect(getMonacoLanguage('a.txt')).toBe('plaintext');
    expect(getMonacoLanguage('a.log')).toBe('plaintext');
  });

  it('preserves extension hints that are already Monaco language ids', () => {
    expect(getMonacoLanguage('query.graphql', 'graphql')).toBe('graphql');
    expect(getMonacoLanguage('script.lua', 'lua')).toBe('lua');
    expect(getMonacoLanguage('analysis.r', 'r')).toBe('r');
    expect(getMonacoLanguage('settings.ini', 'ini')).toBe('ini');
  });

  it('prefers canonical aliases over extension hints', () => {
    expect(getMonacoLanguage('component.tsx', 'tsx')).toBe('typescript');
    expect(getMonacoLanguage('script.jsx', 'jsx')).toBe('javascript');
  });

  it('handles well-known extensionless files', () => {
    expect(getMonacoLanguage('Dockerfile')).toBe('plaintext');
    expect(getMonacoLanguage('Dockerfile.dev')).toBe('plaintext');
    expect(getMonacoLanguage('Makefile')).toBe('plaintext');
    expect(getMonacoLanguage('.gitignore')).toBe('plaintext');
  });

  it('strips directory components when given a path', () => {
    expect(getMonacoLanguage('/repo/src/index.ts')).toBe('typescript');
    expect(getMonacoLanguage('a/b/c\\Dockerfile')).toBe('plaintext');
  });

  it('returns plaintext for unknown extensions and empty inputs', () => {
    expect(getMonacoLanguage('a.unknownext')).toBe('plaintext');
    expect(getMonacoLanguage('a')).toBe('plaintext');
    expect(getMonacoLanguage('')).toBe('plaintext');
  });

  it('is case-insensitive', () => {
    expect(getMonacoLanguage('FOO.TS')).toBe('typescript');
    expect(getMonacoLanguage('FILE.MD')).toBe('markdown');
    expect(getMonacoLanguage('PAPER.TEX')).toBe('latex');
    expect(getMonacoLanguage('STYLE.STY')).toBe('latex');
    expect(getMonacoLanguage('CLASS.CLS')).toBe('latex');
    expect(getMonacoLanguage('LEGACY.LTX')).toBe('latex');
    expect(getMonacoLanguage('REFERENCES.BBL')).toBe('latex');
    expect(getMonacoLanguage('REFERENCES.BIB')).toBe('bibtex');
    expect(getMonacoLanguage('MAIN.LEAN')).toBe('lean');
  });

  it('maps math extensions when paths include directories', () => {
    expect(getMonacoLanguage('/repo/papers/paper.tex')).toBe('latex');
    expect(getMonacoLanguage('refs\\references.bib')).toBe('bibtex');
    expect(getMonacoLanguage('/repo/src/Main.lean')).toBe('lean');
  });
});
