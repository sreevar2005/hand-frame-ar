// Starts/stops the webcam. Video stays in the browser: nothing is recorded or uploaded.

export async function startCamera(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const err = new Error('insecure');
    err.name = 'InsecureContextError';
    throw err;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  return stream;
}

export function stopCamera(video, stream) {
  stream?.getTracks().forEach((t) => t.stop());
  video.pause();
  video.srcObject = null;
}

export function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was blocked. Click the camera icon in the address bar, allow access, then press Start again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found. Plug in a webcam and press Start again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy in another app (Zoom, Teams, Camera…). Close it and press Start again.';
    case 'OverconstrainedError':
      return 'Your camera does not support the requested settings.';
    case 'InsecureContextError':
    case 'SecurityError':
      return 'Camera needs a secure page. Open the app at http://localhost:5173 (via "npm run dev"), not as a file.';
    default:
      return `Could not start the camera: ${err?.message || err}`;
  }
}
