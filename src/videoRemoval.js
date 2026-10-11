// Video-only watermark removal pipeline.
// Everything here is self-contained so the shared image pipeline
// (frameRestoration.js / reverseAlphaBlending.js / imageRestorationEngine.js)
// is never touched by video work. Detection reuses the read-only pure
// functions from watermarkGeometry.js.
import { detectWatermarkInImageData, WATERMARK_CANDIDATES, getDefaultWatermarkInfo } from './watermarkGeometry.js';

const ALPHA_THRESHOLD = 0.002;     // ignore very small alpha values to prevent division instability
const MAX_ALPHA = 0.99;            // avoid division by near-zero values
const LOGO_VALUE = 255;            // sparkle is treated as a white logo

// ── Box geometry ──

/** Apply user nudge offsets / sizeScale to a detected base box. */
export function resolveVideoBox(base, width, height, opts = {}) {
    const sizeScale = opts.sizeScale || 1;
    const size = Math.max(8, Math.min(Math.round(base.size * sizeScale), Math.min(width, height)));
    const x = Math.max(0, Math.min(base.x + Math.round(opts.offsetX || 0), width - size));
    const y = Math.max(0, Math.min(base.y + Math.round(opts.offsetY || 0), height - size));
    return { size, x, y, width: size, height: size };
}

/** Default Veo watermark box (bottom-right): size ≈ shortSide/15, margin ≈ shortSide/10. */
export function getVeoWatermark(width, height) {
    const base = Math.min(width, height);
    const size = Math.max(24, Math.min(Math.round(base / 15), base));
    const margin = Math.round(base / 10);
    return {
        size,
        x: Math.max(0, width - margin - size),
        y: Math.max(0, height - margin - size),
        width: size,
        height: size,
    };
}

/**
 * A detected base can land outside the processing frame when the detection was
 * captured from a rotated <video> surface but the codec reports un-rotated
 * dimensions. Remap proportionally so the box always sits inside the frame.
 */
export function fitBoxToFrame(base, width, height) {
    const detW = base.x + base.size;
    const detH = base.y + base.size;
    if (detW <= width && detH <= height && base.x >= 0 && base.y >= 0) return base;
    const scaleX = detW > 0 ? width / Math.max(width, detW) : 1;
    const scaleY = detH > 0 ? height / Math.max(height, detH) : 1;
    const scale = Math.min(scaleX, scaleY);
    const s = Math.max(8, Math.round(base.size * scale));
    return {
        ...base,
        x: Math.max(0, Math.min(Math.round(base.x * scale), width - s)),
        y: Math.max(0, Math.min(Math.round(base.y * scale), height - s)),
        size: s,
        width: s,
        height: s,
    };
}

// ── Detection (single frame + multi-frame consensus) ──

/**
 * Auto-detect the sparkle anywhere on a single frame (reuses the exact same
 * whole-image detector as the image engine, which is left untouched). Returns
 * null when no confident match exists (no geometric fallback here, so the
 * caller can fall back to its own geometry).
 */
export function propose(imageData, alpha48, alpha96) {
    try {
        const result = detectWatermarkInImageData(imageData, alpha48, alpha96);
        if (result && result.score && result.score >= 0.34) return result;
        return null;
    } catch {
        return null;
    }
}

/**
 * The watermark is fixed across the video but individual frames can fool the
 * detector (bright textures, faint sparkle in dark scenes). Detect on several
 * sampled frames, then arbitrate every plausible geometry by residual score so
 * the strongest watermark signature always wins.
 */
