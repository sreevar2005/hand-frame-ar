import { startCamera, stopCamera, describeCameraError } from './camera.js';
import { createHandTracker, detectHands } from './handTracker.js';
import { detectFrame } from './frameDetector.js';
import { QuadSmoother } from './smoother.js';
import { homography, toCssMatrix3d } from './homography.js';
import { WebBurst } from './effects/webBurst.js';
import { ClipEffect } from './effects/clipEffect.js';
import { FaceSwap } from './effects/faceSwap.js';
import { createFaceTracker, createPersonSegmenter, detectFace } from './faceTracker.js';
import { CharacterWindow } from './effects/characterWindow.js';
import { pickEyes } from './alignDialog.js';

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('toggle'),
  status: $('status'),
  stage: $('stage'),
  video: $('video'),
  effect: $('effect'),
  overlay: $('overlay'),
  placeholder: $('placeholder'),
  fps: $('fps'),
  showPoints: $('showPoints'),
  clipFile: $('clipFile'),
  clipRadio: $('clipRadio'),
  faceFile: $('faceFile'),
  faceRadio: $('faceRadio'),
  faceLayer: $('faceLayer'),
  wholeHead: $('wholeHead'),
  maskSize: $('maskSize'),
  maskSizeLabel: $('maskSizeLabel'),
  windowFile: $('windowFile'),
  windowRadio: $('windowRadio'),
  windowControls: $('windowControls'),
  windowSize: $('windowSize'),
  windowOffset: $('windowOffset'),
  realign: $('realign'),
};

els.windowSize.addEventListener('input', () => {
  charWindow.size = Number(els.windowSize.value);
});
els.windowOffset.addEventListener('input', () => {
  charWindow.offsetY = Number(els.windowOffset.value);
});

els.maskSize.addEventListener('input', () => {
  faceSwap.setMaskSize(Number(els.maskSize.value));
});

els.wholeHead.addEventListener('change', () => {
  faceSwap.mode = els.wholeHead.checked ? 'head' : 'face';
});

// Frames needed to lock on / let go — prevents flicker.
const LOCK_FRAMES = 3;
const RELEASE_FRAMES = 8;

const effectCtx = els.effect.getContext('2d');
const overlayCtx = els.overlay.getContext('2d');
const EW = els.effect.width;
const EH = els.effect.height;
const SRC_RECT = [[0, 0], [EW, 0], [EW, EH], [0, EH]];

const faceCtx = els.faceLayer.getContext('2d');

const webBurst = new WebBurst(EW, EH);
const clipEffect = new ClipEffect(EW, EH);
const faceSwap = new FaceSwap();
const charWindow = new CharacterWindow();
let activeEffect = webBurst;
const usesFace = () => activeEffect === faceSwap || activeEffect === charWindow;

// Face filter state (models load only when a face photo is first chosen).
let faceVideoTracker = null;
let faceImageTracker = null;
let personSegmenter = null;
let liveFace = null; // smoothed live face landmarks
let faceFrames = 0;

let landmarker = null;
let stream = null;
let running = false;
let starting = false;
let rafId = 0;
let lastVideoTime = -1;

let hands = [];
let detection = { state: 'no-hands' };
let hits = 0;
let misses = 0;
let locked = false;
let opacity = 0;
const smoother = new QuadSmoother();

let trackTick = 0;
let displayQuad = null; // what is drawn: glides toward the latest tracked frame every screen refresh
let fpsFrames = 0;
let fpsLast = performance.now();

// ---------- status ----------

const MESSAGES = {
  'no-hands': ['Show both hands', 'hint'],
  'one-hand': ['Show your other hand too', 'hint'],
  'not-l': ['Make an L with each hand: index up, thumb pointing in', 'hint'],
  'too-close': ['Spread your hands apart to open the frame', 'hint'],
  frame: ['Hold it…', 'hint'],
};

