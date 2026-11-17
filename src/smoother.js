// Smooths the 4 frame corners over time so the overlay doesn't jitter.
// Small movements are smoothed heavily; fast movements follow quickly
// (a simple adaptive exponential filter).

export class QuadSmoother {
  constructor({ minAlpha = 0.25, speedGain = 10 } = {}) {
    this.minAlpha = minAlpha;
    this.speedGain = speedGain;
    this.quad = null;
  }

  update(quad) {
    if (!this.quad) {
      this.quad = quad.map((p) => ({ x: p.x, y: p.y }));
      return this.quad;
    }
    for (let i = 0; i < 4; i++) {
      const cur = this.quad[i];
      const next = quad[i];
      const speed = Math.hypot(next.x - cur.x, next.y - cur.y);
      const alpha = Math.min(1, this.minAlpha + speed * this.speedGain);
      cur.x += (next.x - cur.x) * alpha;
      cur.y += (next.y - cur.y) * alpha;
    }
    return this.quad;
  }

  reset() {
    this.quad = null;
  }
}