export function consensusDetect(samples, alpha48, alpha96, fallbackWidth, fallbackHeight, resolveAlpha) {
    if (!samples || !samples.length) return getVeoWatermark(fallbackWidth, fallbackHeight);

    const proposed = samples.map((s, i) => {
        try {
            return propose(s.imageData, alpha48, alpha96);
        } catch {
            return null;
        }
    });

    const clusters = [];
    for (const p of proposed) {
        if (!p || !p.score || p.score < 0.34) continue;
        const win = clusters.find(
            (c) =>
                Math.abs(c.x - p.x) < Math.max(8, c.size * 0.4) &&
                Math.abs(c.y - p.y) < Math.max(8, c.size * 0.4) &&
                Math.abs(c.size - p.size) < Math.max(8, c.size * 0.4)
        );
        if (win) {
            win.count++;
            if (p.score > win.score) {
                win.x = p.x;
                win.y = p.y;
                win.size = p.size;
                win.score = p.score;
            }
        } else {
            clusters.push({ ...p, count: 1 });
        }
    }

    clusters.sort((a, b) => b.count - a.count || b.score - a.score);
    const best = clusters[0];
    if (best && (best.count >= 2 || best.score >= 0.55)) {
        return best;
    }

    return pickBestBox(samples, best, alpha48, alpha96, fallbackWidth, fallbackHeight, resolveAlpha);
}

function candidateBoxes(best, width, height) {
    const list = [];
    if (best && best.count >= 1) list.push(best);

    for (const cand of WATERMARK_CANDIDATES) {
        if (cand.size > width || cand.size > height) continue;
        list.push({
            id: cand.id,
            size: cand.size,
            x: Math.max(0, width - cand.marginX - cand.size),
            y: Math.max(0, height - cand.marginY - cand.size),
            width: cand.size,
            height: cand.size,
            gain: cand.defaultGain,
            templateKey: cand.templateKey,
        });
    }

    const def = getDefaultWatermarkInfo(width, height);
    list.push({
        id: def.id,
        size: def.size,
        x: def.x,
        y: def.y,
        width: def.size,
        height: def.size,
        gain: def.gain,
        templateKey: def.templateKey,
    });

    const veo = getVeoWatermark(width, height);
    list.push({ ...veo, id: 'veo', gain: 0.65 });
    list.push({ ...veo, id: 'veo-inset', x: Math.max(0, veo.x - 24), y: Math.max(0, veo.y - 24), gain: 0.65 });
    return list;
}

function meanResidual(samples, box, alphaMap) {
    if (!samples.length || !alphaMap || alphaMap.length !== box.size * box.size) return -Infinity;
    let sum = 0;
    for (const s of samples) {
        if (box.x < 0 || box.y < 0 || box.x + box.size > s.width || box.y + box.size > s.height) {
            return -Infinity;
        }
        sum += Math.max(0, residualScore(s.imageData, alphaMap, box).spatial);
    }
    return sum / samples.length;
}

/**
 * Choose the geometry whose watermark signature is strongest across the
 * sampled frames, using the same residual (NCC) metric that the removal pass
 * relies on. This guarantees the returned box is the one removal will actually
 * act on, instead of silently ending up off-target.
 */
export function pickBestBox(samples, best, alpha48, alpha96, fallbackWidth, fallbackHeight, resolveAlpha) {
    const width = samples[0]?.width ?? fallbackWidth;
    const height = samples[0]?.height ?? fallbackHeight;
    const resolve =
        resolveAlpha ||
        ((size) => {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return null;
        });

    let bestBox = null;
    let bestScore = -Infinity;
    for (const box of candidateBoxes(best, width, height)) {
        const templateKey = box.templateKey ?? (box.size === 48 ? 48 : box.size === 96 ? 96 : null);
        const alpha = templateKey === 48 ? alpha48 : templateKey === 96 ? alpha96 : resolve(box.size);
        const score = meanResidual(samples, box, alpha);
        if (score > bestScore) {
            bestScore = score;
            bestBox = { ...box, score: Number.isFinite(box.score) ? box.score : bestScore };
        }
    }

    if (bestBox) return bestBox;
    if (best) return best;
    return getVeoWatermark(width, height);
}

// ── Removal (reverse alpha blending, with residual-aware gain calibration) ──

/**
 * Remove a watermark layer using reverse alpha blending, in place.
 * Gemini composites: watermarked = α·logo + (1−α)·original
 * Reverse solve:      original = (watermarked − α·logo) / (1−α)
 */