let lastStatus = '';
function setStatus(text, kind = 'idle') {
  const key = `${kind}|${text}`;
  if (key === lastStatus) return;
  lastStatus = key;
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// ---------- start / stop ----------

async function start() {
  if (starting || running) return;
  starting = true;
  els.toggle.disabled = true;
  try {
    if (!landmarker) {
      setStatus('Loading hand tracking model…', 'idle');
      try {
        landmarker = await createHandTracker();
      } catch (err) {
        console.error(err);
        setStatus('Could not load the hand tracking model. Run "npm run setup" and reload the page.', 'error');
        return;
      }
    }
    setStatus('Requesting camera access…', 'idle');
    try {
      stream = await startCamera(els.video);
    } catch (err) {
      console.error(err);
      setStatus(describeCameraError(err), 'error');
      return;
    }
    // If the camera is unplugged or revoked while running.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stop();
      setStatus('The camera stopped (unplugged or access revoked). Press Start to try again.', 'error');
    });

    els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
    els.placeholder.style.display = 'none';
    running = true;
    lastVideoTime = -1;
    els.toggle.textContent = 'Stop camera';
    els.toggle.classList.add('stop');
    setStatus('Show both hands', 'hint');
    rafId = requestAnimationFrame(loop);
  } finally {
    starting = false;
    els.toggle.disabled = false;
  }
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
  stopCamera(els.video, stream);
  stream = null;
  hands = [];
  detection = { state: 'no-hands' };
  hits = misses = 0;
  locked = false;
  opacity = 0;
  smoother.reset();
  liveFace = null;
  els.effect.style.display = 'none';
  overlayCtx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  faceCtx.clearRect(0, 0, els.faceLayer.width, els.faceLayer.height);
  els.placeholder.style.display = '';
  els.fps.textContent = '';
  els.toggle.textContent = 'Start camera';
  els.toggle.classList.remove('stop');
  setStatus('Camera off. Click “Start camera” to begin', 'idle');
}

els.toggle.addEventListener('click', () => (running ? stop() : start()));

// ---------- effect selection ----------

function selectEffect(value) {
  if (value === 'clip' && clipEffect.ready) activeEffect = clipEffect;
  else if (value === 'face' && faceSwap.ready) activeEffect = faceSwap;
  else if (value === 'window' && charWindow.ready) activeEffect = charWindow;
  else activeEffect = webBurst;
  els.windowControls.hidden = activeEffect !== charWindow;
  liveFace = null;
}

