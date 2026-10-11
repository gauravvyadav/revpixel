# RevPixel

> **Deterministic client-side watermark restoration engine by GAURAVLABS.**  
> Maintained by [**GAURAVLABS**](https://gauravlabs.com) • [**Try the Free Web Studio →**](https://aiwatermarkremover.gauravlabs.com)

[![Version](https://img.shields.io/badge/version-0.1.0-emerald.svg)](https://github.com/gauravvyadav/revpixel)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Network Dependencies](https://img.shields.io/badge/network-zero--dependency-brightgreen.svg)]()
[![Pure Client-Side](https://img.shields.io/badge/privacy-100%25%20client--side-blueviolet.svg)]()

---

## 🧮 What is RevPixel?

Unlike destructive AI inpainting tools that hallucinate or blur pixels, **RevPixel** uses **exact mathematical inversion** of digital alpha compositing to restore original underlying pixels.

### 1. Forward Compositing (How AI Watermarks Are Stamped)
When an AI generator embeds a white logo ($L = 255$) with an opacity map $\alpha(x, y) \in [0, 1]$ over an original background pixel $C_{orig}$:

$$C_{blend} = (1 - \alpha) \cdot C_{orig} + \alpha \cdot L$$

### 2. Reverse Alpha Blending (How RevPixel Restores Pixels)
Because the logo color $L = 255$ and the alpha transparency channel $\alpha$ are known, RevPixel algebraically solves for the clean original pixel $C_{orig}$:

$$C_{orig} = \frac{C_{blend} - \alpha \cdot L}{1 - \alpha}$$

---

## ✨ Features

- **Mathematical Precision**: Restores exact original RGB values with zero blur, zero seam lines, and zero AI hallucination.
- **Image & Video Support**: Supports static images (PNG, JPEG, WebP) and high-bitrate video (MP4, WebM) via WebCodecs.
- **Zero Network Overhead**: Watermark templates are embedded as offline data URIs. No external server or assets needed.
- **100% Private & In-Browser**: All processing occurs locally in memory. Zero bytes leave the client.
- **Residual-Aware Gain Calibration**: Compensates for compression artifacts with noise-floor filtering ($\alpha < 0.002$).

---

## 📦 Installation

```bash
npm install @gauravlabs/revpixel
# or
pnpm add @gauravlabs/revpixel
# or
yarn add @gauravlabs/revpixel
# or
bun add @gauravlabs/revpixel
```

---

## 🚀 Framework Usage & Examples

RevPixel is built in standard ES Modules with **zero UI framework lock-in**. It works across all modern web frameworks.

### 1. Next.js (App Router / Pages Router)

Because image restoration operates directly on the user device via HTML5 Canvas and `ImageData`, place it inside a **Client Component** marked with `"use client"`:

```tsx
// app/watermark/page.tsx or components/WatermarkRemover.tsx
"use client";

import { useState } from "react";
import { WatermarkEngine } from "@gauravlabs/revpixel";

export default function WatermarkRemover() {
  const [cleanImageUrl, setCleanImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      // 1. Initialize engine (zero-network, embedded templates)
      const engine = await WatermarkEngine.create();

      // 2. Process image file
      // 2. Process image file (optional: pass { gain: 0.65 } for custom strength tuning)
      const result = await engine.process(file, { gain: 0.65 });

      // 3. Display or download restored image Blob
      const url = URL.createObjectURL(result.blob);
      setCleanImageUrl(url);
    } catch (err) {
      console.error("Restoration error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <input type="file" accept="image/*" onChange={handleUpload} disabled={loading} />
      {loading && <p>Restoring original pixels...</p>}
      {cleanImageUrl && (
        <div>
          <h3>Restored Image:</h3>
          <img src={cleanImageUrl} alt="Restored preview" style={{ maxWidth: "100%" }} />
          <br />
          <a href={cleanImageUrl} download="cleaned.png">Download Restored PNG</a>
        </div>
      )}
    </div>
  );
}
```

> **Why `"use client"`?** Next.js Server Components run on the Node.js server where there is no DOM or GPU Canvas. Running RevPixel on the client ensures 100% privacy and zero server compute bills.

---

### 2. React / Vite

```tsx
import React, { useState } from "react";
import { WatermarkEngine } from "@gauravlabs/revpixel";

export function ReactCleaner() {
  const [preview, setPreview] = useState<string | null>(null);

  const onSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const engine = await WatermarkEngine.create();
    const { blob } = await engine.process(file);
    setPreview(URL.createObjectURL(blob));
  };

  return (
    <div>
      <input type="file" onChange={onSelect} />
      {preview && <img src={preview} alt="Cleaned" />}
    </div>
  );
}
```

---

### 3. Vue 3 / Nuxt

```vue
<script setup>
import { ref } from "vue";
import { WatermarkEngine } from "@gauravlabs/revpixel";

const restoredUrl = ref(null);
const processing = ref(false);

async function onFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  processing.value = true;
  try {
    const engine = await WatermarkEngine.create();
    const result = await engine.process(file);
    restoredUrl.value = URL.createObjectURL(result.blob);
  } finally {
    processing.value = false;
  }
}
</script>

<template>
  <div>
    <input type="file" accept="image/*" @change="onFileSelected" />
    <p v-if="processing">Calculating reverse alpha blending...</p>
    <img v-if="restoredUrl" :src="restoredUrl" alt="Restored" />
  </div>
</template>
```

---

### 4. Svelte / SvelteKit

```svelte
<script>
  import { WatermarkEngine } from "@gauravlabs/revpixel";

  let restoredSrc = null;

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const engine = await WatermarkEngine.create();
    const result = await engine.process(file);
    restoredSrc = URL.createObjectURL(result.blob);
  }
</script>

<input type="file" accept="image/*" on:change={handleFile} />
{#if restoredSrc}
  <img src={restoredSrc} alt="Restored preview" />
{/if}
```

---

### 5. Vanilla JavaScript (HTML / Vite / Script)

```html
<!DOCTYPE html>
<html lang="en">
<body>
  <input type="file" id="uploader" accept="image/*" />
  <img id="output" />

  <script type="module">
    import { WatermarkEngine } from "@gauravlabs/revpixel";

    document.getElementById("uploader").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const engine = await WatermarkEngine.create();
      const result = await engine.process(file);
      document.getElementById("output").src = URL.createObjectURL(result.blob);
    });
  </script>
</body>
</html>
```

---

### 6. Hardware-Accelerated Video Processing (WebCodecs)

For 4K/60fps video, RevPixel uses browser-native hardware acceleration through `VideoDecoder` and `VideoEncoder`:

```javascript
import { VideoWatermarkEngine, VIDEO_DEFAULTS } from "@gauravlabs/revpixel";

if (VideoWatermarkEngine.isSupported()) {
  const videoEngine = await VideoWatermarkEngine.create();

  // 1. Detect watermark position across video frames
  const detection = videoEngine.detectFromSamples(sampledFrames);

  // 2. Clean an individual video frame in-memory:
  // Clean a video frame with fine-tuned strength (gain defaults to 0.65):
  videoEngine.previewClean(frameImageData, width, height, {
    gain: 0.65,
    autoGain: true,
  });

  // Full video export with custom strength tuning:
  const cleanVideo = await videoEngine.process(videoFile, {
    gain: 0.65,
    autoGain: true,
    onProgress: ({ progress }) => console.log(progress),
  });
} else {
  console.warn("WebCodecs is not supported in this browser.");
}
```

---

### 7. Low-Level In-Memory Buffer API

If you already have an `ImageData` or raw pixel buffer (in Web Workers or Canvas):

```javascript
import { removeWatermark, getDefaultWatermarkInfo } from "@gauravlabs/revpixel";

// Get standard template geometry for 1024x1024 image
const config = getDefaultWatermarkInfo(1024, 1024);

// Clean pixels in-place with low-level removeWatermark
removeWatermark(myImageData, alphaMap, config, { alphaGain: 0.6 });

// Or clean an entire HTML5 Canvas / ImageData with sub-pixel ROI bounds & calibrated gain
import { cleanFrame } from "@gauravlabs/revpixel";
cleanFrame(
  originalImageData, // Background source
  previewImageData,  // Destination buffer to modify
  width,
  height,
  config.box,
  { gain: 0.65, offsetX: 0, offsetY: 0, sizeScale: 1 }
);
```

---

## 🎯 Supported Models & Geometry

| Model | Resolution Range | Watermark Size | Default Margin | Default Gain |
| :--- | :--- | :--- | :--- | :--- |
| **Gemini 3.x / Imagen 3** | 1024×1024, 1408×768 | 48px | 96px inset | 0.6 |
| **Gemini 2K / 4K** | 2048×2048, 4096×4096 | 96px | 192px inset | 0.6 |
| **Google Veo (Video)** | 720p, 1080p, 4K | shortSide / 15 | shortSide / 10 | 0.65 |

---

## 🛠️ API Reference

### `WatermarkEngine`
- `WatermarkEngine.create(options?)`: Async factory to initialize engine and precompute alpha maps.
- `engine.process(imageFile)`: Complete pipeline returning clean PNG Blob, dimensions, and detection metadata.
- `engine.detect(imageData)`: Multi-candidate Pearson correlation detector.
- `engine.removeFromImageData(imageData, prepared?)`: In-place pixel cleaner.

### `VideoWatermarkEngine`
- `VideoWatermarkEngine.isSupported()`: Returns `true` if browser supports `VideoEncoder` & `VideoDecoder`.
- `VideoWatermarkEngine.create()`: Factory for video pipeline.
- `videoEngine.previewClean(imageData, width, height, options)`: Real-time frame cleaner with calibrated gain.
- `videoEngine.detectFromSamples(samples)`: Multi-frame consensus detector across video frames.

### Low-Level Utilities
- `cleanFrame(bgSource, imageData, width, height, baseBox, options)`: In-place frame restoration with sub-pixel ROI bounds and calibrated gain.
- `removeWatermark(imageData, alphaMap, position, options)`: Core algebraic inversion loop.
- `calculateAlphaMap(bgCaptureImageData)`: Normalizes channel values into float alpha weights.
- `getDefaultWatermarkInfo(width, height)`: Mathematical placement heuristic.

---

## 📄 License

MIT © [GAURAVLABS](https://gauravlabs.com)
