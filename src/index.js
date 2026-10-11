/**
 * RevPixel (@gauravlabs/revpixel)
 * Deterministic client-side image and video watermark restoration engine.
 *
 * Maintained by GAURAVLABS (https://gauravlabs.com)
 * Web Studio: https://aiwatermarkremover.gauravlabs.com
 * License: MIT
 */

export { WatermarkEngine } from './imageRestorationEngine.js';
export { VideoWatermarkEngine, VIDEO_DEFAULTS } from './videoRestorationEngine.js';
export { removeWatermark } from './reverseAlphaBlending.js';
export { calculateAlphaMap } from './alphaMapExtractor.js';
export {
    WATERMARK_CANDIDATES,
    getDefaultWatermarkInfo,
    getWatermarkInfo,
    detectWatermarkInImageData,
} from './watermarkGeometry.js';
export {
    getRoi,
    resolveBox,
    buildAlpha,
    cleanFrame,
} from './frameRestoration.js';
export {
    resolveVideoBox,
    getVeoWatermark,
    fitBoxToFrame,
    consensusDetect,
    removeWithCalibratedGain,
} from './videoRemoval.js';
export {
    DEFAULT_TEMPLATE_48_DATA_URL,
    DEFAULT_TEMPLATE_96_DATA_URL,
} from './templates.js';
