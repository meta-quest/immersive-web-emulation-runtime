/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas 2D golden-image cases (C2D-11). Plain JS using only the standard canvas API, so the same file runs in
// Chrome (tools/gen-goldens.mjs renders the goldens) and in Node against @iwer/native's runtime
// (test/golden.test.ts). Text uses the family "IwnTest" (Roboto Regular, weight 400, and Roboto Bold, weight 700,
// registered through FontFace in both environments) and "IwnRegular" (the regular face only: synthetic bold).
//
// Each case: { name, w, h, draw(ctx, env), tolerance? } where env = { canvas(w, h), checker(), font }.
// tolerance: max fraction of pixels allowed to differ by more than 16/255 (default 0.02, the spec's bound).
// Cases with a looser bound (12 of 100, each just above its measured value) differ from Chrome by anti-aliasing,
// not by what is drawn. Our edge coverage is within ~1/255 of analytic coverage on average (curves are flattened at
// 0.06 px with the chords' inward bias compensated);
// Chrome's (Skia's) is not: on filled circles its edge pixels average 11-26/255 below analytic coverage (curves are
// approximated by quadratics/conics and short chords, coverage by supersampling), strokes offset curves with
// quadratic approximations, and small glyph edges scatter by up to ~100/255 per pixel with no systematic curve.
// See web/canvas2d/README.md (C2D-11) for the measurements.

const F = 'IwnTest';
const TEXT = 'Ag Showcase 123';

