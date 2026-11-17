// Plays an image or video the user picks from their own computer inside the
// frame. The file is opened locally via an object URL and never uploaded.

export class ClipEffect {
  constructor(width, height) {
    this.w = width;
    this.h = height;
    this.media = null;
    this.url = null;
    this.flash = 0;
  }

  async load(file) {
    this.dispose();
    this.url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = this.url;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      await v.play();
      this.media = v;
    } else if (file.type.startsWith('image/')) {
      const img = new Image();
      img.src = this.url;
      await img.decode();
      this.media = img;
    } else {
      this.dispose();
      throw new Error('Please choose an image or video file.');
    }
  }

  get ready() {
    return !!this.media;
  }

  burst() {
    this.flash = 1;
  }

  draw(ctx) {
    const { w, h, media } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (!media) return;
    const mw = media.videoWidth || media.naturalWidth;
    const mh = media.videoHeight || media.naturalHeight;
    if (!mw || !mh) return;
    // "cover" fit: fill the frame, cropping the overflow.
    const scale = Math.max(w / mw, h / mh);
    const dw = mw * scale;
    const dh = mh * scale;
    ctx.drawImage(media, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.6})`;
      ctx.fillRect(0, 0, w, h);
      this.flash *= 0.88;
    }
  }

  dispose() {
    if (this.media instanceof HTMLVideoElement) this.media.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.media = null;
    this.url = null;
  }
}
