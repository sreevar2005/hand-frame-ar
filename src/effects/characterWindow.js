// Character window: the hand frame becomes a window onto a full character
// picture (costume, mask and background) that is lined up with you.
//
// The picture is NOT bent over your face. It is only moved and scaled so the
// character's face sits on your face (eyes on eyes, chin on chin), smoothly
// following you. Whatever part of you the frame covers shows the matching
// part of the character — face -> mask, chest -> costume.
//
// To never show "a picture in a box", the picture is extended past its edges
// by stretching its border pixels outward and blurring them, so the window
// shows one continuous scene however wide you open it.

const MAX_SIZE = 1600;
const EXT_WIDTH = 360; // resolution of the blurred extension (it's blurry anyway)

const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Builds a 3x-size canvas: picture in the middle, its edges smeared outward, all blurred. */
function buildExtension(src) {
  const sw = EXT_WIDTH;
  const sh = Math.max(1, Math.round((EXT_WIDTH * src.height) / src.width));
  const small = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
  small.getContext('2d').drawImage(src, 0, 0, sw, sh);

  const ext = Object.assign(document.createElement('canvas'), { width: sw * 3, height: sh * 3 });
  const e = ext.getContext('2d');
  const W = sw;
  const H = sh;
  // Edges: stretch the outermost 2px row/column across each side.
  e.drawImage(small, 0, 0, 2, H, 0, H, W, H); // left
  e.drawImage(small, W - 2, 0, 2, H, 2 * W, H, W, H); // right
  e.drawImage(small, 0, 0, W, 2, W, 0, W, H); // top
  e.drawImage(small, 0, H - 2, W, 2, W, 2 * H, W, H); // bottom
  // Corners: stretch the corner pixels.
  e.drawImage(small, 0, 0, 2, 2, 0, 0, W, H);
  e.drawImage(small, W - 2, 0, 2, 2, 2 * W, 0, W, H);
  e.drawImage(small, 0, H - 2, 2, 2, 0, 2 * H, W, H);
  e.drawImage(small, W - 2, H - 2, 2, 2, 2 * W, 2 * H, W, H);
  e.drawImage(small, W, H);

  const blurred = Object.assign(document.createElement('canvas'), { width: ext.width, height: ext.height });
  const b = blurred.getContext('2d');
  b.filter = `blur(${sw * 0.05}px)`;
  b.drawImage(ext, 0, 0);
  b.filter = 'none';
  // Put the sharp-ish centre back with a soft edge so only the outside is blurred.
  return blurred;
}

export class CharacterWindow {
  constructor() {
    this.raw = null; // original picture (for the eye-picking dialog)
    this.img = null; // picture with slightly softened edges
    this.ext = null; // blurred extension around the picture
    this.anchors = null; // { l, r, chin } in picture pixels
    this.size = 1;
    this.offsetY = 0; // in units of your eye-to-chin distance
    this.anchor = null; // smoothed { x, y, s, d } in stage pixels
    this.flash = 0;
  }

  get ready() {
    return !!(this.img && this.anchors);
  }

  /** Loads a picture. Returns 'auto' if the character's face was found, else 'needs-align'. */
  async load(file, imageLandmarker) {
    if (!file.type.startsWith('image/')) throw new Error('Character window needs a picture (JPG/PNG/WebP).');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const raw = Object.assign(document.createElement('canvas'), { width: w, height: h });
      raw.getContext('2d').drawImage(img, 0, 0, w, h);

      // Very slight edge softening so the sharp picture melts into the extension.
      const soft = Object.assign(document.createElement('canvas'), { width: w, height: h });
      const sc = soft.getContext('2d');
      sc.drawImage(raw, 0, 0);
      const f = Math.min(w, h) * 0.025;
      sc.globalCompositeOperation = 'destination-in';
      sc.filter = `blur(${f / 2}px)`;
      sc.fillRect(f, f, w - 2 * f, h - 2 * f);
      sc.filter = 'none';
      sc.globalCompositeOperation = 'source-over';

      this.raw = raw;
      this.img = soft;
      this.ext = buildExtension(raw);
      this.anchor = null;

      const face = imageLandmarker?.detect(raw).faceLandmarks?.[0];
      if (face && face[473]) {
        this.setAnchors([face[468].x * w, face[468].y * h], [face[473].x * w, face[473].y * h], [face[152].x * w, face[152].y * h]);
        return 'auto';
      }
      this.anchors = null;
      return 'needs-align';
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Eyes + chin (picture pixels), picked by hand for cartoon/masked characters. */
  setAnchors(p1, p2, chin) {
    const [l, r] = p1[0] <= p2[0] ? [p1, p2] : [p2, p1];
    this.anchors = { l, r, chin };
    this.anchor = null;
  }

  burst() {
    this.flash = 1;
  }

  /**
   * Smoothly follows your face. Size comes from eye-to-chin distance (works
   * for stylised characters with huge eyes, where eye spacing would mislead).
   */
  update(face, W, H) {
    if (!this.ready || !face) return;
    let a = [face[468].x * W, face[468].y * H];
    let b = [face[473].x * W, face[473].y * H];
    if (a[0] > b[0]) [a, b] = [b, a];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const liveFace = dist(mid, [face[152].x * W, face[152].y * H]);
    const { l, r, chin } = this.anchors;
    const picMid = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
    const picFace = dist(picMid, chin) || 1;
    const target = { x: mid[0], y: mid[1], s: liveFace / picFace, d: liveFace };
    if (!this.anchor) {
      this.anchor = target;
      return;
    }
    // Glide: tiny wobbles are smoothed away, real moves followed quickly.
    const move = Math.hypot(target.x - this.anchor.x, target.y - this.anchor.y) / (target.d || 1);
    const t = Math.min(1, 0.15 + move * 1.2);
    this.anchor.x = lerp(this.anchor.x, target.x, t);
    this.anchor.y = lerp(this.anchor.y, target.y, t);
    this.anchor.s = lerp(this.anchor.s, target.s, 0.1); // size changes slowly: no "breathing"
    this.anchor.d = lerp(this.anchor.d, target.d, 0.1);
  }

  /** Draws the character layer over the whole stage; the caller clips it to the frame. */
  draw(ctx, W, H, dpr) {
    if (!this.img) return;
    const { width: iw, height: ih } = this.img;
    let s, x, y;
    if (this.anchor && this.anchors) {
      s = this.anchor.s * this.size;
      const { l, r } = this.anchors;
      x = this.anchor.x - ((l[0] + r[0]) / 2) * s;
      y = this.anchor.y + this.offsetY * this.anchor.d - ((l[1] + r[1]) / 2) * s;
    } else {
      // No face yet: centre the picture, covering the stage.
      s = Math.max(W / iw, H / ih);
      x = (W - iw * s) / 2;
      y = (H - ih * s) / 2;
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Base fill for anything beyond even the extension: the extension's centre, stretched to cover.
    ctx.drawImage(this.ext, this.ext.width / 3, this.ext.height / 3, this.ext.width / 3, this.ext.height / 3, 0, 0, W, H);
    // Continuous extension (3x the picture, centred on it), then the sharp picture.
    ctx.drawImage(this.ext, x - iw * s, y - ih * s, iw * s * 3, ih * s * 3);
    ctx.drawImage(this.img, x, y, iw * s, ih * s);

    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
      this.flash *= 0.85;
    }
    ctx.restore();
  }
}
