import { WatermarkEngine } from './imageRestorationEngine.js';
import {
    getVeoWatermark,
    resolveVideoBox,
    fitBoxToFrame,
    consensusDetect,
    removeWithCalibratedGain,
} from './videoRemoval.js';

export const VIDEO_DEFAULTS = { gain: 0.65, offsetX: 0, offsetY: 0, sizeScale: 1 };

/**
 * Client-side Gemini Veo video watermark remover.
 *
 * All removal math lives in videoRemoval.js so the shared image pipeline
 * (frameRestoration.js / reverseAlphaBlending.js) stays untouched. The
 * watermark is located by multi-frame consensus detection; every frame is then
 * cleaned with a per-frame calibrated removal strength so videos whose
 * watermark opacity differs from the 0.6 default are still handled cleanly.
 *
 * Everything runs locally; nothing is uploaded.
 */
export class VideoWatermarkEngine {
    constructor(engine) {
        this.engine = engine; // a ready WatermarkEngine (read-only)
        this._mb = null;
    }

    static async create() {
        const engine = await WatermarkEngine.create();
        return new VideoWatermarkEngine(engine);
    }

    static isSupported() {
        return (
            typeof VideoEncoder !== 'undefined' &&
            typeof VideoDecoder !== 'undefined'
        );
    }

    async _lib() {
        if (!this._mb) this._mb = await import('mediabunny');
        return this._mb;
    }

    /** The Gemini sparkle reference image, for the tuner preview. */
    get sparkleImage() {
        return this.engine.bg96;
    }

    /** Default Veo watermark box (bottom-right): size ≈ shortSide/15, margin ≈ shortSide/10. */
    getVeoWatermark(width, height) {
        return getVeoWatermark(width, height);
    }

    /**
     * Detect the watermark by multi-frame consensus over sampled frames of a
     * video. Returns the best corroborated box (or the geometric Veo fallback).
     * @param {Array<{imageData: ImageData, width:number, height:number}>} samples
     */
    detectFromSamples(samples) {
        const first = samples && samples[0];
        const width = first?.width ?? 0;
        const height = first?.height ?? 0;
        return consensusDetect(
            samples,
            this.engine.alpha48,
            this.engine.alpha96,
            width,
            height,
            (size) => this.engine.buildScaledAlphaMap(size)
        );
    }

    /**
     * Clean a single full-frame ImageData in place (used for the live preview).
     * Returns the resolved watermark box + ROI so the UI can draw guides.
     */
    previewClean(fullImageData, width, height, opts = {}) {
        const base = opts.base
            ? fitBoxToFrame(opts.base, width, height)
            : getVeoWatermark(width, height);
        const wm = resolveVideoBox(base, width, height, opts);
        const alpha = this.engine.buildScaledAlphaMap(wm.size);
        removeWithCalibratedGain(fullImageData, alpha, wm, {
            alphaGain: opts.gain ?? VIDEO_DEFAULTS.gain,
            autoGain: opts.autoGain !== false,
        });
        const pad = Math.round(wm.size * 0.6);
        const rx = Math.max(0, wm.x - pad);
        const ry = Math.max(0, wm.y - pad);
        const rw = Math.min(width - rx, wm.width + pad * 2);
        const rh = Math.min(height - ry, wm.height + pad * 2);
        return { wm, roi: { x: rx, y: ry, width: rw, height: rh } };
    }

    /**
     * @param {File} file
     * @param {{gain?:number, offsetX?:number, offsetY?:number, sizeScale?:number,
     *          base?:object, autoGain?:boolean,
     *          onProgress?:(p:{progress:number})=>void}} [opts]
     */
    async process(file, opts = {}) {
        const onProgress = opts.onProgress || (() => {});
        const gain = opts.gain ?? VIDEO_DEFAULTS.gain;
        const autoGain = opts.autoGain !== false;

        const mb = await this._lib();
        const {
            ALL_FORMATS, BlobSource, BufferTarget, CanvasSource,
            EncodedAudioPacketSource, EncodedPacketSink, Input,
            Mp4OutputFormat, Output, QUALITY_HIGH, VideoSampleSink, canEncodeVideo,
        } = mb;

        if (canEncodeVideo && !(await canEncodeVideo('avc'))) {
            throw new Error(
                'Your browser cannot encode H.264 video locally. Please try the latest Chrome or Edge on desktop.'
            );
        }

        const originalUrl = URL.createObjectURL(file);
        const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
            input.dispose?.();
            URL.revokeObjectURL(originalUrl);
            throw new Error('No decodable video track was found in this file.');
        }

