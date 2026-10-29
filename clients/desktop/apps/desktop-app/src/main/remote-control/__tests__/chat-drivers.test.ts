import { isTerminalReplyOnly } from '../host/chat-drivers';

describe('isTerminalReplyOnly', () => {
  it('recognizes replies an emulator sends by itself', () => {
    for (const reply of [
      '\u001b[12;40R',
      '\u001b[?1;2c',
      '\u001b[>0;276;0c',
      '\u001b[0n',
      '\u001b[?2026;2$y',
      '\u001b[20;1$y',
      '\u001b[8;24;80t',
      '\u001b[I',
      '\u001b[O',
      '\u001b]11;rgb:0000/0000/0000\u0007',
      '\u001b]10;rgb:ffff/ffff/ffff\u001b\\',
      '\u001bP1$r0m\u001b\\',
      '\u001b[I\u001b[12;40R',
    ]) {
      expect(isTerminalReplyOnly(reply)).toBe(true);
    }
  });

  it('treats typing, keys and pasted prompts as input', () => {
    for (const input of [
      'a',
      '\r',
      '\u001b[A',
      '\u001b[3~',
      '\u001b[1;5A',
      '$y',
      '\u001b[200~fix the bug\u001b[201~',
      '\u001b[12;40Rls\r',
      '',
    ]) {
      expect(isTerminalReplyOnly(input)).toBe(false);
    }
  });
});
