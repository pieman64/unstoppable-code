export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the DOM selection fallback below.
    }
  }

  return copyTextWithSelection(text);
}

function copyTextWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }

  const textArea = document.createElement('textarea');
  const previousActiveElement = document.activeElement;
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textArea.remove();
    if (previousActiveElement instanceof HTMLElement) {
      previousActiveElement.focus();
    }
  }
}
