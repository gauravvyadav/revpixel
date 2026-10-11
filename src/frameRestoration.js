import { removeWatermark } from './reverseAlphaBlending.js';

// Shared "tune-it-yourself" helpers used by both the image and video tools.
// A removal is described by a base watermark box plus user tweaks:
//   { gain, offsetX, offsetY, sizeScale }
// Removal is always confined to the Gemini sparkle template shape, so only the
// logo pixels are ever altered — never the surrounding content.

export function getRoi(width, height, wm) {
    const pad = Math.round(wm.size * 0.6);
    const rx = Math.max(0, wm.x - pad);
    const ry = Math.max(0, wm.y - pad);
    const rw = Math.min(width - rx, wm.width + pad * 2);
    const rh = Math.min(height - ry, wm.height + pad * 2);
    return { x: rx, y: ry, width: rw, height: rh };
}

export function resolveBox(base, width, height, opts = {}) {
    const sizeScale = opts.sizeScale || 1;
    const size = Math.max(8, Math.min(Math.round(base.size * sizeScale), Math.min(width, height)));
    const x = Math.max(0, Math.min(base.x + Math.round(opts.offsetX || 0), width - size));
    const y = Math.max(0, Math.min(base.y + Math.round(opts.offsetY || 0), height - size));
    return { size, x, y, width: size, height: size };
}

/** Scaled Gemini sparkle alpha (template shape) placed inside the ROI, scaled by gain. */
export function buildAlpha(bgSource, roi, wm, gain) {
    const count = roi.width * roi.height;
    const alphaMap = new Float32Array(count);
    const offX = wm.x - roi.x;
    const offY = wm.y - roi.y;

    // Pick optimal source image (bg48 for <= 48, bg96 for > 48)
    const img = (bgSource && bgSource.bg48 && wm.size <= 48)
        ? bgSource.bg48
        : (bgSource?.bg96 || bgSource);

    const c = document.createElement('canvas');
    c.width = wm.size;
    c.height = wm.size;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, wm.size, wm.size);
    const data = cx.getImageData(0, 0, wm.size, wm.size).data;

    for (let row = 0; row < wm.size; row++) {
        for (let col = 0; col < wm.size; col++) {
            const ri = (offY + row) * roi.width + (offX + col);
            if (ri < 0 || ri >= count) continue;
            const o = (row * wm.size + col) * 4;
            const a = (Math.max(data[o], data[o + 1], data[o + 2]) / 255) * gain;
            alphaMap[ri] = a > 0 ? Math.min(a, 0.99) : 0;
        }
    }
    return alphaMap;
}

/** Clean a full-frame ImageData in place. Returns the resolved box + ROI for UI guides. */
export function cleanFrame(bgSource, imageData, width, height, base, opts = {}) {
    const wm = resolveBox(base, width, height, opts);
    const roi = getRoi(width, height, wm);
    const alpha = buildAlpha(bgSource, roi, wm, opts.gain ?? base.gain ?? 0.6);
    removeWatermark(imageData, alpha, {
        x: roi.x,
        y: roi.y,
        width: roi.width,
        height: roi.height,
    });
    return { wm, roi };
}
