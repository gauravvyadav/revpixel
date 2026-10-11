// Watermark Geometry & Detection Engine
// Calibrated against official Gemini / Imagen output catalog and local correlation detector.

export const WATERMARK_CANDIDATES = Object.freeze([
    // Modern Gemini 3.x / Imagen 3 outputs (e.g. 1408x768, 1024x1024, 1376x768, 1264x848)
    { id: 'modern-1k', label: 'Gemini 3.x / Imagen 3 (48px, Inset 96px)', size: 48, marginX: 96, marginY: 96, defaultGain: 0.6, templateKey: 48 },
    // Modern Gemini 2K / 4K outputs (2048x2048, 2752x1536, 2816x1536, 4096x4096)
    { id: 'modern-2k', label: 'Gemini 2K/4K (96px, Inset 192px)', size: 96, marginX: 192, marginY: 192, defaultGain: 0.6, templateKey: 96 },
    // Classic Corner (Legacy 0.5k & early Gemini 1k)
    { id: 'classic-48', label: 'Classic Corner (48px, Inset 32px)', size: 48, marginX: 32, marginY: 32, defaultGain: 1.0, templateKey: 48 },
    // Classic 2K
    { id: 'classic-96', label: 'Classic Corner (96px, Inset 64px)', size: 96, marginX: 64, marginY: 64, defaultGain: 1.0, templateKey: 96 },
    // Intermediate insets
    { id: 'mid-48', label: 'Mid-Inset (48px, Inset 64px)', size: 48, marginX: 64, marginY: 64, defaultGain: 0.6, templateKey: 48 },
    { id: 'mid-96', label: 'Mid-Inset (96px, Inset 96px)', size: 96, marginX: 96, marginY: 96, defaultGain: 0.6, templateKey: 96 },
]);

export function getDefaultWatermarkInfo(width, height) {
    const is2k = width >= 2000 && height >= 1400;
    if (is2k) {
        const size = 96;
        const margin = 192;
        return {
            id: 'modern-2k',
            name: 'Gemini 2K/4K (192px Inset)',
            size,
            x: Math.max(0, width - margin - size),
            y: Math.max(0, height - margin - size),
            width: size,
            height: size,
            gain: 0.6,
            templateKey: 96,
        };
    }

    // Default for 1K/1.5K (1408x768, 1024x1024, etc.)
    const size = 48;
    const margin = 96;
    return {
        id: 'modern-1k',
        name: 'Gemini 3.x / Imagen 3 (96px Inset)',
        size,
        x: Math.max(0, width - margin - size),
        y: Math.max(0, height - margin - size),
        width: size,
        height: size,
        gain: 0.6,
        templateKey: 48,
    };
}

export function getWatermarkInfo(width, height) {
    return getDefaultWatermarkInfo(width, height);
}

export function getCompactWatermarkInfo(width, height) {
    return getDefaultWatermarkInfo(width, height);
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-image detection primitives (pure math, no canvas needed).
// ─────────────────────────────────────────────────────────────────────────────

/** Bilinear-resample a 1-D rgba-max alpha buffer to a new square size. */
function resampleAlpha(src, srcSize, dstSize) {
    const out = new Float32Array(dstSize * dstSize);
    const s = srcSize / dstSize;
    for (let y = 0; y < dstSize; y++) {
        const sy = y * s;
        const sy0 = sy | 0;
        const sy1 = Math.min(srcSize - 1, sy0 + 1);
        const fy = sy - sy0;
        const row0 = sy0 * srcSize;
        const row1 = sy1 * srcSize;
        for (let x = 0; x < dstSize; x++) {
            const sx = x * s;
            const sx0 = sx | 0;
            const sx1 = Math.min(srcSize - 1, sx0 + 1);
            const fx = sx - sx0;
            const v0 = src[row0 + sx0] * (1 - fx) + src[row0 + sx1] * fx;
            const v1 = src[row1 + sx0] * (1 - fx) + src[row1 + sx1] * fx;
            out[y * dstSize + x] = v0 * (1 - fy) + v1 * fy;
        }
    }
    return out;
}

/** Pre-computed template stats + mask of pixels that carry watermark mass. */
function templateStats(alpha) {
    const mask = [];
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < alpha.length; i++) {
        const v = alpha[i];
        if (v > 0.06) {
            mask.push(i);
            sum += v;
            sq += v * v;
        }
    }
    const n = mask.length || 1;
    const mean = sum / n;
    const std = Math.sqrt(Math.max(1e-6, sq / n - mean * mean));
    return { mean, std, n, mask };
}