export function removeWatermark(imageData, alphaMap, position, options = {}) {
    const { x, y, width, height } = position;
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 1;

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const imgIdx = ((y + row) * imageData.width + (x + col)) * 4;
            const alphaIdx = row * width + col;

            const rawAlpha = alphaMap[alphaIdx];
            let alpha = Math.abs(rawAlpha) * alphaGain;
            if (alpha < ALPHA_THRESHOLD) continue;
            alpha = Math.min(alpha, MAX_ALPHA);

            const logoValue = Number.isFinite(options.logoValue) ? options.logoValue : LOGO_VALUE;
            const oneMinusAlpha = 1.0 - alpha;

            for (let c = 0; c < 3; c++) {
                const watermarked = imageData.data[imgIdx + c];
                const original = (watermarked - alpha * logoValue) / oneMinusAlpha;
                imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
            }
        }
    }
}

// ── Residual metrics ──

function regionGrayscale(imageData, position) {
    const { x, y, width, height } = position;
    const out = new Float32Array(width * height);
    const data = imageData.data;
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = ((y + row) * imageData.width + (x + col)) * 4;
            out[row * width + col] =
                0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
        }
    }
    return out;
}

function normalizedCrossCorrelation(a, b) {
    const n = a.length;
    if (!n || n !== b.length) return 0;
    if (n === 1) return 0;
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
    meanA /= n;
    meanB /= n;
    let varA = 0;
    let varB = 0;
    let num = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - meanA;
        const db = b[i] - meanB;
        varA += da * da;
        varB += db * db;
        num += da * db;
    }
    const den = Math.sqrt(varA * varB);
    if (den < 1e-8) return 0;
    return num / den;
}

function sobelMagnitude(values, size) {
    const out = new Float32Array(values.length);
    if (size < 3) return out;
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            const gx =
                -values[i - size - 1] - 2 * values[i - 1] - values[i + size - 1] +
                values[i - size + 1] + 2 * values[i + 1] + values[i + size + 1];
            const gy =
                -values[i - size - 1] - 2 * values[i - size] - values[i - size + 1] +
                values[i + size - 1] + 2 * values[i + size] + values[i + size + 1];
            out[i] = Math.sqrt(gx * gx + gy * gy);
        }
    }
    return out;
}

/** How much of the watermark shape is still visible (luminance + gradient NCC). */
export function residualScore(imageData, alphaMap, position) {
    const patch = regionGrayscale(imageData, position);
    if (!patch.length || patch.length !== alphaMap.length) return { spatial: 0, gradient: 0 };
    const spatial = normalizedCrossCorrelation(patch, alphaMap);
    const size = Math.min(position.width, position.height);
    let gradient = 0;
    if (size > 3) {
        gradient = normalizedCrossCorrelation(
            sobelMagnitude(patch, size),
            sobelMagnitude(alphaMap, size)
        );
    }
    return { spatial, gradient };
}

function nearBlackRatio(imageData, position) {
    const { x, y, width, height } = position;
    const data = imageData.data;
    let nearBlack = 0;
    let total = 0;
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = ((y + row) * imageData.width + (x + col)) * 4;
            if (data[idx] <= 5 && data[idx + 1] <= 5 && data[idx + 2] <= 5) nearBlack++;
            total++;
        }
    }
    return total > 0 ? nearBlack / total : 0;
}

function textureStats(imageData, position) {
    const { x, y, width, height } = position;
    const data = imageData.data;
    let sum = 0;
    let sq = 0;
    let total = 0;
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const idx = ((y + row) * imageData.width + (x + col)) * 4;
            const lum = 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
            sum += lum;
            sq += lum * lum;
            total++;
        }
    }
    const mean = total > 0 ? sum / total : 0;
    const variance = total > 0 ? Math.max(0, sq / total - mean * mean) : 0;
    return { mean, std: Math.sqrt(variance) };
}

function textureCollapsed(reference, candidate) {
    const darknessPenalty = Math.max(0, reference.mean - candidate.mean - 1) / Math.max(1, reference.mean);
    const flatnessPenalty = Math.max(0, reference.std * 0.8 - candidate.std) / Math.max(1, reference.std);
    const darknessVisibility = Math.max(0, reference.mean - candidate.mean - 1) / Math.max(1, reference.std);
    const visibleDarkHole = darknessPenalty > 0 && darknessVisibility >= 1.5;
    const strongCollapse = darknessPenalty >= 0.5 && flatnessPenalty >= 0.2 && darknessPenalty > 0 && flatnessPenalty > 0;
    return visibleDarkHole || strongCollapse;
}

