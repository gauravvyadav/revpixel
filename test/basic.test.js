import assert from 'node:assert';
import {
    removeWatermark,
    calculateAlphaMap,
    getDefaultWatermarkInfo,
    WATERMARK_CANDIDATES
} from '../src/index.js';

console.log('🧪 Running RevPixel (@gauravlabs/revpixel) math tests...');

// 1. Math Verification Test: Forward compositing -> Reverse Alpha Inversion
{
    const originalR = 120;
    const originalG = 80;
    const originalB = 220;
    const alpha = 0.6;
    const logoVal = 255;

    // Forward blend: C_blend = (1 - a) * C_orig + a * L
    const blendedR = Math.round((1 - alpha) * originalR + alpha * logoVal);
    const blendedG = Math.round((1 - alpha) * originalG + alpha * logoVal);
    const blendedB = Math.round((1 - alpha) * originalB + alpha * logoVal);

    // Mock 1x1 ImageData
    const imgData = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([blendedR, blendedG, blendedB, 255]),
    };

    const alphaMap = new Float32Array([alpha]);
    removeWatermark(imgData, alphaMap, { x: 0, y: 0, width: 1, height: 1 });

    assert.strictEqual(imgData.data[0], originalR, 'Red channel successfully restored');
    assert.strictEqual(imgData.data[1], originalG, 'Green channel successfully restored');
    assert.strictEqual(imgData.data[2], originalB, 'Blue channel successfully restored');
    console.log('  ✅ Forward/Reverse algebraic round-trip passed');
}

// 2. Alpha Map Extractor Test
{
    const bgData = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
            255, 255, 255, 255, // max = 255 -> alpha = 1.0
            0, 127.5, 0, 255,   // max = 127.5 -> alpha = 0.5
        ]),
    };
    const map = calculateAlphaMap(bgData);
    assert.strictEqual(map.length, 2);
    assert.strictEqual(map[0], 1.0);
    assert(Math.abs(map[1] - 0.5) < 0.01);
    console.log('  ✅ Alpha map extraction normalization passed');
}

// 3. Geometry and Candidates Test
{
    assert(WATERMARK_CANDIDATES.length >= 6, 'Contains expected candidate configurations');
    const info1k = getDefaultWatermarkInfo(1024, 1024);
    assert.strictEqual(info1k.size, 48, '1k image selects 48px template');

    const info2k = getDefaultWatermarkInfo(2048, 2048);
    assert.strictEqual(info2k.size, 96, '2k image selects 96px template');
    console.log('  ✅ Geometry & resolution threshold selection passed');
}

console.log('🎉 All RevPixel tests passed successfully!');
