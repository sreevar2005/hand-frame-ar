// Decides whether two hands form a "frame" and returns its 4 corners.
//
// Each hand contributes two corners: its thumb tip and index fingertip.
// Whichever of the two is higher becomes that hand's top corner. The quad is
// then: left-top -> right-top -> right-bottom -> left-bottom.
// This works for the "both hands up, thumbs in" pose and for the classic
// director's frame (one hand rotated), because corners are sorted by height.

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// Tunable thresholds (in frame-height units; x is scaled by aspect ratio).
export const LIMITS = {
  minOpenness: 0.55, // thumb-to-index distance / hand size: is the hand making an "L"?
  minGap: 0.08, // horizontal space between the two hands' corners
  minHandSpan: 0.03, // vertical distance between a hand's two corners
  minArea: 0.012, // quad area as a fraction of the whole frame
};

const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function handCorners(hand, aspect) {
  const size = dist(hand[WRIST], hand[MIDDLE_MCP], aspect) || 1e-6;
  const thumb = hand[THUMB_TIP];
  const index = hand[INDEX_TIP];
  const openness = dist(thumb, index, aspect) / size;
  const [top, bottom] = thumb.y < index.y ? [thumb, index] : [index, thumb];
  return { openness, top, bottom };
}

function cross(o, a, b, aspect) {
  return ((a.x - o.x) * aspect) * (b.y - o.y) - (a.y - o.y) * ((b.x - o.x) * aspect);
}

function isConvex(quad, aspect) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4], aspect);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function area(quad, aspect) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    a += p.x * aspect * q.y - q.x * aspect * p.y;
  }
  return Math.abs(a) / 2 / aspect; // fraction of the full frame
}

/**
 * @param hands  array of hands (21 points each, normalized display coords)
 * @param aspect video width / height
 * @returns {{state: 'no-hands'|'one-hand'|'not-l'|'too-close'|'frame', quad?: {x,y}[]}}
 */
export function detectFrame(hands, aspect) {
  if (hands.length === 0) return { state: 'no-hands' };
  if (hands.length === 1) return { state: 'one-hand' };

  // Order hands by where they appear on screen, not by MediaPipe's
  // left/right label (which can flip when hands cross or rotate).
  const [left, right] = hands.slice(0, 2).sort((a, b) => a[WRIST].x - b[WRIST].x);
  const L = handCorners(left, aspect);
  const R = handCorners(right, aspect);

  if (L.openness < LIMITS.minOpenness || R.openness < LIMITS.minOpenness) {
    return { state: 'not-l' };
  }

  const quad = [L.top, R.top, R.bottom, L.bottom];
  const gapTop = (R.top.x - L.top.x) * aspect;
  const gapBottom = (R.bottom.x - L.bottom.x) * aspect;
  const spanL = L.bottom.y - L.top.y;
  const spanR = R.bottom.y - R.top.y;

  if (
    gapTop < LIMITS.minGap ||
    gapBottom < LIMITS.minGap ||
    Math.max(spanL, spanR) < LIMITS.minHandSpan ||
    !isConvex(quad, aspect) ||
    area(quad, aspect) < LIMITS.minArea
  ) {
    return { state: 'too-close' };
  }

  return { state: 'frame', quad };
}
