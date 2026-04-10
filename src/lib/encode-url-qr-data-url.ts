import QRCode from 'qrcode';

/** Lumii QR login often returns an https **page** URL; the UI must show a scannable matrix encoding that URL, not `<img src={pageUrl}>`. */
export function isProbablyDirectImageUrl(url: string): boolean {
    try {
        const p = new URL(url).pathname;
        return /\.(png|jpe?g|gif|webp|svg)$/i.test(p);
    } catch {
        return false;
    }
}

export async function encodeUrlAsQrDataUrl(link: string): Promise<string> {
    return QRCode.toDataURL(link.trim(), {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
    });
}