els.windowFile.addEventListener('change', async () => {
  const file = els.windowFile.files?.[0];
  els.windowFile.value = '';
  if (!file) return;
  try {
    setStatus('Loading face model and reading the picture…', 'idle');
    faceImageTracker ??= await createFaceTracker('IMAGE');
    faceVideoTracker ??= await createFaceTracker('VIDEO');
    const kind = await charWindow.load(file, faceImageTracker);
    if (kind === 'needs-align') {
      const eyes = await pickEyes(charWindow.raw);
      if (!eyes) {
        setStatus('Cancelled — the character window needs the eyes picked to line up with you.', 'hint');
        return;
      }
      charWindow.setAnchors(...eyes);
    }
    els.windowRadio.disabled = false;
    els.windowRadio.checked = true;
    selectEffect('window');
    setStatus(`Character ready — ${running ? 'frame yourself with your hands' : 'click “Start camera”'}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(err.message || `Could not use that picture: ${err}`, 'error');
  }
});

els.realign.addEventListener('click', async () => {
  if (!charWindow.raw) return;
  const eyes = await pickEyes(charWindow.raw);
  if (eyes) charWindow.setAnchors(...eyes);
});

document.querySelectorAll('input[name="effect"]').forEach((radio) =>
  radio.addEventListener('change', () => selectEffect(radio.value)),
);

els.faceFile.addEventListener('change', async () => {
  const file = els.faceFile.files?.[0];
  els.faceFile.value = '';
  if (!file) return;
  const prevStatus = els.status.textContent;
  try {
    setStatus('Loading face model and reading your photo…', 'idle');
    faceImageTracker ??= await createFaceTracker('IMAGE');
    faceVideoTracker ??= await createFaceTracker('VIDEO');
    if (!personSegmenter) {
      try {
        personSegmenter = await createPersonSegmenter();
      } catch (err) {
        console.warn('Person segmenter unavailable; whole-head mode will include the photo background.', err);
      }
    }
    const kind = await faceSwap.load(file, faceImageTracker, personSegmenter);
    els.faceRadio.disabled = false;
    els.faceRadio.checked = true;
    els.maskSizeLabel.hidden = kind !== 'mask';
    selectEffect('face');
    const what = kind === 'mask' ? 'No real face found, so it will be worn as a mask. Look straight at the camera for a moment so it can fit to your face (“Mask size” fine-tunes it)' : 'Face photo ready';
    setStatus(`${what} — ${running ? 'frame your face with your hands' : 'click “Start camera”'}`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(err.message || `Could not use that photo: ${err}`, 'error');
    if (!faceSwap.ready) setTimeout(() => setStatus(prevStatus, 'idle'), 4000);
  }
});

els.clipFile.addEventListener('change', async () => {
  const file = els.clipFile.files?.[0];
  if (!file) return;
  try {
    await clipEffect.load(file);
    els.clipRadio.disabled = false;
    els.clipRadio.checked = true;
    activeEffect = clipEffect;
  } catch (err) {
    console.error(err);
    setStatus(`Could not open that file: ${err.message}`, 'error');
  }
  els.clipFile.value = '';
});

// ---------- main loop ----------

function track(now) {
  const video = els.video;
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  // When the face is also needed, run the hand and face models on alternate
  // camera frames instead of both every frame. Each still updates ~15x/sec,
  // but the page stays smooth, and the render loop glides between updates.
  const faceMode = usesFace() && faceVideoTracker;
  const faceTurn = faceMode && (locked || hits > 0) && trackTick++ % 2 === 1;

  if (!faceTurn) {
    try {
      hands = detectHands(landmarker, video, now);
    } catch (err) {
      console.error(err);
      return;
    }
    detection = detectFrame(hands, video.videoWidth / video.videoHeight);

    if (detection.state === 'frame') {
      hits++;
      misses = 0;
      smoother.update(detection.quad);
      if (!locked && hits >= LOCK_FRAMES) {
        locked = true;
        activeEffect.burst();
      }
    } else {
      hits = 0;
      misses++;
      if (locked && misses > RELEASE_FRAMES) {
        locked = false;
      }
    }
    countFps(now);
  }

  // Face: tracked only while a frame is (nearly) active.
  if (faceTurn) {
    try {
      const face = detectFace(faceVideoTracker, video, now);
      if (!face) liveFace = null;
      else if (!liveFace) liveFace = face;
      else {
        // Adaptive smoothing: hold still -> heavy smoothing (no shimmer);
        // move fast -> follow immediately (no lag). Speed is measured on the
        // whole face so all points move together.
        let speed = 0;
        for (let i = 0; i < face.length; i += 10) {
          speed += Math.hypot(face[i].x - liveFace[i].x, face[i].y - liveFace[i].y);
        }
        speed /= Math.ceil(face.length / 10);
        const alpha = Math.min(1, 0.22 + speed * 40);
        for (let i = 0; i < face.length; i++) {
          liveFace[i].x += (face[i].x - liveFace[i].x) * alpha;
          liveFace[i].y += (face[i].y - liveFace[i].y) * alpha;
        }
      }
      if (activeEffect === faceSwap && liveFace && faceFrames++ % 10 === 0) faceSwap.updateLighting(video, liveFace);
    } catch (err) {
      console.error(err);
    }
  } else if (!locked) {
    liveFace = null;
  }

  if (locked && faceMode && !liveFace) setStatus('Frame detected ✓ — bring your face into view', 'ok');
  else if (locked) setStatus('Frame detected ✓', 'ok');
  else setStatus(...MESSAGES[detection.state]);
}

function countFps(now) {
  fpsFrames++;
  if (now - fpsLast >= 1000) {
    // Debug readout: only shown with "Show hand points", so it never spoils the effect.
    els.fps.textContent = els.showPoints.checked ? `${Math.round((fpsFrames * 1000) / (now - fpsLast))} fps hand tracking` : '';
    fpsFrames = 0;
    fpsLast = now;
  }
}

function resizeOverlay(W, H) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  for (const c of [els.overlay, els.faceLayer]) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  faceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

function drawGlowBorder(dst) {
  overlayCtx.save();
  overlayCtx.globalAlpha = opacity;
  overlayCtx.strokeStyle = '#ff7ab8';
  overlayCtx.lineWidth = 3;
  overlayCtx.lineJoin = 'round';
  overlayCtx.shadowColor = '#ff3d8b';
  overlayCtx.shadowBlur = 18;
  overlayCtx.beginPath();
  dst.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
  overlayCtx.closePath();
  overlayCtx.stroke();
  overlayCtx.restore();
}

function drawHandPoints(W, H) {
  const BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  for (const hand of hands) {
    overlayCtx.strokeStyle = 'rgba(63,214,255,0.8)';
    overlayCtx.lineWidth = 2;
    for (const [a, b] of BONES) {
      overlayCtx.beginPath();
      overlayCtx.moveTo(hand[a].x * W, hand[a].y * H);
      overlayCtx.lineTo(hand[b].x * W, hand[b].y * H);
      overlayCtx.stroke();
    }
    hand.forEach((p, i) => {
      overlayCtx.fillStyle = i === 4 || i === 8 ? '#ff3d8b' : '#fff';
      overlayCtx.beginPath();
      overlayCtx.arc(p.x * W, p.y * H, i === 4 || i === 8 ? 6 : 3, 0, Math.PI * 2);
      overlayCtx.fill();
    });
  }
}

function render(now) {
  const W = els.stage.clientWidth;
  const H = els.stage.clientHeight;
  const dpr = resizeOverlay(W, H);
  overlayCtx.clearRect(0, 0, W, H);
  faceCtx.clearRect(0, 0, W, H);

  // Quick fades: a slow fade leaves a half-transparent "ghost" of you showing through.
  opacity += ((locked ? 1 : 0) - opacity) * 0.35;

  // Glide the drawn frame toward the tracked one on every screen refresh,
  // so the window moves smoothly between tracking updates.
  const target = smoother.quad;
  if (!target) displayQuad = null;
  else if (!displayQuad) displayQuad = target.map((p) => ({ x: p.x, y: p.y }));
  else {
    for (let i = 0; i < 4; i++) {
      displayQuad[i].x += (target[i].x - displayQuad[i].x) * 0.45;
      displayQuad[i].y += (target[i].y - displayQuad[i].y) * 0.45;
    }
  }
  const quad = displayQuad;

  if (quad && opacity > 0.02) {
    const dst = quad.map((p) => [p.x * W, p.y * H]);
    if (activeEffect === charWindow) {
      // Character window: the frame reveals the character picture lined up with you.
      els.effect.style.display = 'none';
      charWindow.update(liveFace, W, H);
      faceCtx.save();
      faceCtx.beginPath();
      dst.forEach(([x, y], i) => (i ? faceCtx.lineTo(x, y) : faceCtx.moveTo(x, y)));
      faceCtx.closePath();
      faceCtx.clip();
      faceCtx.globalAlpha = opacity;
      charWindow.draw(faceCtx, W, H, dpr);
      faceCtx.restore();
      // No glow border here: clean window edges, like the reference.
    } else if (activeEffect === faceSwap) {
      // Face filter: live video stays visible; only the face inside the frame changes.
      els.effect.style.display = 'none';
      if (liveFace) {
        faceCtx.save();
        faceCtx.beginPath();
        dst.forEach(([x, y], i) => (i ? faceCtx.lineTo(x, y) : faceCtx.moveTo(x, y)));
        faceCtx.closePath();
        faceCtx.clip();
        faceCtx.globalAlpha = opacity;
        faceSwap.draw(faceCtx, liveFace, W, H, dpr, els.video);
        faceCtx.restore();
      }
      drawGlowBorder(dst);
    } else {
      const h = homography(SRC_RECT, dst);
      if (h) {
        activeEffect.draw(effectCtx, now / 1000);
        els.effect.style.transform = toCssMatrix3d(h);
        els.effect.style.opacity = opacity.toFixed(3);
        els.effect.style.display = 'block';
        drawGlowBorder(dst);
      }
    }
  } else {
    els.effect.style.display = 'none';
    // Forget the old position once fully faded out, so the next frame starts fresh.
    if (!locked) smoother.reset();
  }

  if (els.showPoints.checked) drawHandPoints(W, H);
}

function loop(now) {
  if (!running) return;
  track(now);
  render(now);
  rafId = requestAnimationFrame(loop);
}

// Release the camera when the tab is closed.
window.addEventListener('pagehide', () => running && stop());
