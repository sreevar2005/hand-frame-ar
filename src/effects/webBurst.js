// Original placeholder effect: a comic-style "web portal" built only from
// shapes and particles — halftone dots, speed lines, a spinning web and sparks.
// No characters, logos or footage.

const TAU = Math.PI * 2;

export class WebBurst {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.particles = [];
    this.flash = 0;
  }

  /** Called when the frame locks on: a burst of sparks and a flash. */
  burst() {
    this.flash = 1;
    for (let i = 0; i < 140; i++) this.spawn(true);
  }

  spawn(fast = false) {
    const a = Math.random() * TAU;
    const speed = (fast ? 4 : 1.2) + Math.random() * (fast ? 7 : 2.5);
    this.particles.push({
      x: this.w / 2,
      y: this.h / 2,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      life: 1,
      decay: 0.008 + Math.random() * 0.02,
      size: 1 + Math.random() * 3,
      hue: Math.random() < 0.5 ? 330 : 190,
    });
  }

  draw(ctx, t) {
    const { w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.hypot(cx, cy);

    // Background: hot magenta core fading to deep violet / navy.
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    bg.addColorStop(0, `hsl(330, 100%, ${50 + pulse * 10}%)`);
    bg.addColorStop(0.45, 'hsl(275, 70%, 30%)');
    bg.addColorStop(1, 'hsl(240, 70%, 7%)');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Halftone dots that ripple outward.
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    const step = 16;
    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        const d = Math.hypot(x - cx, y - cy) / R;
        const r = 1 + 3.2 * Math.max(0, Math.sin(d * 14 - t * 4)) * (1 - d * 0.6);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
    }

    // Radial speed lines.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.15);
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      const inner = R * (0.35 + 0.15 * Math.sin(i * 7.3 + t * 3));
      ctx.strokeStyle = i % 2 ? 'rgba(80,220,255,0.35)' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = i % 3 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      ctx.stroke();
    }
    ctx.restore();

    // Spinning web: spokes + sagging rings.
    const spokes = 12;
    const rings = 7;
    const webR = Math.min(w, h) * (0.55 + 0.04 * Math.sin(t * 3));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.35);
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * TAU;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * webR * 1.25, Math.sin(a) * webR * 1.25);
      ctx.stroke();
    }
    ctx.lineWidth = 1.6;
    for (let r = 1; r <= rings; r++) {
      const rr = (r / rings) * webR;
      ctx.beginPath();
      for (let i = 0; i <= spokes; i++) {
        const a0 = (i / spokes) * TAU;
        const a1 = ((i + 1) / spokes) * TAU;
        const p0 = [Math.cos(a0) * rr, Math.sin(a0) * rr];
        const p1 = [Math.cos(a1) * rr, Math.sin(a1) * rr];
        const mid = (a0 + a1) / 2;
        const sag = rr * 0.82; // pull the middle of each strand toward the centre
        if (i === 0) ctx.moveTo(p0[0], p0[1]);
        if (i < spokes) ctx.quadraticCurveTo(Math.cos(mid) * sag, Math.sin(mid) * sag, p1[0], p1[1]);
      }
      ctx.stroke();
    }
    ctx.restore();

    // Sparks.
    if (Math.random() < 0.9) this.spawn();
    ctx.globalCompositeOperation = 'lighter';
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.life -= p.decay;
      ctx.fillStyle = `hsla(${p.hue}, 100%, 70%, ${Math.max(0, p.life)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }

    // Lock-on flash.
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.7})`;
      ctx.fillRect(0, 0, w, h);
      this.flash *= 0.88;
    }
    ctx.globalCompositeOperation = 'source-over';

    // Edge vignette so the window blends into the scene.
    const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }
}
