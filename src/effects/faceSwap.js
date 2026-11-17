// Face filter: maps the face (or whole head) from a photo onto your live face.
//
// 1. Once per photo: find the 478 face landmarks, add two extra rings of
//    points around the face (to reach the hair, ears and headphones), cut the
//    person out of the photo's background with a segmentation model, and split
//    everything into triangles (Delaunay triangulation).
// 2. Every frame: find the same landmarks on your live face, build the same
//    rings, and stretch each photo triangle onto the matching live triangle
//    (one affine transform per triangle). The photo follows your head, jaw
//    and expressions.
// 3. Mask: "head" mode keeps the cut-out head (hair included); "face" mode
//    keeps only the face oval. Edges are softened slightly.
// The caller clips the result to the hand frame.

import Delaunator from 'delaunator';
import { FACE_OVAL } from '../faceTracker.js';

const MAX_PHOTO_SIZE = 1024;
const MESH_POINTS = 468; // skip the 10 iris points
const FOREHEAD = 10;
const CHIN = 152;

// Extra rings around the face. side: sideways scale; up: scale above the
// face centre (hair needs more room); down: scale below it (neck).
// Below the face centre the sideways spread fades out toward the chin, so the
// photo's neck/collar never gets stretched over yours.
const RINGS = [
  { side: 1.3, up: 1.55, down: 1.0 },
  { side: 1.75, up: 2.3, down: 1.0 },
];

/** Affine transform taking triangle s (3 [x,y]) to triangle d. Returns [a,b,c,d,e,f] or null. */
export function triangleAffine(s, d) {
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const [[u0, v0], [u1, v1], [u2, v2]] = d;
  const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0;
  if (Math.abs(den) < 1e-9) return null;
  const a = -(y0 * (u2 - u1) - y1 * u2 + y2 * u1 + (y1 - y2) * u0) / den;
  const b = -(y0 * (v2 - v1) - y1 * v2 + y2 * v1 + (y1 - y2) * v0) / den;
  const c = (x0 * (u2 - u1) - x1 * u2 + x2 * u1 + (x1 - x2) * u0) / den;
  const dd = (x0 * (v2 - v1) - x1 * v2 + x2 * v1 + (x1 - x2) * v0) / den;
  const e = (x0 * (y2 * u1 - y1 * u2) + y0 * (x1 * u2 - x2 * u1) + (x2 * y1 - x1 * y2) * u0) / den;
  const f = (x0 * (y2 * v1 - y1 * v2) + y0 * (x1 * v2 - x2 * v1) + (x2 * y1 - x1 * y2) * v0) / den;
  return [a, b, c, dd, e, f];
}

/**
 * Adds two rings of points around the face oval, oriented by the head's own
 * up direction (forehead minus chin), so they rotate and scale with the head.
 * Applied identically to photo and live points, so they correspond.
 */
function withHeadRings(pts) {
  const oval = FACE_OVAL.map((i) => pts[i]);
  const cx = oval.reduce((s, p) => s + p[0], 0) / oval.length;
  const cy = oval.reduce((s, p) => s + p[1], 0) / oval.length;
  let ux = pts[FOREHEAD][0] - pts[CHIN][0];
  let uy = pts[FOREHEAD][1] - pts[CHIN][1];
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  const sx = -uy; // sideways axis
  const sy = ux;
  let maxDown = 1e-6;
  for (const [px, py] of oval) maxDown = Math.max(maxDown, -((px - cx) * ux + (py - cy) * uy));
  const out = pts.slice();
  for (const ring of RINGS) {
    for (const [px, py] of oval) {
      const dx = px - cx;
      const dy = py - cy;
      const along = dx * ux + dy * uy;
      const side = dx * sx + dy * sy;
      const ka = along >= 0 ? ring.up : ring.down;
      // Full sideways spread at eye level and above, none at the chin.
      const fade = along >= 0 ? 1 : Math.max(0, 1 - (-along / maxDown) * 1.4);
      const ks = 1 + (ring.side - 1) * fade;
      out.push([cx + ux * along * ka + sx * side * ks, cy + uy * along * ka + sy * side * ks]);
    }
  }
  return out;
}

