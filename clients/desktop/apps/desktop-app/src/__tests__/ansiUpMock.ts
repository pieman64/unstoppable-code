export class AnsiUp {
  escape_html = false;

  ansi_to_html(value: string): string {
    return this.escape_html
      ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : value;
  }
}
