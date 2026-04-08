import { describe, expect, it } from 'vitest';
import { encodeUrlAsQrDataUrl, isProbablyDirectImageUrl } from '@/lib/encode-url-qr-data-url';

describe('encode-url-qr-data-url', () => {
  it('flags image-like paths as direct image URLs', () => {
    expect(isProbablyDirectImageUrl('https://cdn.example.com/a/b/qr.png')).toBe(true);
    expect(isProbablyDirectImageUrl('https://x.com/page')).toBe(false);
  });

  it('produces a PNG data URL for a link', async () => {
    const dataUrl = await encodeUrlAsQrDataUrl('https://example.com/login?x=1');
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