/** Downsample full ImageData into a small normalized luminance buffer. */
function downsampleLuminance(imageData, tw, th) {
    const { width: sw, height: sh, data } = imageData;
    const out = new Float32Array(tw * th);
    const sx = sw / tw;
    const sy = sh / th;
    for (let y = 0; y < th; y++) {
        const y0 = Math.floor(y * sy);
        const y1 = Math.min(sh - 1, Math.ceil((y + 1) * sy));
        for (let x = 0; x < tw; x++) {
            const x0 = Math.floor(x * sx);
            const x1 = Math.min(sw - 1, Math.ceil((x + 1) * sx));
            let s = 0;
            let c = 0;
            for (let yy = y0; yy <= y1; yy++) {
                const base = yy * sw * 4;
                for (let xx = x0; xx <= x1; xx++) {
                    const i = base + xx * 4;
                    s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                    c++;
                }
            }
            out[y * tw + x] = s / (c * 255);
        }
    }
    return out;
}

/** Normalized cross-correlation of a window against the template alpha map. */
function nccAt(lum, lw, x, y, size, alpha, st) {
    const n = st.n;
    let num = 0;
    let iSum = 0;
    let iSq = 0;
    const mask = st.mask;
    for (let k = 0; k < n; k++) {
        const ptr = mask[k];
        const r = (ptr / size) | 0;
        const c = ptr - r * size;
        const l = lum[(y + r) * lw + (x + c)];
        num += (alpha[ptr] - st.mean) * l;
        iSum += l;
        iSq += l * l;
    }
    const iMean = iSum / n;
    const iVar = iSq / n - iMean * iMean;
    if (iVar < 1e-4) return -1; // flat / no structure — refuses NCC instability
    const iStd = Math.sqrt(iVar);
    return num / (n * st.std * iStd);
}

/**
 * Search the entire image for the Gemini sparkle at any position and scale.
 * Coarse-to-fine: a multi-scale scan on a downsampled buffer, followed by
 * sub-pixel refinement on the full-resolution pixels. Returns the best
 * candidate box or null.
 */
