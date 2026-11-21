# wakes

**A little book scanner that lives in your browser.**

wakes is an offline-first, mobile-first web app built for iPhone. It scans books one folded page at a time, automatically detects page corners, corrects perspective and saves everything locally. When you're finished, export the entire scan as a high-resolution, multi-page PDF.

No account, no adverts, no subscription, no unnecessary app installation. Just a scanner that does what you need it to.

Written for, and tested only on, my iPhone 16 Pro

## Why?

No need to download an app, no need to download an adblocker on my phone, no need to have my personal images uploaded abroad to someone else's hardware, no need to suffer through an ugly ui

## Features

- **Point, shoot, done.** Uses your iPhone's rear camera to capture individual book pages. Processing is locked until each page has been saved, so you don't accidentally lose a scan by rushing ahead.
- **Automatic page detection.** Uses DocAligner, running locally through ONNX Runtime and WebAssembly, to detect all four page corners and correct perspective.
- **Natural colour.** Keeps scans in colour rather than aggressively converting everything to black and white.
- **Manual correction.** Less confident detections let you adjust the four corners yourself, with a magnifying loupe to help get things right.
- **Your scans stay yours.** Pages are stored in IndexedDB, not uploaded to a server. They're reloaded automatically if iOS suspends or reloads the browser tab.
- **One PDF, however many pages.** Export your scans as a multi-page PDF, with each page retaining its proportions.
- **Actually works offline.** The application, processing engine and ML model are bundled locally and precached for offline use.
- **Keeps your screen awake.** Screen Wake Lock prevents your iPhone from going to sleep halfway through a scanning session, where supported.
- **Import existing photos.** Already taken the photographs? Import them directly from your library instead.

## Under the hood

| Component | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| Document detection | DocAligner LCNet100 |
| ML inference | ONNX Runtime Web |
| Processing | WebAssembly + dedicated Web Worker |
| Image correction | Four-point perspective transformation |
| Local storage | IndexedDB |
| PDF generation | pdf-lib |
| Offline support | Service Worker + Workbox |
| Installation | Progressive Web App |

### Image processing

The original photograph is decoded with its EXIF orientation taken into account, then resized to a maximum dimension of 2600px to keep memory usage manageable on iOS.

DocAligner receives a 256 × 256 input and predicts the four page corners. Those coordinates are used to calculate a perspective transformation, producing a flattened image at approximately 2400px on its longest side.

The result is encoded as a JPEG at 88% quality and committed to IndexedDB.

Everything happens on the device. No remote inference API, no image uploads and no server required.

### A few iOS considerations

iOS WebKit can be rather aggressive with memory, especially when working with large photographs.

wakes takes a few precautions:

- Reads JPEG dimensions and EXIF orientation before decoding.
- Uses a single-axis resize to preserve image proportions.
- Closes temporary ImageBitmaps as soon as they're no longer needed.
- Clears temporary canvas contents.
- Disposes ONNX tensors after inference.
- Keeps draft image data in IndexedDB rather than relying on in-memory state.

## Performance & Device Stats

Tested on an **Apple iPhone 16 Pro**.

### Device specifications

| Specification | Details |
|---|---|
| Device | iPhone 16 Pro |
| Processor | Apple A18 Pro |
| CPU | 6-core CPU |
| GPU | 6-core GPU |
| Neural Engine | 16-core Neural Engine |
| Main camera | 48MP Fusion camera |
| Display | 6.3" Super Retina XDR OLED |
| Operating system | iOS |

### Processing performance

Actual timings recorded from wakes' verbose processing logs.

| Operation | Observed time |
|---|---:|
| Initial ONNX Runtime initialisation | 8.12 seconds |
| Subsequent image decoding | ~117 ms |
| ONNX/WASM inference | ~60 ms |
| Perspective correction | ~40 ms |
| JPEG encoding | ~40 ms |
| IndexedDB commit | ~6 ms |
| **Total subsequent processing** | **~265 ms** |

The first scan takes considerably longer because ONNX Runtime needs to initialise and load the model. Once ready, subsequent scans take approximately a quarter of a second to process and save.

### Image output

| Measurement | Observed |
|---|---:|
| Original photograph | 4032 × 3024 |
| Processing resolution | 1950 × 2600 |
| ML input | 256 × 256 |
| Target output height | 2400px |
| Typical output width | 1679–1739px |
| JPEG quality | 88% |
| Output file size | ~0.98–1.10 MB |

*These are observed results from a small number of captures, not controlled benchmarks. Actual performance will vary depending on image complexity, device conditions and browser state.*

## Getting started

You'll need Node.js and npm.

```bash
git clone https://github.com/10ij/wakes-frontend.git
cd wakes-frontend

npm install
npm run dev
```

For a production build:

```bash
npm run lint
npm run build
npm run preview
```

`npm run lint` runs the TypeScript compiler without emitting files.

## Using it on iPhone

For the full experience, wakes needs to run over HTTPS. This is required for service workers, PWA installation and Screen Wake Lock.

1. Host the application somewhere accessible over HTTPS.
2. Open the URL in Safari on your iPhone.
3. Use **Share → Add to Home Screen** to install wakes.
4. Open it from your Home Screen.
5. Start scanning.

For local development, you can expose the development or preview server through Cloudflare Tunnel, ngrok or Tailscale Funnel.

Once installed and cached, try enabling Airplane Mode. Scanning, processing, saving and PDF export should all continue to work.

## Credits & licensing

Document detection is powered by [DocAligner](https://github.com/DocsaidLab/DocAligner), specifically `docaligner-lcnet100.onnx`.

The model is distributed under the Apache License 2.0. See `public/models/LICENSE-DocAligner.txt` and `public/models/NOTICE.txt` for the original licence and attribution.

Other dependencies retain their respective licences.

---

*Built to solve a small, rather annoying problem. Turns out a book scanner doesn't need to be complicated.*
