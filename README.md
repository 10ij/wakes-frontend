# wakes

**wakes** is an offline-capable, mobile-first Progressive Web App built for iPhone to scan folded, single-page books one photo at a time, automatically detect page corners and flatten perspective in natural color, persist every scan safely in IndexedDB across iOS tab reloads, and export high-resolution multi-page PDFs.

## Features

- **Native iPhone Camera + Strict Processing Lock**: Uses `<input type="file" accept="image/*" capture="environment">` and locks capture immediately until the page is processed and committed to IndexedDB.
- **WASM-Only Client-Side ML (`DocAligner`)**: Runs `docaligner-lcnet100.onnx` (Apache-2.0, bundled locally at `/models/docaligner-lcnet100.onnx`) inside a dedicated Web Worker using `onnxruntime-web/wasm` with local `/ort/ort-wasm-simd-threaded.wasm` (zero CDN requests).
- **v1 Flat Perspective Correction**: Applies a 4-point homography warp into a natural-color ~2400px JPEG (`quality 0.88`). Low-confidence shots automatically open a touch-friendly 4-corner drag overlay with a zoomed magnifier loupe; confident auto-crops save immediately and offer a brief **Adjust corners** toast.
- **iOS WebKit Memory Hygiene**: Parses JPEG SOF dimensions and EXIF Orientation from the first 64 KB before decoding, passes a single axis resize option (`resizeWidth` or `resizeHeight` capped at 2600px) so portrait shots stay upright, immediately closes `ImageBitmap`s, zeros temporary canvases, disposes ONNX tensors, and keeps `draftSource` strictly in IndexedDB.
- **IndexedDB Persistence & Two-Step PDF Export**: Survives iOS background reloads and screen locks (`navigator.storage.persist()`). Exports matched-aspect-ratio PDFs sequentially via `pdf-lib` (`embedJpg`), building the PDF first and then presenting a fresh **Share PDF** tap for the iOS Share Sheet.
- **Screen Wake Lock & Offline PWA**: Keeps the screen awake during active scanning (`visibilitychange` re-acquire on camera return), precaches app + WASM + ONNX model via `vite-plugin-pwa`, and prompts cleanly when a new app version is ready.

## Development & Verification

```bash
npm install
npm run lint     # runs tsc --noEmit
npm run build    # production build + Workbox service worker precache
```

## Testing on iPhone (HTTPS Required)

iOS Safari requires **HTTPS** (a trusted certificate, or `localhost` on simulator) for:
1. **Service Worker & Offline Cache** (airplane mode scanning)
2. **Add to Home Screen** (`standalone` PWA installation)
3. **Screen Wake Lock** (`navigator.wakeLock.request('screen')`)

To test from a physical iPhone during local development:
1. Run `npm run build && npm run preview -- --host` (or `npm run dev`) behind an HTTPS tunnel (e.g., Cloudflare Tunnel, ngrok, Tailscale Funnel, or your hosted HTTPS preview URL).
2. Open the `https://` URL in **Safari** on iPhone.
3. Tap **Share → Add to Home Screen** (or tap the in-app **Install** button for guided steps), launch **wakes** from the Home Screen, and optionally toggle Airplane Mode to confirm 100% offline scanning and PDF export.

## License & Model Attribution

- **DocAligner (`docaligner-lcnet100.onnx`)**: Copyright DocsaidLab (`github.com/DocsaidLab/DocAligner`), licensed under **Apache-2.0** (see `public/models/LICENSE-DocAligner.txt` and `public/models/NOTICE.txt`).
