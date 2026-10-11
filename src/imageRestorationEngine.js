import { calculateAlphaMap } from './alphaMapExtractor.js';
import { removeWatermark } from './reverseAlphaBlending.js';
import { getWatermarkInfo, detectWatermarkInImageData } from './watermarkGeometry.js';
import { DEFAULT_TEMPLATE_48_DATA_URL, DEFAULT_TEMPLATE_96_DATA_URL } from './templates.js';

export class WatermarkEngine {
    constructor(bg48, bg96, alpha48, alpha96) {
        this.bg48 = bg48;
        this.bg96 = bg96;
        this.alpha48 = alpha48;
        this.alpha96 = alpha96;
        this.alphaMaps = {
            48: alpha48,
            96: alpha96,
        };
    }

    /**
     * Initializes the WatermarkEngine.
     * Works out of the box with embedded base64 templates (zero network dependencies),
     * or accepts custom template URLs or Image instances.
     */
    static async create(options = {}) {
        const src48 = options.template48 || DEFAULT_TEMPLATE_48_DATA_URL;
        const src96 = options.template96 || DEFAULT_TEMPLATE_96_DATA_URL;

        const loadImage = (src) => {
            if (typeof Image === 'undefined') {
                throw new Error('WatermarkEngine requires a browser DOM or Canvas environment with Image support.');
            }
            if (typeof Image !== 'undefined' && src instanceof Image) return Promise.resolve(src);
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = src;
            });
        };

        try {
            const [bg48, bg96] = await Promise.all([
                loadImage(src48),
                loadImage(src96)
            ]);

            // Precompute alpha maps
            const extractMap = (img, size) => {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, size, size);
                return calculateAlphaMap(ctx.getImageData(0, 0, size, size));
            };

            const alpha48 = extractMap(bg48, 48);
            const alpha96 = extractMap(bg96, 96);

            return new WatermarkEngine(bg48, bg96, alpha48, alpha96);
        } catch (e) {
            console.error("Failed to load watermark templates in WatermarkEngine.", e);
            throw e;
        }
    }

    getWatermarkInfo(width, height) {
        return getWatermarkInfo(width, height);
    }

    detect(imageData) {
        return detectWatermarkInImageData(imageData, this.alpha48, this.alpha96);
    }

    async getAlphaMap(size) {
        if (this.alphaMaps[size]) return this.alphaMaps[size];

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const sourceImg = size <= 48 ? this.bg48 : this.bg96;
        ctx.drawImage(sourceImg, 0, 0, size, size);

        const map = calculateAlphaMap(ctx.getImageData(0, 0, size, size));
        this.alphaMaps[size] = map;
        return map;
    }

    // Build a watermark alpha map at an arbitrary size
    buildScaledAlphaMap(size) {
        if (this.alphaMaps[size]) return this.alphaMaps[size];

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const sourceImg = size <= 48 ? this.bg48 : this.bg96;
        ctx.drawImage(sourceImg, 0, 0, size, size);

        const map = calculateAlphaMap(ctx.getImageData(0, 0, size, size));
        this.alphaMaps[size] = map;
        return map;
    }

    async process(imageFile, options = {}) {
        const objectUrl = URL.createObjectURL(imageFile);
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i); 
            i.onerror = reject;
            i.src = objectUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const detected = this.detect(imageData);
        const gain = options.gain ?? options.alphaGain ?? detected.gain ?? 0.6;
        
        const alphaMap = await this.getAlphaMap(detected.size);
        removeWatermark(imageData, alphaMap, detected, { alphaGain: gain });
        
        ctx.putImageData(imageData, 0, 0);
        
        return {
            blob: await new Promise(r => canvas.toBlob(r, 'image/png')),
            originalSrc: objectUrl,
            width: img.width,
            height: img.height,
            detected
        };
    }

    async prepareForSize(width, height) {
        const config = this.getWatermarkInfo(width, height);
        const alphaMap = await this.getAlphaMap(config.size);
        return { config, alphaMap };
    }

    removeFromImageData(imageData, prepared, options = {}) {
        const { config, alphaMap } = prepared || this._sync(imageData.width, imageData.height);
        const gain = options?.gain ?? options?.alphaGain ?? config.gain ?? 0.6;
        removeWatermark(imageData, alphaMap, config, { alphaGain: gain });
        return imageData;
    }

    _sync(width, height) {
        const config = this.getWatermarkInfo(width, height);
        return { config, alphaMap: this.alphaMaps[config.size] || this.alpha48 };
    }
}