function snapshotRegion(imageData, position) {
    const { x, y, width, height } = position;
    const snap = new Uint8ClampedArray(width * height * 4);
    const src = imageData.data;
    for (let row = 0; row < height; row++) {
        const srcBase = ((y + row) * imageData.width + x) * 4;
        const dstBase = row * width * 4;
        for (let i = 0; i < width * 4; i++) snap[dstBase + i] = src[srcBase + i];
    }
    return snap;
}

function restoreRegion(imageData, position, snap) {
    const { x, y, width, height } = position;
    const dst = imageData.data;
    for (let row = 0; row < height; row++) {
        const dstBase = ((y + row) * imageData.width + x) * 4;
        const srcBase = row * width * 4;
        for (let i = 0; i < width * 4; i++) dst[dstBase + i] = snap[srcBase + i];
    }
}

/**
 * Find the removal strength that best cancels the watermark on this frame:
 * the gain where |residual correlation| bottoms out is the frame's real
 * watermark opacity. Too little gain leaves a bright residue; too much flips it
 * into a dark blotch. Safety nets discard gains that inflate near-black or
 * collapse the texture. The sweep runs on a snapshot so the input is untouched.
 */
export function estimateBestGain(imageData, alphaMap, position, options = {}) {
    const fallback = Number.isFinite(options.fallback) && options.fallback > 0
        ? options.fallback
        : 0.65;
    const maxNearBlackRatioIncrease = options.maxNearBlackRatioIncrease ?? 0.05;

    const referenceTexture = textureStats(imageData, position);
    const maxNearBlack = Math.min(1, nearBlackRatio(imageData, position) + maxNearBlackRatioIncrease);

    const lo = Math.max(0.45, Math.min(fallback + 0.45, fallback - 0.3));
    const hi = Math.min(1.2, Math.max(fallback - 0.45, fallback + 0.35));

    let best = null;
    let minLoss = Infinity;
    for (let g = Math.ceil(lo * 40) / 40; g <= hi + 1e-9; g += 0.025) {
        const snap = snapshotRegion(imageData, position);
        removeWatermark(imageData, alphaMap, position, { alphaGain: g });
        const score = residualScore(imageData, alphaMap, position);
        // Positive spatial residual means watermark is still visible as bright pixels.
        // Gradient residual tracks sharp edge remnants.
        const loss = (score.spatial > 0 ? score.spatial * 1.5 : Math.abs(score.spatial)) +
                     Math.max(0, score.gradient) * 0.7;
        const ok =
            nearBlackRatio(imageData, position) <= maxNearBlack + 1e-9 &&
            !textureCollapsed(referenceTexture, textureStats(imageData, position));
        restoreRegion(imageData, position, snap);
        if (ok && loss < minLoss - 1e-6) {
            minLoss = loss;
            best = Math.round(g * 1000) / 1000;
        }
    }
    return best === null ? fallback : best;
}

/**
 * Apply one calibrated removal pass for the frame. Returns the gain used.
 * Pass `autoGain: false` to force the requested gain instead. When the region
 * shows no watermark signature at all (content does not contain the sparkle
 * shape), nothing is touched.
 */
export function removeWithCalibratedGain(imageData, alphaMap, position, options = {}) {
    const requested = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 0.65;

    if (options.autoGain === false) {
        removeWatermark(imageData, alphaMap, position, { alphaGain: requested });
        return requested;
    }

    let gain = requested;
    const initial = residualScore(imageData, alphaMap, position);
    if (initial.spatial >= 0.08 || initial.gradient >= 0.08) {
        gain = estimateBestGain(imageData, alphaMap, position, { fallback: requested });
    }
    removeWatermark(imageData, alphaMap, position, { alphaGain: gain });
    return gain;
}