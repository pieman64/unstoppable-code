import {
  getTerminalPresetImageMaxFileBytes,
  isTerminalPresetImageDataUrl,
  isTerminalPresetImageMimeType,
  TERMINAL_PRESET_IMAGE_ACCEPT,
  TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH,
} from '../terminal-preset-images';

describe('terminal preset images', () => {
  it('publishes the same MIME allowlist used by the file picker', () => {
    expect(TERMINAL_PRESET_IMAGE_ACCEPT).toBe(
      'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
    );
    expect(isTerminalPresetImageMimeType('image/svg+xml')).toBe(true);
    expect(isTerminalPresetImageMimeType('image/bmp')).toBe(false);
  });

  it('keeps the encoded data URL within the persisted length limit', () => {
    const mimeType = 'image/svg+xml';
    const maxBytes = getTerminalPresetImageMaxFileBytes(mimeType);
    const prefix = `data:${mimeType};base64,`;
    const atLimit = `${prefix}${Buffer.alloc(maxBytes).toString('base64')}`;
    const overLimit = `${prefix}${Buffer.alloc(maxBytes + 1).toString('base64')}`;

    expect(atLimit.length).toBeLessThanOrEqual(
      TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH,
    );
    expect(isTerminalPresetImageDataUrl(atLimit)).toBe(true);
    expect(overLimit.length).toBeGreaterThan(
      TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH,
    );
    expect(isTerminalPresetImageDataUrl(overLimit)).toBe(false);
  });

  it('rejects unsupported MIME types even when the payload is small', () => {
    expect(isTerminalPresetImageDataUrl('data:image/bmp;base64,YQ==')).toBe(
      false,
    );
  });
});