export function findWatermarkInImageData(imageData, alpha48, alpha96) {
    const { width: W, height: H } = imageData;
    if (W < 12 || H < 12) return null;

    const primary = alpha48 || alpha96;
    if (!primary) return null;
    const primarySize = Math.round(Math.sqrt(primary.length));

    // ── Coarse scan on a small downsampled luminance buffer ──
    const MAXDIM = 384;
    const scale = Math.min(1, MAXDIM / Math.max(W, H));
    const LW = Math.max(8, Math.round(W * scale));
    const LH = Math.max(8, Math.round(H * scale));
    const lum = downsampleLuminance(imageData, LW, LH);

    // Coarse scales localize the sparkle anywhere in the frame. Multiple scales
    // are needed: small eff tracks small watermarks, large eff tracks big ones.
    // The full-resolution refinement later resolves the exact size.
    const effSizes = [12, 16, 24];

    const buckets = new Map(); // dedupe while collecting candidate peaks
    const floor = 0.12;

    for (const eff of effSizes) {
        if (eff > Math.min(LW, LH)) continue;
        const alpha = resampleAlpha(primary, primarySize, eff);
        const st = templateStats(alpha);
        const stride = eff <= 16 ? 2 : 4;

        for (let y = 0; y + eff <= LH; y += stride) {
            for (let x = 0; x + eff <= LW; x += stride) {
                const score = nccAt(lum, LW, x, y, eff, alpha, st);
                if (score < floor) continue;

                const fx = Math.round(x / scale);
                const fy = Math.round(y / scale);
                const bucketKey = (Math.round(fx / 28)) + ':' + (Math.round(fy / 28));
                const prev = buckets.get(bucketKey);
                if (!prev || score > prev.score) {
                    buckets.set(bucketKey, {
                        x: fx,
                        y: fy,
                        score,
                        eff,
                        fullSize: Math.round(eff / scale),
                    });
                }
            }
        }
    }

    // Merge spatially-close buckets, keep the strongest of each cluster
    const rawHits = Array.from(buckets.values()).sort((a, b) => b.score - a.score);
    const hits = [];
    for (const h of rawHits) {
        const cluster = hits.find((c) => Math.abs(c.x - h.x) < 30 && Math.abs(c.y - h.y) < 30);
        if (cluster) {
            if (h.score > cluster.score) {
                cluster.x = h.x;
                cluster.y = h.y;
                cluster.score = h.score;
                cluster.fullSize = h.fullSize;
            }
        } else {
            hits.push({ ...h });
        }
        if (hits.length >= 9) break;
    }
    if (!hits.length) return null;

    // ── Full-resolution refinement around each hit ──
    const candidateSizes = [20, 24, 32, 40, 48, 56, 64, 72, 84, 96, 112, 128];
    const paddedSizes = new Set(candidateSizes);
    for (const h of hits) {
        paddedSizes.add(Math.max(8, h.fullSize));
        paddedSizes.add(Math.max(8, Math.round(h.fullSize * 0.8)));
        paddedSizes.add(Math.max(8, Math.round(h.fullSize * 1.2)));
    }

    const cache = new Map();
    const bestByHit = [];
    const data = imageData.data;

    for (const h of hits) {
        let best = null;
        const cx = Math.max(0, Math.min(W - 24, h.x));
        const cy = Math.max(0, Math.min(H - 24, h.y));
        for (const size of paddedSizes) {
            if (size < 12 || size > Math.min(W, H)) continue;
            let scaled;
            let st;
            if (cache.has(size)) {
                const entry = cache.get(size);
                scaled = entry.alpha;
                st = entry.st;
            } else {
                const src = size <= 64 ? (alpha48 || primary) : (alpha96 || alpha48 || primary);
                scaled = resampleAlpha(src, src.length > 0 ? Math.round(Math.sqrt(src.length)) : 48, size);
                st = templateStats(scaled);
                cache.set(size, { alpha: scaled, st });
            }
            // Search radius scales with the candidate size to absorb coarse-scan
            // position drift on large watermarks.
            const radius = size > 64 ? Math.round(size * 0.15) : 8;
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x < 0 || y < 0 || x + size > W || y + size > H) continue;
                    const score = fullNcc(data, W, x, y, size, scaled, st);
                    if (best === null || score > best.score) {
                        best = { x, y, score, size };
                    }
                }
            }
        }
        if (best && best.score > 0) bestByHit.push(best);
    }

    if (!bestByHit.length) return null;

    // Merge near-identical detections, keep the strongest
    bestByHit.sort((a, b) => b.score - a.score);
    const accepted = [];
    for (const b of bestByHit) {
        if (accepted.some((a) => Math.abs(a.x - b.x) < b.size * 0.4 && Math.abs(a.y - b.y) < b.size * 0.4)) continue;
        accepted.push(b);
    }

    const winner = accepted[0];
    if (!winner) return null;

    return {
        id: 'auto-detect',
        name: `Auto-detected (${winner.size}px)`,
        size: winner.size,
        x: winner.x,
        y: winner.y,
        width: winner.size,
        height: winner.size,
        gain: 0.6,
        templateKey: winner.size <= 64 ? 48 : 96,
        score: winner.score,
    };
}

