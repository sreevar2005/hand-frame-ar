# Hand Frame AR

A local webcam prototype: frame a scene with both hands (an "L" with each hand) and an animated portal appears inside the opening, following your hands as they move.

- Runs entirely in your browser. Video is never recorded or uploaded.
- Hand tracking: [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) (open source), served from this project.
- No paid services, no API keys.

## Install & run

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Edge, click **Start camera**, and allow camera access.

`npm install` also runs `npm run setup`, which copies MediaPipe's wasm runtime into `public/wasm` and downloads the hand model (~7.5 MB) into `public/models` once. After that the app works offline. If the download fails, run `npm run setup` again.

## How to use

1. Hold up both hands, palms toward the camera.
2. Make an **L** with each hand: index finger up, thumb pointing toward the other hand.
3. Spread your hands apart. When it says **Frame detected ✓** the portal appears.
4. **Face filter:** click **Load face photo…** and pick a clear, front-facing photo. When you frame your face with your hands, your face turns into the photo's face, but only inside the frame. **Whole head (hair too)** (on by default) also brings the photo's hair and headphones/accessories; untick it for face only. If the image has no real face (a mask, helmet or cartoon), it's used as a **mask** instead: its background is cut away, and the first time you look straight at the camera it's fitted to your face shape. After that it wraps and turns with your head like the face filter, and a **Mask size** slider fine-tunes it. Both face filter and mask are shaded with your room's real lighting (a blurred light map from the camera), so they look worn rather than pasted on. Use photos of yourself or of people who agreed, and keep third-party character art to personal, local use.
5. **Character window** (closest to the Instagram-style reference): click **Load character picture…** and pick a front-facing picture of a character, ideally head and shoulders with a background. If the character's face can't be read automatically (masks, cartoons), click its two eyes and the bottom of its chin when asked (that sets the size, so the character's head matches yours). The hand frame then becomes a window onto that picture, lined up so the character's eyes sit on yours: frame your face to see the mask, move the frame down to see the costume. **Size**, **Up / down** and **Re-pick eyes & chin** fine-tune the alignment.
6. Optional: **Load image/video…** plays a file from your computer inside the frame (it stays local).
7. **Show hand points** draws the tracked landmarks to help with debugging.

## How it works

| File | Role |
|---|---|
| `src/camera.js` | Start/stop webcam, friendly permission errors |
| `src/handTracker.js` | MediaPipe setup (GPU, CPU fallback); returns mirrored landmarks |
| `src/frameDetector.js` | Thumb tip + index tip of each hand → 4 corners; checks the hands make L shapes, are far enough apart and form a convex quad |
| `src/smoother.js` | Adaptive smoothing of the corners to remove jitter |
| `src/homography.js` | Perspective transform → CSS `matrix3d` so the effect canvas is warped exactly onto the hand frame |
| `src/faceTracker.js` | MediaPipe Face Landmarker (478 points) and selfie segmenter (cuts the photo's head out of its background), loaded only when a face photo is chosen |
| `src/effects/` | `webBurst.js` (original shapes/particles portal), `faceSwap.js` (photo face mapped onto your live face, ~900 triangles warped per frame, feathered edge, brightness matched), `clipEffect.js` (your own file) |
| `src/effects/characterWindow.js`, `src/alignDialog.js` | Character window: picture moved/scaled so its eyes follow yours (heavily smoothed), shown only inside the frame; eye-picking dialog for cartoon characters |
| `src/main.js` | Main loop, lock-on/release logic, status messages |

Tuning: thresholds are in `LIMITS` in `src/frameDetector.js`; lock/release timing is `LOCK_FRAMES` / `RELEASE_FRAMES` in `src/main.js`.

## Limitations

- This is a browser webcam prototype, **not** an Instagram/Spark AR filter, and can't be published as one.
- Needs decent lighting and both hands fully in view; overlapping or crossed hands confuse tracking.
- The portal is drawn over your hands (no hand segmentation/occlusion).
- Face filter: the photo's eyes and mouth replace yours, so blinks and an open mouth don't show through. Skin tone is only matched for brightness, and turning your head far to the side stretches the photo. In whole-head mode, your own hair can peek out where it's bigger than the photo's, and dark hair on a dark photo background may leave a slight smudge at the edge.
- The camera only works on `localhost` or HTTPS. Opening `index.html` directly as a file won't work.
- The built-in animation is an original placeholder; no Spider-Man (or other copyrighted) characters or assets are included.
