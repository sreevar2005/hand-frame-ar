// Thin wrapper around MediaPipe Hand Landmarker. Everything runs locally:
// the wasm runtime and model are served from this project's public/ folder.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;

let visionPromise = null;
/** Shared wasm runtime for all MediaPipe tasks. */
export function getVision() {
  visionPromise ??= FilesetResolver.forVisionTasks(`${BASE}wasm`);
  return visionPromise;
}

export async function createHandTracker() {
  const vision = await getVision();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${BASE}models/hand_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await HandLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU.', err);
    return HandLandmarker.createFromOptions(vision, options('CPU'));
  }
}

/**
 * Runs detection on the current video frame and returns hands as arrays of
 * 21 points in *display* coordinates: normalized 0..1 and mirrored
 * horizontally so they match the selfie-style video on screen.
 */
export function detectHands(landmarker, video, timestampMs) {
  const result = landmarker.detectForVideo(video, timestampMs);
  return (result.landmarks || []).map((hand) => hand.map((p) => ({ x: 1 - p.x, y: p.y })));
}