function star(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export const cases = [
  // --- fills ---
  { name: 'fill-rect-solid', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = '#c03'; ctx.fillRect(8, 8, 32, 24);
    ctx.fillStyle = 'rgb(0 128 255)'; ctx.fillRect(30, 30, 26, 26);
  } },
  { name: 'fill-rect-alpha', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'rgba(255,0,0,0.5)'; ctx.fillRect(4, 4, 40, 40);
    ctx.fillStyle = 'hsla(120, 100%, 40%, 0.5)'; ctx.fillRect(20, 20, 40, 40);
  } },
  { name: 'fill-subpixel-rect', w: 32, h: 32, draw(ctx) {
    ctx.fillStyle = '#000'; ctx.fillRect(3.3, 4.6, 10.25, 7.5); ctx.fillRect(16.5, 16.5, 10, 10.75);
  } },
  { name: 'fill-triangle', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'navy'; ctx.beginPath(); ctx.moveTo(32, 4); ctx.lineTo(60, 58); ctx.lineTo(4, 50); ctx.fill();
  } },
  { name: 'fill-star-nonzero', w: 64, h: 64, draw(ctx) { ctx.fillStyle = 'darkorange'; star(ctx, 32, 34, 28); ctx.fill(); } },
  { name: 'fill-star-evenodd', w: 64, h: 64, draw(ctx) { ctx.fillStyle = 'darkorange'; star(ctx, 32, 34, 28); ctx.fill('evenodd'); } },
  { name: 'fill-circle', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'teal'; ctx.beginPath(); ctx.arc(32, 32, 24, 0, Math.PI * 2); ctx.fill();
  } },
  { name: 'fill-arc-segments', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'purple'; ctx.beginPath(); ctx.moveTo(20, 20); ctx.arc(20, 20, 16, 0, Math.PI * 0.75); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'green'; ctx.beginPath(); ctx.arc(44, 44, 16, Math.PI, Math.PI / 2, true); ctx.fill();
  } },
  { name: 'fill-ellipse-rotated', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'crimson'; ctx.beginPath(); ctx.ellipse(32, 32, 26, 12, Math.PI / 6, 0, Math.PI * 2); ctx.fill();
  } },
  { name: 'fill-roundrect-radii', w: 96, h: 64, draw(ctx) {
    ctx.fillStyle = '#336'; ctx.beginPath();
    ctx.roundRect(4, 4, 40, 26, 8);
    ctx.roundRect(50, 4, 40, 26, [4, 12]);
    ctx.roundRect(4, 34, 40, 26, [2, 6, 10, 14]);
    ctx.roundRect(50, 34, 40, 26, [{ x: 12, y: 6 }]);
    ctx.fill();
  } },
  { name: 'fill-roundrect-negative-size', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = '#933'; ctx.beginPath(); ctx.roundRect(56, 56, -48, -40, [16, 0, 0, 0]); ctx.fill();
  } },
  { name: 'fill-bezier', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'olive'; ctx.beginPath(); ctx.moveTo(4, 60); ctx.bezierCurveTo(4, 0, 60, 0, 60, 60); ctx.fill();
  } },
  { name: 'fill-quadratic', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'maroon'; ctx.beginPath(); ctx.moveTo(4, 60); ctx.quadraticCurveTo(32, -20, 60, 60); ctx.closePath(); ctx.fill();
  } },
  { name: 'fill-arcto', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'steelblue'; ctx.beginPath(); ctx.moveTo(6, 6); ctx.arcTo(58, 6, 58, 58, 20); ctx.arcTo(58, 58, 6, 58, 10); ctx.lineTo(6, 58); ctx.fill();
  } },
  { name: 'fill-path2d-svg', w: 64, h: 64, draw(ctx) {
    const p = new Path2D('M 8 32 A 24 16 0 1 1 56 32 L 48 56 Q 32 40 16 56 Z m 16 -16 h 16 v 8 h -16 z');
    ctx.fillStyle = 'indigo'; ctx.fill(p, 'evenodd');
  } },
  { name: 'fill-path2d-addpath', w: 64, h: 64, draw(ctx) {
    const a = new Path2D(); a.rect(0, 0, 16, 16);
    const b = new Path2D(); b.addPath(a, { a: 1, b: 0, c: 0, d: 1, e: 8, f: 8 }); b.addPath(a, { a: 2, b: 0.5, c: 0, d: 1.5, e: 30, f: 20 });
    ctx.fillStyle = 'goldenrod'; ctx.fill(b);
  } },
  { name: 'fill-hex-colors', w: 64, h: 16, draw(ctx) {
    const c = ['#f00', '#0f08', '#0000ff', '#ff00ff80', 'rgb(10% 20% 30%)', 'hsl(200 50% 50%)', 'hwb(30 10% 20%)', 'rebeccapurple'];
    c.forEach((s, i) => { ctx.fillStyle = s; ctx.fillRect(i * 8, 0, 8, 16); });
  } },

  // --- strokes ---
  { name: 'stroke-widths', w: 64, h: 64, draw(ctx) {
    ctx.strokeStyle = '#000';
    [1, 2, 5, 9].forEach((w, i) => { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(6, 8 + i * 14); ctx.lineTo(58, 8 + i * 14); ctx.stroke(); });
  } },
  { name: 'stroke-caps', w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 10; ctx.strokeStyle = '#06c';
    ['butt', 'round', 'square'].forEach((c, i) => { ctx.lineCap = c; ctx.beginPath(); ctx.moveTo(14, 12 + i * 20); ctx.lineTo(50, 12 + i * 20); ctx.stroke(); });
  } },
  { name: 'stroke-joins', w: 96, h: 48, draw(ctx) {
    ctx.lineWidth = 8; ctx.strokeStyle = '#a40';
    ['miter', 'round', 'bevel'].forEach((j, i) => {
      ctx.lineJoin = j; ctx.beginPath(); ctx.moveTo(8 + i * 30, 40); ctx.lineTo(20 + i * 30, 10); ctx.lineTo(32 + i * 30, 40); ctx.stroke();
    });
  } },
  { name: 'stroke-miterlimit', tolerance: 0.03 /* AA */, w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 6; ctx.strokeStyle = '#000';
    ctx.miterLimit = 10; ctx.beginPath(); ctx.moveTo(4, 30); ctx.lineTo(30, 24); ctx.lineTo(4, 18); ctx.stroke();
    ctx.miterLimit = 2; ctx.beginPath(); ctx.moveTo(34, 50); ctx.lineTo(60, 44); ctx.lineTo(34, 38); ctx.stroke();
  } },
  { name: 'stroke-dash', tolerance: 0.04 /* AA */, w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.setLineDash([8, 4]);
    ctx.beginPath(); ctx.moveTo(4, 10); ctx.lineTo(60, 10); ctx.stroke();
    ctx.setLineDash([2, 3, 6]); ctx.beginPath(); ctx.arc(32, 40, 18, 0, Math.PI * 2); ctx.stroke();
  } },
  { name: 'stroke-dash-offset-caps', w: 64, h: 32, draw(ctx) {
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.setLineDash([6, 6]); ctx.lineDashOffset = 3; ctx.strokeStyle = '#090';
    ctx.beginPath(); ctx.moveTo(6, 16); ctx.lineTo(58, 16); ctx.stroke();
  } },
  { name: 'stroke-hairline', w: 64, h: 32, draw(ctx) {
    ctx.strokeStyle = '#000';
    [1, 0.5, 0.25].forEach((w, i) => { ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(4, 6.5 + i * 10); ctx.lineTo(60, 6.5 + i * 10); ctx.stroke(); });
  } },
  { name: 'stroke-circle', tolerance: 0.035 /* AA */, w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 4; ctx.strokeStyle = '#c0c'; ctx.beginPath(); ctx.arc(32, 32, 24, 0, Math.PI * 2); ctx.stroke();
  } },
  { name: 'stroke-rect', w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 3; ctx.strokeStyle = '#333'; ctx.strokeRect(8.5, 8.5, 30, 20); ctx.lineJoin = 'round'; ctx.lineWidth = 7; ctx.strokeRect(24, 36, 30, 20);
  } },
  { name: 'stroke-nonuniform-scale', tolerance: 0.045 /* AA */, w: 96, h: 48, draw(ctx) {
    ctx.scale(3, 1); ctx.lineWidth = 4; ctx.strokeStyle = '#05a'; ctx.beginPath(); ctx.arc(16, 24, 14, 0, Math.PI * 2); ctx.stroke();
  } },
  { name: 'stroke-closed-polygon', w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 5; ctx.strokeStyle = '#a00'; star(ctx, 32, 34, 26); ctx.stroke();
  } },
  { name: 'stroke-bezier-wide', w: 64, h: 64, draw(ctx) {
    ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(0,100,0,0.7)';
    ctx.beginPath(); ctx.moveTo(8, 56); ctx.bezierCurveTo(8, 4, 56, 60, 56, 8); ctx.stroke();
  } },
  { name: 'stroke-path2d-pill', w: 96, h: 40, draw(ctx) {
    const p = new Path2D(); p.roundRect(6, 6, 84, 28, 14);
    ctx.fillStyle = '#eef'; ctx.fill(p); ctx.lineWidth = 2; ctx.strokeStyle = '#224'; ctx.stroke(p);
  } },

  // --- transforms ---
  { name: 'transform-rotate', w: 64, h: 64, draw(ctx) {
    ctx.translate(32, 32); ctx.rotate(Math.PI / 5); ctx.fillStyle = '#480'; ctx.fillRect(-18, -10, 36, 20);
  } },
  { name: 'transform-scale-translate', w: 64, h: 64, draw(ctx) {
    ctx.translate(10, 6); ctx.scale(2, 1.5); ctx.fillStyle = '#048'; ctx.fillRect(2, 2, 10, 10); ctx.fillRect(14, 14, 6, 12);
  } },
  { name: 'transform-settransform-skew', w: 64, h: 64, draw(ctx) {
    ctx.setTransform(1, 0.3, -0.4, 1, 20, 8); ctx.fillStyle = '#804'; ctx.fillRect(4, 4, 30, 30);
    ctx.resetTransform(); ctx.fillStyle = '#000'; ctx.fillRect(0, 60, 64, 4);
  } },
  { name: 'transform-save-restore', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = 'red'; ctx.save(); ctx.translate(30, 30); ctx.fillStyle = 'blue'; ctx.save(); ctx.rotate(0.5);
    ctx.fillRect(0, 0, 20, 10); ctx.restore(); ctx.fillRect(-25, 10, 15, 15); ctx.restore(); ctx.fillRect(2, 2, 12, 12);
  } },

  // --- gradients ---
  { name: 'gradient-linear', w: 96, h: 24, draw(ctx) {
    const g = ctx.createLinearGradient(0, 0, 96, 0); g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 96, 24);
  } },
  { name: 'gradient-linear-multistop-diagonal', w: 64, h: 64, draw(ctx) {
    const g = ctx.createLinearGradient(8, 8, 56, 56);
    g.addColorStop(0, 'yellow'); g.addColorStop(0.4, 'red'); g.addColorStop(0.4, 'white'); g.addColorStop(1, 'black');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'gradient-radial', w: 64, h: 64, draw(ctx) {
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30); g.addColorStop(0, 'white'); g.addColorStop(1, 'darkblue');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'gradient-radial-focal', w: 64, h: 64, draw(ctx) {
    const g = ctx.createRadialGradient(20, 20, 2, 36, 36, 28); g.addColorStop(0, '#ff0'); g.addColorStop(0.5, '#f80'); g.addColorStop(1, '#400');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'gradient-conic', w: 64, h: 64, draw(ctx) {
    const g = ctx.createConicGradient(Math.PI / 4, 32, 32);
    g.addColorStop(0, 'red'); g.addColorStop(0.33, 'lime'); g.addColorStop(0.66, 'blue'); g.addColorStop(1, 'red');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'gradient-transparent-stop', w: 96, h: 24, draw(ctx) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 96, 24);
    const g = ctx.createLinearGradient(0, 0, 96, 0); g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, 'rgba(0,0,255,1)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 96, 24);
  } },
  { name: 'gradient-stroke-transformed', w: 64, h: 64, draw(ctx) {
    const g = ctx.createLinearGradient(0, 0, 40, 0); g.addColorStop(0, '#0a0'); g.addColorStop(1, '#00a');
    ctx.translate(12, 12); ctx.rotate(0.6); ctx.strokeStyle = g; ctx.lineWidth = 8; ctx.strokeRect(0, 0, 40, 24);
  } },

  // --- patterns ---
  { name: 'pattern-repeat', w: 64, h: 64, draw(ctx, env) {
    ctx.fillStyle = ctx.createPattern(env.checker(), 'repeat'); ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'pattern-repeat-x', w: 64, h: 64, draw(ctx, env) {
    ctx.fillStyle = ctx.createPattern(env.checker(), 'repeat-x'); ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'pattern-no-repeat-translated', w: 64, h: 64, draw(ctx, env) {
    ctx.translate(20, 20); ctx.fillStyle = ctx.createPattern(env.checker(), 'no-repeat'); ctx.fillRect(-20, -20, 64, 64);
  } },
  { name: 'pattern-settransform', tolerance: 0.035 /* AA: Chrome's filled arc edge */, w: 64, h: 64, draw(ctx, env) {
    const p = ctx.createPattern(env.checker(), 'repeat'); p.setTransform({ a: 2, b: 0, c: 0, d: 2, e: 3, f: 0 });
    ctx.fillStyle = p; ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill();
  } },

  // --- drawImage ---
  { name: 'drawimage-1to1', w: 32, h: 32, draw(ctx, env) { ctx.drawImage(env.checker(), 4, 4); ctx.drawImage(env.checker(), 18, 10); } },
  { name: 'drawimage-scale-up-smooth', w: 64, h: 64, draw(ctx, env) { ctx.drawImage(env.checker(), 0, 0, 64, 64); } },
  { name: 'drawimage-scale-up-nearest', w: 64, h: 64, draw(ctx, env) { ctx.imageSmoothingEnabled = false; ctx.drawImage(env.checker(), 0, 0, 64, 64); } },
  { name: 'drawimage-scale-down', w: 16, h: 16, draw(ctx, env) {
    const big = env.canvas(64, 64); const b = big.getContext('2d');
    b.fillStyle = '#f00'; b.fillRect(0, 0, 32, 64); b.fillStyle = '#00f'; b.fillRect(32, 0, 32, 64);
    ctx.drawImage(big, 0, 0, 16, 16);
  } },
  { name: 'drawimage-source-rect', w: 64, h: 64, draw(ctx, env) { ctx.imageSmoothingEnabled = false; ctx.drawImage(env.checker(), 2, 2, 4, 4, 8, 8, 48, 48); } },
  { name: 'drawimage-rotated-alpha', w: 64, h: 64, draw(ctx, env) {
    ctx.translate(32, 32); ctx.rotate(0.4); ctx.globalAlpha = 0.7; ctx.imageSmoothingEnabled = false; ctx.drawImage(env.checker(), -20, -20, 40, 40);
  } },
  { name: 'drawimage-self', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = '#0a6'; ctx.fillRect(0, 0, 32, 32); ctx.fillStyle = '#a06'; ctx.fillRect(8, 8, 8, 8);
    ctx.drawImage(ctx.canvas, 0, 0, 32, 32, 32, 32, 32, 32);
  } },

  // --- clipping ---
  { name: 'clip-rect', w: 64, h: 64, draw(ctx) {
    ctx.beginPath(); ctx.rect(10, 10, 30, 30); ctx.clip(); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 64, 64);
  } },
  { name: 'clip-circle-aa', w: 64, h: 64, draw(ctx) {
    ctx.beginPath(); ctx.arc(32, 32, 22, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = 'yellow'; ctx.fillRect(0, 28, 64, 8);
  } },
  { name: 'clip-nested-restore', w: 64, h: 64, draw(ctx) {
    ctx.save(); ctx.beginPath(); ctx.rect(4, 4, 40, 40); ctx.clip(); ctx.beginPath(); ctx.arc(40, 40, 20, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 64, 64); ctx.restore(); ctx.fillStyle = 'black'; ctx.fillRect(50, 0, 14, 14);
  } },
  { name: 'clip-path2d-evenodd', w: 64, h: 64, draw(ctx) {
    const p = new Path2D(); p.rect(4, 4, 56, 56); p.rect(20, 20, 24, 24); ctx.clip(p, 'evenodd'); ctx.fillStyle = '#860'; ctx.fillRect(0, 0, 64, 64);
  } },

  // --- compositing ---
  ...['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in', 'destination-out',
    'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference',
    'hard-light', 'hue', 'luminosity'].map((op) => ({
    name: `composite-${op}`, w: 48, h: 48, draw(ctx) {
      ctx.fillStyle = 'rgba(0, 90, 255, 0.85)'; ctx.fillRect(4, 4, 28, 28);
      ctx.globalCompositeOperation = op;
      ctx.fillStyle = 'rgba(255, 60, 0, 0.7)'; ctx.beginPath(); ctx.arc(30, 30, 15, 0, Math.PI * 2); ctx.fill();
    },
  })),
  { name: 'global-alpha', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 32, 64); ctx.globalAlpha = 0.4; ctx.fillStyle = '#fff'; ctx.fillRect(8, 8, 48, 48);
  } },

  // --- shadows ---
  { name: 'shadow-offset', w: 64, h: 64, draw(ctx) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowOffsetX = 6; ctx.shadowOffsetY = 8; ctx.fillStyle = '#e33'; ctx.fillRect(10, 10, 30, 30);
  } },
  { name: 'shadow-blur', w: 64, h: 64, draw(ctx) {
    ctx.shadowColor = '#000'; ctx.shadowBlur = 8; ctx.fillStyle = '#39f'; ctx.fillRect(16, 16, 32, 32);
  } },

  // --- pixels ---
  { name: 'putimagedata-dirty', w: 32, h: 32, draw(ctx) {
    const img = ctx.createImageData(16, 16);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (i / 4) % 16 * 16; img.data[i + 1] = 128; img.data[i + 2] = 255 - ((i / 4) % 16) * 16; img.data[i + 3] = 200; }
    ctx.putImageData(img, 2, 2); ctx.putImageData(img, 14, 14, 4, 4, 8, 6);
  } },
  { name: 'getimagedata-roundtrip', w: 32, h: 32, draw(ctx) {
    ctx.fillStyle = 'rgba(200, 50, 100, 0.5)'; ctx.fillRect(0, 0, 16, 32);
    const d = ctx.getImageData(0, 0, 16, 32); ctx.putImageData(d, 16, 0);
  } },
  { name: 'clearrect-transformed-clipped', w: 64, h: 64, draw(ctx) {
    ctx.fillStyle = '#555'; ctx.fillRect(0, 0, 64, 64); ctx.beginPath(); ctx.rect(0, 0, 40, 64); ctx.clip();
    ctx.translate(32, 32); ctx.rotate(Math.PI / 4); ctx.clearRect(-12, -12, 24, 24);
  } },
  { name: 'is-point-in-path', w: 32, h: 16, draw(ctx) {
    const p = new Path2D(); p.arc(10, 10, 8, 0, Math.PI * 2);
    ctx.beginPath(); ctx.rect(0, 0, 10, 10); ctx.rect(2, 2, 6, 6);
    const r = [ctx.isPointInPath(p, 10, 10), ctx.isPointInPath(p, 1, 1), ctx.isPointInPath(5, 5), ctx.isPointInPath(5, 5, 'evenodd'),
      ctx.isPointInPath(20, 5)];
    ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 14); ctx.lineTo(30, 14); r.push(ctx.isPointInStroke(15, 13), ctx.isPointInStroke(15, 8));
    r.forEach((v, i) => { ctx.fillStyle = v ? '#0c0' : '#c00'; ctx.fillRect(i * 4, 0, 4, 4); });
  } },

  // --- text ---
  ...[12, 24, 48].map((size) => ({
    name: `text-${size}px-aligns`, w: size * 9, h: Math.ceil(size * 1.4) * 5, tolerance: size === 12 ? 0.04 /* AA */ : 0.02, draw(ctx) {
      ctx.font = `${size}px ${F}`; ctx.fillStyle = '#000';
      const x = size * 4.5;
      ['start', 'end', 'left', 'right', 'center'].forEach((a, i) => { ctx.textAlign = a; ctx.fillText(TEXT, x, Math.ceil(size * 1.4) * (i + 1) - size * 0.3); });
      ctx.fillStyle = '#f00'; ctx.fillRect(x, 0, 1, Math.ceil(size * 1.4) * 5);
    },
  })),
  ...[12, 24, 48].map((size) => ({
    name: `text-${size}px-baselines`, w: size * 12, h: size * 3, tolerance: size === 12 ? 0.04 /* AA */ : 0.02, draw(ctx) {
      ctx.font = `${size}px ${F}`; ctx.fillStyle = '#000';
      const y = size * 1.5;
      ctx.fillStyle = '#f00'; ctx.fillRect(0, y, size * 12, 1); ctx.fillStyle = '#000';
      ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'].forEach((b, i) => { ctx.textBaseline = b; ctx.fillText('Ag', 2 + i * size * 2, y); });
    },
  })),
  { name: 'text-stroke', tolerance: 0.04 /* AA */, w: 160, h: 48, draw(ctx) {
    ctx.font = `40px ${F}`; ctx.lineWidth = 1.5; ctx.strokeStyle = '#03a'; ctx.strokeText('Stroke', 6, 38);
  } },
  { name: 'text-gradient-fill', w: 160, h: 48, tolerance: 0.025 /* AA */, draw(ctx) {
    const g = ctx.createLinearGradient(0, 0, 160, 0); g.addColorStop(0, '#e00'); g.addColorStop(1, '#00e');
    ctx.font = `bold 36px ${F}`; ctx.fillStyle = g; ctx.fillText('Gradient', 4, 38);
  } },
  { name: 'text-rotated', w: 96, h: 96, tolerance: 0.03 /* AA */, draw(ctx) {
    ctx.translate(48, 48); ctx.rotate(-Math.PI / 6); ctx.font = `20px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Rotated', 0, 0);
  } },
  { name: 'text-maxwidth', w: 128, h: 64, draw(ctx) {
    ctx.font = `24px ${F}`; ctx.fillText('Condensed text', 4, 26, 80); ctx.fillText('Fits', 4, 56, 200);
  } },
  { name: 'text-bold-weight', w: 160, h: 40, draw(ctx) {
    ctx.font = `700 28px ${F}`; ctx.fillText('Bold 700', 4, 30);
  } },
  { name: 'text-greek-cyrillic', w: 200, h: 40, tolerance: 0.025 /* AA */, draw(ctx) {
    ctx.font = `24px ${F}`; ctx.fillText('Ωμέγα Привет ÅÉß', 4, 30);
  } },
  { name: 'text-letter-spacing', w: 200, h: 40, draw(ctx) {
    ctx.font = `20px ${F}`; ctx.letterSpacing = '4px'; ctx.fillText('Spaced out', 4, 28);
  } },
  { name: 'text-shadow-alpha', w: 160, h: 48, draw(ctx) {
    ctx.font = `32px ${F}`; ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3; ctx.fillStyle = 'rgba(0,120,0,0.8)';
    ctx.fillText('Shadow', 6, 36);
  } },
  { name: 'text-synthetic-bold', w: 220, h: 48, draw(ctx) {
    ctx.font = 'bold 32px IwnRegular'; ctx.fillStyle = '#123'; ctx.fillText('Fake Bold 42', 6, 36);
  } },
  { name: 'text-synthetic-italic', w: 220, h: 48, tolerance: 0.025 /* AA */, draw(ctx) {
    ctx.font = `italic 32px ${F}`; ctx.fillStyle = '#123'; ctx.fillText('Slanted Ag 42', 6, 36);
  } },
  { name: 'text-label-plate', w: 256, h: 64, draw(ctx) {
    // The showcase's map-plate pattern: a pill with an outline and a centred label.
    ctx.fillStyle = 'rgba(20, 24, 40, 0.85)'; ctx.beginPath(); ctx.roundRect(4, 4, 248, 56, 28); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#7cf'; ctx.stroke();
    ctx.font = `bold 26px ${F}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('PLAY  STOP', 128, 32);
  } },
];

