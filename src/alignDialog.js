// Small dialog to click a character's two eyes and chin on a picture (for
// cartoon or masked characters the face model can't read). Resolves with
// three points in picture pixels, or null if cancelled.

export function pickEyes(picture) {
  const dialog = document.getElementById('alignDialog');
  const canvas = document.getElementById('alignCanvas');
  const text = document.getElementById('alignText');
  const ctx = canvas.getContext('2d');
  canvas.width = picture.width;
  canvas.height = picture.height;
  let points = [];

  const redraw = () => {
    ctx.drawImage(picture, 0, 0);
    const r = Math.max(6, picture.width / 90);
    for (const [x, y] of points) {
      ctx.lineWidth = r / 3;
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#ff3d8b';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    text.innerHTML = [
      "Click the character's <b>left eye</b> (on your left).",
      'Now click the <b>right eye</b>.',
      'Now click the <b>bottom of the chin</b> (where the jaw ends).',
      'Done!',
    ][points.length];
  };

  return new Promise((resolve) => {
    const finish = (result) => {
      canvas.removeEventListener('click', onClick);
      reset.removeEventListener('click', onReset);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(result);
    };
    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      points.push([
        ((e.clientX - rect.left) / rect.width) * canvas.width,
        ((e.clientY - rect.top) / rect.height) * canvas.height,
      ]);
      redraw();
      if (points.length === 3) setTimeout(() => finish(points), 250);
    };
    const onReset = () => {
      points = [];
      redraw();
    };
    const onCancel = (e) => {
      e?.preventDefault?.();
      finish(null);
    };
    const reset = document.getElementById('alignReset');
    const cancel = document.getElementById('alignCancel');
    canvas.addEventListener('click', onClick);
    reset.addEventListener('click', onReset);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    redraw();
    dialog.showModal();
  });
}