const OUTER_RING_START = MESH_POINTS + FACE_OVAL.length;

function averageLuma(source, sx, sy, sw, sh) {
  const c = (averageLuma.canvas ??= Object.assign(document.createElement('canvas'), { width: 16, height: 16 }));
  const ctx = (averageLuma.ctx ??= c.getContext('2d', { willReadFrequently: true }));
  ctx.clearRect(0, 0, 16, 16);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 16, 16);
  const px = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    n++;
  }
  return n ? sum / n : 128;
}

function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Makes the photo's background transparent using the person segmenter. */
function cutOutPerson(canvas, segmenter, faceBox) {
  const result = segmenter.segment(canvas);
  const mask = result.confidenceMasks?.[0];
  if (!mask) return false;
  const conf = mask.getAsFloat32Array();
  const mw = mask.width;
  const mh = mask.height;

  // Sanity check: the face area should be "person". Some models put the
  // person in the inverted channel; if neither works, skip the cut-out.
  let inside = 0;
  let n = 0;
  for (let y = faceBox.y0 + faceBox.h * 0.3; y < faceBox.y0 + faceBox.h * 0.7; y += faceBox.h / 10) {
    for (let x = faceBox.x0 + faceBox.w * 0.3; x < faceBox.x0 + faceBox.w * 0.7; x += faceBox.w / 10) {
      const mx = Math.min(mw - 1, Math.max(0, Math.round((x / canvas.width) * mw)));
      const my = Math.min(mh - 1, Math.max(0, Math.round((y / canvas.height) * mh)));
      inside += conf[my * mw + mx];
      n++;
    }
  }
  const invert = n && inside / n < 0.5;
  if (invert && 1 - inside / n < 0.5) {
    result.close?.();
    return false;
  }

  const alpha = new ImageData(mw, mh);
  for (let i = 0; i < conf.length; i++) {
    let v = invert ? 1 - conf[i] : conf[i];
    v = Math.min(1, Math.max(0, (v - 0.45) / 0.3)); // pull the edge in slightly: no coloured fringe
    alpha.data[i * 4 + 3] = v * 255;
  }
  result.close?.();

  const mc = Object.assign(document.createElement('canvas'), { width: mw, height: mh });
  mc.getContext('2d').putImageData(alpha, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = `blur(${Math.max(1, canvas.width / 350)}px)`; // smooth, anti-aliased edge
  ctx.drawImage(mc, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  return true;
}

export class FaceSwap {
  constructor() {
    this.photo = null; // canvas holding the (downscaled, cut-out) photo
    this.src = null; // photo points (mesh + head rings) in photo pixels
    this.triangles = null;
    this.photoLuma = 128;
    this.gain = 1;
    this.mode = 'head'; // 'head' (face + hair) or 'face' (face oval only)
    this.maskEyes = null; // set in mask mode (photo without a real face)
    this.maskSize = 1.15;
    this.template = null;
    this.shade = document.createElement('canvas');
    this.shadeCtx = this.shade.getContext('2d');
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d');
    this.flash = 0;
  }

  get ready() {
    return !!this.photo;
  }

  /** True when the photo had no detectable face and is used as a flat mask. */
  get isMask() {
    return !!this.maskEyes;
  }

  /**
   * Mask mode, for images with no real face (masks, helmets, cartoons).
   * Assumes a front-facing head centred in the image, with the eyes at
   * roughly 45% height. The head is cut out with a soft ellipse (plus the
   * person segmenter when it recognises the shape).
   */
  setupMask(canvas, segmenter) {
    const w = canvas.width;
    const h = canvas.height;
    const l = [w * 0.33, h * 0.455];
    const r = [w * 0.67, h * 0.455];
    const eyeDist = r[0] - l[0];
    const headBox = { x0: w * 0.2, y0: h * 0.15, x1: w * 0.8, y1: h * 0.85, w: w * 0.6, h: h * 0.7 };

    if (segmenter) {
      try {
        cutOutPerson(canvas, segmenter, headBox);
      } catch (err) {
        console.warn('Mask cut-out failed; using an oval.', err);
      }
    }

    // Soft oval around the head, so a busy background doesn't fill the frame.
    const ctx = canvas.getContext('2d');
    const cx = (l[0] + r[0]) / 2;
    const cy = l[1] + eyeDist * 0.15;
    const rx = eyeDist * 1.05;
    const ry = eyeDist * 1.5;
    const oval = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const oc = oval.getContext('2d');
    const g = oc.createRadialGradient(0, 0, 0.82, 0, 0, 1);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    oc.setTransform(rx, 0, 0, ry, cx, cy);
    oc.fillStyle = g;
    oc.beginPath();
    oc.arc(0, 0, 1, 0, Math.PI * 2);
    oc.fill();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(oval, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // Measure the mask's head width at eye level, to size it to your face.
    const row = ctx.getImageData(0, Math.round(l[1]), w, 1).data;
    let first = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (row[x * 4 + 3] > 128) {
        if (first < 0) first = x;
        last = x;
      }
    }
    this.maskHeadW = last - first > eyeDist ? last - first : eyeDist * 2;

    this.photo = canvas;
    this.src = null;
    this.triangles = null;
    this.template = null; // built from your face the first time you look straight at the camera
    this.maskEyes = { l, r };
    this.gain = 1;
  }

  /**
   * Mask mode: the mask image has no landmarks of its own, so we create them
   * from YOUR face. The first time you look straight at the camera, your face
   * points are laid onto the mask image (eyes on the mask's eyes, face width
   * matched to the mask's head width). From then on the mask is warped with
   * the same triangle mesh as a real face, so it curves and turns with you.
   */
  tryBuildTemplate(mesh) {
    // Frontal check: nose tip roughly the same distance from both outer eye corners.
    const dl = Math.hypot(mesh[1][0] - mesh[33][0], mesh[1][1] - mesh[33][1]);
    const dr = Math.hypot(mesh[1][0] - mesh[263][0], mesh[1][1] - mesh[263][1]);
    if (Math.abs(dl - dr) / (dl + dr) > 0.08) return false;

    let a = mesh[468] ?? mesh[33];
    let b = mesh[473] ?? mesh[263];
    if (a[0] > b[0]) [a, b] = [b, a];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ax = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]; // face x axis
    const ay = [-ax[1], ax[0]]; // face y axis (down)
    const local = mesh.slice(0, MESH_POINTS).map(([x, y]) => {
      const dx = x - mx;
      const dy = y - my;
      return [dx * ax[0] + dy * ax[1], dx * ay[0] + dy * ay[1]];
    });
    let u0 = Infinity;
    let u1 = -Infinity;
    for (const i of FACE_OVAL) {
      u0 = Math.min(u0, local[i][0]);
      u1 = Math.max(u1, local[i][0]);
    }
    const faceW = u1 - u0 || 1;
    this.template = local.map(([u, v]) => [u / faceW, v / faceW]);
    this.applyTemplate();
    return true;
  }

  /** (Re)computes the mask's mesh points from the template and the size slider. */
  applyTemplate() {
    if (!this.template) return;
    const { l, r } = this.maskEyes;
    const cx = (l[0] + r[0]) / 2;
    const cy = (l[1] + r[1]) / 2;
    const s = (this.maskHeadW * 0.95) / this.maskSize;
    const mesh = this.template.map(([u, v]) => [cx + u * s, cy + v * s]);
    this.src = withHeadRings(mesh);
    this.triangles ??= Delaunator.from(this.src).triangles;
  }

  setMaskSize(v) {
    this.maskSize = v;
    this.applyTemplate();
  }

  /** Mask mode drawing: one rotate/scale transform that lines the mask's eyes up with yours. */
  drawMask(ctx, face, W, H, dpr) {
    // 468 / 473 are the iris centres. Pair the eye that is on the left of the
    // screen with the mask's left eye, so the mask isn't mirrored.
    let a = [face[468].x * W, face[468].y * H];
    let b = [face[473].x * W, face[473].y * H];
    if (a[0] > b[0]) [a, b] = [b, a];
    const { l, r } = this.maskEyes;
    const live = [b[0] - a[0], b[1] - a[1]];
    const photo = [r[0] - l[0], r[1] - l[1]];
    const s = (Math.hypot(...live) / Math.hypot(...photo)) * 1.3 * this.maskSize;
    const angle = Math.atan2(live[1], live[0]) - Math.atan2(photo[1], photo[0]);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    ctx.rotate(angle);
    ctx.scale(s, s);
    ctx.translate(-(l[0] + r[0]) / 2, -(l[1] + r[1]) / 2);
    ctx.drawImage(this.photo, 0, 0);
    if (this.flash > 0.01) {
      ctx.globalAlpha *= this.flash * 0.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(this.photo, 0, 0);
      this.flash *= 0.85;
    }
    ctx.restore();
  }

  /** Loads a photo file and finds the face in it. Throws if no face is found. */
  async load(file, imageLandmarker, segmenter) {
    if (!file.type.startsWith('image/')) throw new Error('Face filter needs a photo (JPG/PNG/WebP).');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, MAX_PHOTO_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

      const face = imageLandmarker.detect(canvas).faceLandmarks?.[0];
      if (!face) {
        // No real face (mask, helmet, cartoon): use the image as a mask instead.
        this.setupMask(canvas, segmenter);
        return 'mask';
      }
      this.maskEyes = null;
      this.template = null;

      const mesh = face.slice(0, MESH_POINTS).map((p) => [p.x * canvas.width, p.y * canvas.height]);
      const faceBox = bbox(FACE_OVAL.map((i) => mesh[i]));
      // Measure brightness before the cut-out (needs opaque pixels).
      this.photoLuma = averageLuma(canvas, faceBox.x0 + faceBox.w * 0.2, faceBox.y0 + faceBox.h * 0.2, faceBox.w * 0.6, faceBox.h * 0.6);
      if (segmenter) {
        try {
          cutOutPerson(canvas, segmenter, faceBox);
        } catch (err) {
          console.warn('Background cut-out failed; using the full photo.', err);
        }
      }

      this.src = withHeadRings(mesh);
      this.triangles = Delaunator.from(this.src).triangles;
      this.photo = canvas;
      this.gain = 1;
      return 'face';
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  burst() {
    this.flash = 1;
  }

  /** Re-measures room brightness on the live face (cheap; call every few frames). */
  updateLighting(video, face) {
    if (this.isMask) return; // masks keep their own colours
    // face is mirrored-normalized; convert back to raw video pixels.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const b = bbox(FACE_OVAL.map((i) => [(1 - face[i].x) * vw, face[i].y * vh]));
    if (b.w < 4 || b.h < 4) return;
    const live = averageLuma(video, b.x0 + b.w * 0.2, b.y0 + b.h * 0.2, b.w * 0.6, b.h * 0.6);
    // Only partly match the room, so the filter still stands out.
    const ratio = live / Math.max(1, this.photoLuma);
    const target = Math.min(1.25, Math.max(0.8, 1 + (ratio - 1) * 0.5));
    this.gain += (target - this.gain) * 0.3;
  }

  /**
   * Draws the photo face onto `ctx` at the live face position.
   * @param ctx  2D context of a canvas covering the stage
   * @param face live landmarks, mirrored-normalized
   * @param W,H  stage size in CSS pixels; dpr = device pixel ratio
   */
  draw(ctx, face, W, H, dpr, video = null) {
    if (!this.ready || !face) return;
    if (this.isMask && !this.template) {
      this.tryBuildTemplate(face.map((p) => [p.x * W, p.y * H]));
      if (!this.template) {
        // Until you look straight at the camera once, show the simple flat version.
        this.drawMask(ctx, face, W, H, dpr);
        return;
      }
    }
    const { off, offCtx: o, src, triangles, photo } = this;
    if (off.width !== ctx.canvas.width || off.height !== ctx.canvas.height) {
      off.width = ctx.canvas.width;
      off.height = ctx.canvas.height;
    }
    const dst = withHeadRings(face.slice(0, MESH_POINTS).map((p) => [p.x * W, p.y * H]));

    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = 'source-over';
    o.filter = 'none';
    o.clearRect(0, 0, off.width, off.height);

    for (let t = 0; t < triangles.length; t += 3) {
      const i0 = triangles[t], i1 = triangles[t + 1], i2 = triangles[t + 2];
      const d = [dst[i0], dst[i1], dst[i2]];
      const m = triangleAffine([src[i0], src[i1], src[i2]], d);
      if (!m) continue;
      // Grow the clip triangle slightly so neighbouring triangles overlap (no seams).
      const cx = (d[0][0] + d[1][0] + d[2][0]) / 3;
      const cy = (d[0][1] + d[1][1] + d[2][1]) / 3;
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.save();
      o.beginPath();
      for (let k = 0; k < 3; k++) {
        const dx = d[k][0] - cx;
        const dy = d[k][1] - cy;
        const len = Math.hypot(dx, dy) || 1;
        const x = d[k][0] + (dx / len) * 0.8;
        const y = d[k][1] + (dy / len) * 0.8;
        if (k) o.lineTo(x, y);
        else o.moveTo(x, y);
      }
      o.closePath();
      o.clip();
      o.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      o.drawImage(photo, 0, 0);
      o.restore();
    }

    // Outline mask: whole head (outer ring) or just the face oval.
    const head = this.mode === 'head' || this.isMask;
    const outline = head
      ? dst.slice(OUTER_RING_START, OUTER_RING_START + FACE_OVAL.length)
      : FACE_OVAL.map((i) => dst[i]);
    const shrink = head ? 0.97 : 0.95;
    const faceW = bbox(FACE_OVAL.map((i) => dst[i])).w;
    const b = bbox(outline);
    const mx = (b.x0 + b.x1) / 2;
    const my = (b.y0 + b.y1) / 2;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.globalCompositeOperation = 'destination-in';
    o.filter = `blur(${Math.max(1.5, faceW * 0.02) * dpr}px)`;
    o.fillStyle = '#000';
    o.beginPath();
    outline.forEach(([x, y], i) => {
      const px = mx + (x - mx) * shrink;
      const py = my + (y - my) * shrink;
      if (i) o.lineTo(px, py);
      else o.moveTo(px, py);
    });
    o.closePath();
    o.fill();
    o.filter = 'none';
    o.globalCompositeOperation = 'source-over';

    const result = video ? this.applyLighting(off, video, faceW * dpr) : off;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = this.isMask ? 'saturate(0.9)' : `brightness(${this.gain.toFixed(3)})`;
    ctx.drawImage(result, 0, 0);
    ctx.filter = 'none';
    if (this.flash > 0.01) {
      // Brief glow on the face when the frame locks on.
      ctx.globalAlpha *= this.flash * 0.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(result, 0, 0);
      this.flash *= 0.85;
    }
    ctx.restore();
  }

  /**
   * Makes the overlay look lit by your room: takes the camera image, turns it
   * into a heavily blurred black-and-white "light map" (so only broad light and
   * shadow remain, no features like glasses), and blends it over the overlay
   * with soft-light. Shadows on your face darken the mask; highlights brighten it.
   */
  applyLighting(src, video, facePx) {
    if (!video.videoWidth) return src;
    const { shade, shadeCtx: s } = this;
    if (shade.width !== src.width || shade.height !== src.height) {
      shade.width = src.width;
      shade.height = src.height;
    }
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, shade.width, shade.height);
    s.drawImage(src, 0, 0);

    s.globalCompositeOperation = 'soft-light';
    s.globalAlpha = this.isMask ? 0.95 : 0.6;
    s.filter = `grayscale(1) blur(${Math.max(4, facePx * 0.07)}px) contrast(1.6) brightness(1.05)`;
    s.setTransform(-1, 0, 0, 1, shade.width, 0); // video is shown mirrored
    s.drawImage(video, 0, 0, shade.width, shade.height);
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.filter = 'none';
    s.globalAlpha = 1;

    // Keep the overlay's own shape (soft-light also painted outside it).
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(src, 0, 0);
    s.globalCompositeOperation = 'source-over';
    return shade;
  }
}