        const width = ((videoTrack.displayWidth ?? videoTrack.codedWidth) >> 1) << 1;
        const height = ((videoTrack.displayHeight ?? videoTrack.codedHeight) >> 1) << 1;
        const duration = await input.computeDuration().catch(() => 0);

        let frameRate = 30;
        try {
            const stats = await videoTrack.computePacketStats(120);
            if (stats?.averagePacketRate) frameRate = Math.round(stats.averagePacketRate);
        } catch { /* keep default */ }

        const base = opts.base
            ? fitBoxToFrame(opts.base, width, height)
            : getVeoWatermark(width, height);
        const wm = resolveVideoBox(base, width, height, opts);
        const alpha = this.engine.buildScaledAlphaMap(wm.size);

        const canvas =
            typeof OffscreenCanvas !== 'undefined'
                ? new OffscreenCanvas(width, height)
                : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const target = new BufferTarget();
        const output = new Output({ format: new Mp4OutputFormat(), target });
        const videoSource = new CanvasSource(canvas, {
            codec: 'avc',
            bitrate: QUALITY_HIGH,
            keyFrameInterval: 2,
            sizeChangeBehavior: 'passThrough',
        });
        output.addVideoTrack(videoSource, { frameRate });

        // Audio passthrough (best-effort).
        let audioSource = null;
        let audioTrack = null;
        let audioDecoderConfig = null;
        try {
            audioTrack = await input.getPrimaryAudioTrack();
            if (audioTrack) {
                const audioCodec = await audioTrack.getCodec();
                audioDecoderConfig = await audioTrack.getDecoderConfig().catch(() => null);
                if (audioCodec && audioDecoderConfig) {
                    audioSource = new EncodedAudioPacketSource(audioCodec);
                    output.addAudioTrack(audioSource);
                }
            }
        } catch {
            audioSource = null;
        }

        await output.start();

        const fallbackDur = frameRate > 0 ? 1 / frameRate : 1 / 30;
        const sink = new VideoSampleSink(videoTrack);
        let firstTimestamp = null;
        let lastTimestamp = -1;
        const region = { x: 0, y: 0, width: wm.size, height: wm.size };
        for await (const sample of sink.samples()) {
            if (firstTimestamp === null) firstTimestamp = sample.timestamp;
            let timestamp = sample.timestamp - firstTimestamp;
            if (!(timestamp >= 0)) timestamp = 0;
            if (timestamp <= lastTimestamp) timestamp = lastTimestamp + fallbackDur;
            const dur =
                Number.isFinite(sample.duration) && sample.duration > 0
                    ? sample.duration
                    : fallbackDur;
            lastTimestamp = timestamp;

            sample.draw(ctx, 0, 0, width, height);
            sample.close();

            const px = ctx.getImageData(wm.x, wm.y, wm.size, wm.size);
            removeWithCalibratedGain(px, alpha, region, { alphaGain: gain, autoGain });
            ctx.putImageData(px, wm.x, wm.y);

            await videoSource.add(timestamp, dur);
            if (duration) onProgress({ progress: Math.min(0.99, timestamp / duration) });
        }
        videoSource.close();

        if (audioSource) {
            try {
                const offset = firstTimestamp ?? 0;
                const aSink = new EncodedPacketSink(audioTrack);
                let isFirstAudio = true;
                let lastAudioTs = -1;
                for await (const packet of aSink.packets()) {
                    let newTs = packet.timestamp - offset;
                    if (newTs < 0) continue;
                    if (newTs <= lastAudioTs) newTs = lastAudioTs + 1e-6;
                    lastAudioTs = newTs;
                    let outPacket = packet;
                    if (newTs !== packet.timestamp && typeof packet.clone === 'function') {
                        outPacket = packet.clone({ timestamp: newTs });
                    }
                    await audioSource.add(
                        outPacket,
                        isFirstAudio && audioDecoderConfig ? { decoderConfig: audioDecoderConfig } : undefined
                    );
                    isFirstAudio = false;
                }
            } catch (e) {
                console.warn('Audio passthrough failed; exporting video only.', e);
            } finally {
                audioSource.close();
            }
        }

        await output.finalize();
        input.dispose?.();

        if (!target.buffer) {
            URL.revokeObjectURL(originalUrl);
            throw new Error('Video export produced no output.');
        }

        const blob = new Blob([target.buffer], { type: 'video/mp4' });
        onProgress({ progress: 1 });

        return {
            blob,
            url: URL.createObjectURL(blob),
            originalUrl,
            ext: 'mp4',
            mime: 'video/mp4',
            width,
            height,
        };
    }
}