// Copies MediaPipe's WebAssembly runtime into public/ and downloads the hand
// landmark model once, so the app runs fully offline afterwards.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDest = join(root, 'public', 'wasm');
const modelDir = join(root, 'public', 'models');
const MODELS = [
  {
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
];

if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, wasmDest, { recursive: true });
  console.log('[setup] Copied MediaPipe wasm files to public/wasm');
} else {
  console.warn('[setup] @mediapipe/tasks-vision not installed yet; skipping wasm copy.');
}

mkdirSync(modelDir, { recursive: true });
for (const { file, url } of MODELS) {
  const path = join(modelDir, file);
  if (existsSync(path)) {
    console.log(`[setup] ${file} already present.`);
    continue;
  }
  try {
    console.log(`[setup] Downloading ${file} (one time)...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    console.log(`[setup] Saved public/models/${file}`);
  } catch (err) {
    console.warn(`[setup] Could not download ${file} (${err.message}).`);
    console.warn(`[setup] Download it manually from:\n  ${url}\n  and save it as public/models/${file}`);
  }
}