/** NCC evaluated straight against full-resolution RAWBA bytes (no lum buffer). */
function fullNcc(data, W, x, y, size, alpha, st) {
    const n = st.n;
    const mask = st.mask;
    let num = 0;
    let iSum = 0;
    let iSq = 0;
    for (let k = 0; k < n; k++) {
        const ptr = mask[k];
        const r = (ptr / size) | 0;
        const c = ptr - r * size;
        const i = ((y + r) * W + (x + c)) * 4;
        const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        num += (alpha[ptr] - st.mean) * l;
        iSum += l;
        iSq += l * l;
    }
    const iMean = iSum / n;
    const iVar = iSq / n - iMean * iMean;
    if (iVar < 1e-4) return -1;
    const iStd = Math.sqrt(iVar);
    return num / (n * st.std * iStd);
}

/** Normalized cross-correlation between image region luminance and template alpha */
function scoreCandidate(imageData, template, size, x, y) {
    if (x < 0 || y < 0 || x + size > imageData.width || y + size > imageData.height) {
        return -1;
    }

    let tSum = 0;
    let tSqSum = 0;
    let count = 0;

    for (let i = 0; i < template.length; i++) {
        if (template[i] > 0.05) {
            tSum += template[i];
            tSqSum += template[i] * template[i];
            count++;
        }
    }
    if (count === 0) return -1;

    const tMean = tSum / count;
    const tStd = Math.sqrt(Math.max(1e-6, tSqSum / count - tMean * tMean));

    let iSum = 0;
    let iSqSum = 0;
    let num = 0;

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const tVal = template[r * size + c];
            if (tVal <= 0.05) continue;

            const idx = ((y + r) * imageData.width + (x + c)) * 4;
            const lum = (0.299 * imageData.data[idx] + 0.587 * imageData.data[idx + 1] + 0.114 * imageData.data[idx + 2]) / 255.0;

            iSum += lum;
            iSqSum += lum * lum;
            num += (tVal - tMean) * lum;
        }
    }

    const iMean = iSum / count;
    const iStd = Math.sqrt(Math.max(1e-6, iSqSum / count - iMean * iMean));
    return num / (count * tStd * iStd);
}

/** Fast bootstrap: score the known bottom-right corner slots only. */
function bestCornerCandidate(imageData, alpha48, alpha96) {
    let bestScore = -1;
    let bestCand = null;

    for (const cand of WATERMARK_CANDIDATES) {
        const template = cand.templateKey === 48 ? alpha48 : alpha96;
        if (!template) continue;

        const x = imageData.width - cand.marginX - cand.size;
        const y = imageData.height - cand.marginY - cand.size;
        const score = scoreCandidate(imageData, template, cand.size, x, y);

        if (score > bestScore) {
            bestScore = score;
            bestCand = {
                id: cand.id,
                name: cand.label,
                size: cand.size,
                x,
                y,
                width: cand.size,
                height: cand.size,
                gain: cand.defaultGain,
                templateKey: cand.templateKey,
                score,
            };
        }
    }
    return bestCand;
}

/**
 * Automatically detects the exact watermark position and size.
 * 1. Fast corner-slot check (standard Gemini images resolve instantly).
 * 2. Whole-image multi-scale search (watermarks anywhere, any scale, incl. crops).
 * 3. Robust default fallback keyed to the image's resolution.
 */
export function detectWatermarkInImageData(imageData, alpha48, alpha96) {
    const corner = bestCornerCandidate(imageData, alpha48, alpha96);

    // High-confidence corner match — return immediately (zero cost on typical images)
    if (corner && corner.score > 0.6) {
        return corner;
    }

    // Scan the whole image for a watermark positioned anywhere
    const anywhere = findWatermarkInImageData(imageData, alpha48, alpha96);
    if (anywhere && anywhere.score >= 0.34) {
        return anywhere;
    }

    // Passable corner match
    if (corner && corner.score > 0.35) {
        return corner;
    }

    // Otherwise, fallback to the robust default for this aspect ratio
    const def = getDefaultWatermarkInfo(imageData.width, imageData.height);
    return {
        ...def,
        score: corner ? corner.score : 0,
    };
}