/** measureText comparisons (C2D-8 check: width within 5 % of Chrome; the rest reported). */
export const metricCases = [];
for (const size of [12, 24, 48]) {
  for (const text of ['M', TEXT, 'gypq', 'Ωμέγα Привет']) {
    for (const baseline of ['alphabetic', 'top', 'middle', 'bottom', 'hanging', 'ideographic']) {
      metricCases.push({ font: `${size}px ${F}`, text, baseline, align: 'start' });
    }
  }
  metricCases.push({ font: `${size}px ${F}`, text: TEXT, baseline: 'alphabetic', align: 'center' });
  metricCases.push({ font: `${size}px ${F}`, text: TEXT, baseline: 'alphabetic', align: 'right' });
  metricCases.push({ font: `bold ${size}px ${F}`, text: TEXT, baseline: 'alphabetic', align: 'start' });
}

export const METRIC_KEYS = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent',
  'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent',
  'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline'];

/** The 8x8 test image: four coloured quadrants, a half-transparent centre. */
export function drawChecker(ctx) {
  ctx.fillStyle = '#e22'; ctx.fillRect(0, 0, 4, 4);
  ctx.fillStyle = '#2e2'; ctx.fillRect(4, 0, 4, 4);
  ctx.fillStyle = '#22e'; ctx.fillRect(0, 4, 4, 4);
  ctx.fillStyle = '#ee2'; ctx.fillRect(4, 4, 4, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(2, 2, 4, 4);
}
