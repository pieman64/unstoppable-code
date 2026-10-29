import { prettifyToolName } from '../tool-display';

describe('prettifyToolName', () => {
  it('splits prefix.name on the dot and joins with " - "', () => {
    expect(prettifyToolName('chat.send_message')).toBe('Chat - Send Message');
    expect(prettifyToolName('pipeline.open_editor')).toBe(
      'Pipeline - Open Editor',
    );
  });

  it('capitalizes each word', () => {
    expect(prettifyToolName('navigation.go_to_page')).toBe(
      'Navigation - Go To Page',
    );
  });

  it('treats hyphens like underscores', () => {
    expect(prettifyToolName('foo-bar.baz-qux_one')).toBe(
      'Foo Bar - Baz Qux One',
    );
  });

  it('returns a single segment when there is no dot', () => {
    expect(prettifyToolName('tool_without_prefix')).toBe('Tool Without Prefix');
    expect(prettifyToolName('Simple')).toBe('Simple');
  });

  it('collapses runs of separators', () => {
    expect(prettifyToolName('foo__bar')).toBe('Foo Bar');
    expect(prettifyToolName('a.b__c-d')).toBe('A - B C D');
  });
});
