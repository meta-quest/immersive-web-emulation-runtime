// ImageBitmap arrives by transfer, is drawn with OffscreenCanvas 2D, comes back as a new bitmap (WRK-5, C2D in workers).
onmessage = async (e) => {
  try {
    const bmp = e.data.bitmap;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const px = Array.from(ctx.getImageData(1, 1, 1, 1).data);
    ctx.fillStyle = 'rgb(0, 255, 0)';
    ctx.fillRect(0, 0, 2, 2);
    // createImageBitmap(canvas): OffscreenCanvas.transferToImageBitmap() returns canvas2d's own bitmap object today,
    // which the image module's ImageBitmap (and so postMessage) does not recognise (reported cross-stream).
    const back = await createImageBitmap(c);
    const imageData = ctx.getImageData(0, 0, 2, 2);
    const t2ib = c.transferToImageBitmap();
    const json = await (await fetch('../lib/data.json')).json();
    postMessage({ w: bmp.width, h: bmp.height, px, back, json, imageData,
      transferToImageBitmapIsImageBitmap: t2ib instanceof ImageBitmap }, [back]);
  } catch (err) {
    postMessage({ error: String(err && err.stack || err) });
  }
};
