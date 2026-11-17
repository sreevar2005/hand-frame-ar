// MediaPipe Face Landmarker (478 points per face), run locally like the hand tracker.
import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import { getVision } from './handTracker.js';

const BASE = import.meta.env.BASE_URL;

/** mode: 'VIDEO' for the live webcam, 'IMAGE' for a still photo. */
export async function createFaceTracker(mode = 'VIDEO') {
  const vision = await getVision();
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${BASE}models/face_landmarker.task`, delegate },
    runningMode: mode,
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await FaceLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable for faces, falling back to CPU.', err);
    return FaceLandmarker.createFromOptions(vision, options('CPU'));
  }
}

/** Person segmenter, used once on the face photo to cut the head/hair out of its background. */
export async function createPersonSegmenter() {
  const vision = await getVision();
  return ImageSegmenter.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${BASE}models/selfie_segmenter.tflite`, delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

/** Live face landmarks in mirrored, normalized display coords, or null. */
export function detectFace(landmarker, video, timestampMs) {
  const result = landmarker.detectForVideo(video, timestampMs);
  const face = result.faceLandmarks?.[0];
  return face ? face.map((p) => ({ x: 1 - p.x, y: p.y })) : null;
}

/** Ordered list of landmark indices that trace the outline of the face. */
export const FACE_OVAL = (() => {
  const edges = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;
  const next = new Map(edges.map((e) => [e.start, e.end]));
  const order = [edges[0].start];
  while (order.length < edges.length) {
    const n = next.get(order[order.length - 1]);
    if (n === undefined || n === order[0]) break;
    order.push(n);
  }
  return order;
})();
