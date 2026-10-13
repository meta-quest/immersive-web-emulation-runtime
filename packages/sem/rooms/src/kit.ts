// IWER room kit: shared building blocks for procedural GLTS rooms.
// The builders are used by the room scripts this file is concatenated with.
/* eslint-disable @typescript-eslint/no-unused-vars */
//
// A room script calls createRoom(spec) once, builds its furniture with the
// builders below, then calls room.finish(). Builders tag WebXR planes
// (userData.xrPlane) and add invisible volumes (userData.xrMesh) that also
// shape the baked lighting. finish() adds the shell (floor, ceiling, walls
// with window openings, windows, doors, baseboards, downlights), bakes
// lightmaps and furniture ambient occlusion, merges static meshes per
// material, paints the reflection probe and adds the sun.
//
// Conventions (meters): +Y up; the viewer starts at the origin facing -Z, so
// keep the origin on open floor. The room spans x in [-width/2, width/2] and
// z in [z0, z0 + depth]. Walls: back (-Z), front (+Z), left (-X), right (+X).
// A position "at" along a wall is world x for back/front walls and world z
// for left/right walls. Builders face +Z (their back is at local -Z), so
// room.against(wall, ...) turns them to face into the room.
//
// SEM reports the scene's static geometry as the room's 'global mesh' (a
// Quest behavior); objects that move or lie outside the room are tagged
// userData.xrGlobalMesh = false. finish() merges untagged static meshes, so
// an animated object must be tagged or added after finish().
//
// Realism limits: a Quest room scan covers at most 10 x 10 m, and a scanned
// room holds a few dozen detected objects (the office_large capture has 38).
// createRoom rejects larger rooms and finish() warns above 40 planes and
// meshes.

type Vec3 = [number, number, number];
type Wall = 'back' | 'front' | 'left' | 'right';
const WALLS: Wall[] = ['back', 'front', 'left', 'right'];
const MAX_ROOM_SIZE = 10;
const MAX_ENTITIES = 40;

const owned: { dispose(): void }[] = [];
function own<T extends { dispose(): void }>(value: T): T {
  owned.push(value);
  return value;
}
onDispose(() => owned.forEach((value) => value.dispose()));

function once<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

// ------------------------------------------------------------------ noise

function hash(x: number, y: number, seed: number) {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(seed | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Value noise, tileable with integer periods px / py.
function noise(x: number, y: number, seed: number, px: number, py: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = mod(ix, px);
  const x1 = mod(ix + 1, px);
  const y0 = mod(iy, py);
  const y1 = mod(iy + 1, py);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  px = 1 << 16,
  py = 1 << 16,
) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, y, seed + o * 17, px, py);
    norm += amp;
    x *= 2;
    y *= 2;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

// --------------------------------------------------------------- textures

type RGBA = [number, number, number, number?];

// Fills `count` canvases in one pass; `pixel` returns one color per canvas.
// u, v are in [0, 1) with v = 0 at the bottom (texture convention).
function paint(
  width: number,
  height: number,
  count: number,
  pixel: (u: number, v: number) => RGBA[],
) {
  const canvases = Array.from({ length: count }, () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  });
  const images = canvases.map((canvas) =>
    canvas.getContext('2d')!.createImageData(width, height),
  );
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colors = pixel((x + 0.5) / width, 1 - (y + 0.5) / height);
      const i = (y * width + x) * 4;
      for (let c = 0; c < count; c++) {
        const [r, g, b, a = 1] = colors[c];
        const data = images[c].data;
        data[i] = clamp01(r) * 255;
        data[i + 1] = clamp01(g) * 255;
        data[i + 2] = clamp01(b) * 255;
        data[i + 3] = clamp01(a) * 255;
      }
    }
  }
  canvases.forEach((canvas, c) =>
    canvas.getContext('2d')!.putImageData(images[c], 0, 0),
  );
  return canvases;
}

// A repeating texture; geometry UVs are in meters, so `meters` is the tile.
function tiled(
  canvas: HTMLCanvasElement,
  color: boolean,
  metersU: number,
  metersV = metersU,
) {
  const tex = own(new THREE.CanvasTexture(canvas));
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / metersU, 1 / metersV);
  tex.anisotropy = 8;
  return tex;
}

// A texture covering a centered w x h panel (UVs in meters).
function fitted(canvas: HTMLCanvasElement, w: number, h: number) {
  const tex = own(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(1 / w, 1 / h);
  tex.offset.set(0.5, 0.5);
  tex.anisotropy = 8;
  return tex;
}

function canvasTexture(canvas: HTMLCanvasElement) {
  const tex = own(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Engineered oak: a 2 m x 4 m tile of 20 cm planks, 1-2 m long.
const oakTextures = once(() => {
  const planks = 10;
  const lengths = [2, 4 / 3, 2, 1, 4 / 3, 2, 1, 4 / 3, 2, 4 / 3];
  const shifts = lengths.map((_, i) => hash(i, 3, 7) * 4);
  const [color, rough, bump] = paint(512, 1024, 3, (u, v) => {
    const column = Math.floor(u * planks);
    const across = u * planks - column;
    const along = mod(v * 4 + shifts[column], 4);
    const row = Math.floor(along / lengths[column]);
    const end = along - row * lengths[column];
    const seed = column * 31 + row * 7 + 1;
    const gap =
      Math.min(across, 1 - across) * 0.2 < 0.0012 ||
      Math.min(end, lengths[column] - end) < 0.0015;
    const offset = hash(seed, 1, 2) * 50;
    const warp = fbm(across * 2 + offset, along * 0.8, seed, 3) * 9;
    const grain = 0.5 + 0.5 * Math.sin(across * 26 + warp);
    const fine = fbm(across * 40, along * 2 + offset, seed + 3, 2);
    const tone = 0.94 + (hash(seed, 2, 9) - 0.5) * 0.12;
    const t = tone * (0.9 + 0.07 * grain + 0.06 * fine);
    const shade = gap ? 0.55 : 1;
    const r = gap ? 0.9 : 0.45 + 0.1 * hash(seed, 4, 4);
    const b = gap ? 0 : 0.7 + 0.12 * grain + 0.05 * fine;
    return [
      [0.8 * t * shade, 0.65 * t * shade, 0.48 * t * shade],
      [r, r, r],
      [b, b, b],
    ];
  });
  return {
    map: tiled(color, true, 2, 4),
    roughnessMap: tiled(rough, false, 2, 4),
    bumpMap: tiled(bump, false, 2, 4),
  };
});

// Fine plaster bump, 1 m tile.
const plasterBump = once(() => {
  const [canvas] = paint(256, 256, 1, (u, v) => {
    const b = 0.45 + 0.4 * fbm(u * 16, v * 16, 3, 4, 16, 16);
    return [[b, b, b]];
  });
  return tiled(canvas, false, 1);
});

// Woven fabric color + bump, 10 cm tile.
const fabricTextures = new Map<
  number,
  { map: THREE.Texture; bumpMap: THREE.Texture }
>();
function fabricTexture(seed: number) {
  let textures = fabricTextures.get(seed);
  if (!textures) {
    const threads = 48;
    const [color, bump] = paint(128, 128, 2, (u, v) => {
      const cell = (Math.floor(u * threads) + Math.floor(v * threads)) % 2;
      const warp = Math.sin(mod(u * threads, 1) * Math.PI);
      const weft = Math.sin(mod(v * threads, 1) * Math.PI);
      const thread = cell ? warp : weft;
      const slub = fbm(u * 6, v * 48, seed, 3, 6, 48);
      const t = 0.86 + 0.08 * thread + 0.1 * slub;
      return [
        [t, t, t],
        [thread, thread, thread],
      ];
    });
    textures = {
      map: tiled(color, true, 0.1),
      bumpMap: tiled(bump, false, 0.1),
    };
    fabricTextures.set(seed, textures);
  }
  return textures;
}

// Walnut veneer, 1 m tile, grain along U.
const walnutTexture = once(() => {
  const [canvas] = paint(512, 512, 1, (u, v) => {
    const warp = fbm(u * 3, v * 8, 11, 4, 3, 8) * 5;
    const ring = 0.5 + 0.5 * Math.sin((v * 90 + warp) * Math.PI);
    const pores = fbm(u * 160, v * 24, 12, 2, 160, 24);
    const t = 0.8 + 0.12 * ring + 0.1 * pores;
    return [[0.33 * t, 0.2 * t, 0.12 * t]];
  });
  return tiled(canvas, true, 1);
});

// Light oak veneer for furniture, 1 m tile, grain along U.
const oakVeneerTexture = once(() => {
  const [canvas] = paint(512, 512, 1, (u, v) => {
    const warp = fbm(u * 2, v * 6, 13, 4, 2, 6) * 6;
    const ring = 0.5 + 0.5 * Math.sin((v * 60 + warp) * Math.PI);
    const pores = fbm(u * 140, v * 20, 14, 2, 140, 20);
    const t = 0.88 + 0.07 * ring + 0.07 * pores;
    return [[0.78 * t, 0.62 * t, 0.44 * t]];
  });
  return tiled(canvas, true, 1);
});

// Short-pile carpet tiles, 50 cm tile with a faint seam.
const carpetTexture = once(() => {
  const [canvas] = paint(256, 256, 1, (u, v) => {
    const fiber =
      (fbm(u * 120, v * 120, 61, 2) - 0.5) * 0.12 +
      (fbm(u * 6, v * 6, 62, 3) - 0.5) * 0.06;
    const seam = Math.min(u, 1 - u, v, 1 - v) < 0.006 ? 0.92 : 1;
    const t = (0.62 + fiber) * seam;
    return [[t, t * 0.97, t * 0.92]];
  });
  return tiled(canvas, true, 0.5);
});

// Polished concrete, 2 m tile.
const concreteTexture = once(() => {
  const [canvas] = paint(512, 512, 1, (u, v) => {
    const cloud = fbm(u * 6, v * 6, 71, 5, 6, 6);
    const speck =
      hash(Math.floor(u * 512), Math.floor(v * 512), 72) > 0.985 ? 0.9 : 1;
    const t = (0.72 + 0.12 * cloud) * speck;
    return [[t, t * 0.98, t * 0.95]];
  });
  return tiled(canvas, true, 2);
});

// Square glazed tiles with grout; `color` is the tile color.
const tileTextures = new Map<string, THREE.Texture>();
function tileTexture(color: string, tile = 0.1) {
  const key = `${color}:${tile}`;
  let tex = tileTextures.get(key);
  if (!tex) {
    const c = new THREE.Color(color);
    const [canvas] = paint(256, 256, 1, (u, v) => {
      const gu = mod(u * 4, 1);
      const gv = mod(v * 4, 1);
      if (Math.min(gu, 1 - gu, gv, 1 - gv) < 0.03) return [[0.86, 0.84, 0.8]];
      const cell = hash(Math.floor(u * 4), Math.floor(v * 4), 81);
      const t = 0.92 + 0.12 * cell + 0.04 * fbm(u * 20, v * 20, 82, 2);
      return [[c.r * t, c.g * t, c.b * t]];
    });
    tex = tiled(canvas, true, tile * 4);
    tileTextures.set(key, tex);
  }
  return tex;
}

// Cork board, 50 cm tile.
const corkTexture = once(() => {
  const [canvas] = paint(256, 256, 1, (u, v) => {
    const grain = fbm(u * 60, v * 60, 91, 3);
    const t = 0.7 + 0.35 * grain;
    return [[0.72 * t, 0.53 * t, 0.36 * t]];
  });
  return tiled(canvas, true, 0.5);
});

// Rugs: 'lattice' (ivory field, charcoal lattice), 'border' (plain field with
// a band), 'stripe' (woven stripes) or 'plain'.
type RugStyle = 'lattice' | 'border' | 'stripe' | 'plain';
function rugCanvas(
  w: number,
  h: number,
  style: RugStyle,
  field: string,
  accent: string,
) {
  const f = new THREE.Color(field);
  const a = new THREE.Color(accent);
  const [canvas] = paint(512, Math.round((512 * h) / w), 1, (u, v) => {
    const x = u * w;
    const y = v * h;
    const fiber =
      (fbm(x * 140, y * 140, 21, 2) - 0.5) * 0.14 +
      (fbm(x * 3, y * 3, 22, 3) - 0.5) * 0.08;
    const border = Math.min(x, w - x, y, h - y);
    let accentHere = false;
    if (style === 'lattice') {
      const dx = Math.abs(mod(x / 0.32, 1) - 0.5);
      const dy = Math.abs(mod(y / 0.32, 1) - 0.5);
      accentHere =
        (border > 0.1 && border < 0.13) ||
        (border > 0.2 && Math.abs(dx + dy - 0.5) < 0.025);
    } else if (style === 'border') {
      accentHere = border > 0.08 && border < 0.16;
    } else if (style === 'stripe') {
      accentHere = mod(y / 0.24, 1) < 0.18;
    }
    const c = accentHere ? a : f;
    const t = 1 + fiber;
    return [[c.r * t, c.g * t, c.b * t]];
  });
  return canvas;
}

// Abstract painting with soft overlapping discs and a line.
function paintingTexture(seed: number, palette: string[], aspect: number) {
  const width = 512;
  const height = Math.round(width / aspect);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e9e2d4';
  ctx.fillRect(0, 0, width, height);
  ctx.filter = 'blur(1.2px)';
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = palette[i % palette.length];
    ctx.beginPath();
    const r = (0.14 + hash(i, 1, seed) * 0.16) * Math.min(width, height) * 1.4;
    ctx.arc(
      (0.2 + hash(i, 2, seed) * 0.6) * width,
      (0.25 + hash(i, 3, seed) * 0.5) * height,
      r,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = '#1d1d1d';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(width * 0.12, height * 0.8);
  ctx.bezierCurveTo(
    width * 0.35,
    height * 0.2,
    width * 0.65,
    height,
    width * 0.9,
    height * 0.2,
  );
  ctx.stroke();
  return canvasTexture(canvas);
}

// Line-drawn botanical print on paper.
function botanicalTexture(seed: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 600;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#efe9de';
  ctx.fillRect(0, 0, 400, 600);
  ctx.strokeStyle = '#3d4a3a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(200, 560);
  ctx.bezierCurveTo(190, 420, 230, 260, 205, 60);
  ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const y = 500 - i * 62;
    const side = (i + seed) % 2 ? 1 : -1;
    const x = 200 + Math.sin(i + seed) * 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + side * 90, y - 70, x + side * 120, y - 20);
    ctx.quadraticCurveTo(x + side * 70, y + 10, x, y);
    ctx.stroke();
  }
  return canvasTexture(canvas);
}

// Minimal landscape: layered hills under a sun disc.
function landscapeTexture(seed: number, aspect: number) {
  const width = 512;
  const height = Math.round(width / aspect);
  const hills = ['#c9b79c', '#9aa58a', '#6f7f62', '#556349'];
  const [canvas] = paint(width, height, 1, (u, v) => {
    const sun = Math.hypot(u - 0.62, (v - 0.72) / aspect) < 0.07;
    let c = new THREE.Color(sun ? '#c96f3e' : '#efe6d6');
    for (let i = 0; i < hills.length; i++) {
      const ridge =
        0.55 -
        i * 0.12 +
        0.06 * Math.sin(u * (3 + i) + seed + i * 2) +
        0.02 * fbm(u * 8, i, seed + i, 2);
      if (v < ridge) c = new THREE.Color(hills[i]);
    }
    return [[c.r, c.g, c.b]];
  });
  return canvasTexture(canvas);
}

// Bright, hazy view out of a window: sky, a tree line, a hedge.
const outsideTexture = once(() => {
  const [canvas] = paint(1024, 512, 1, (u, v) => {
    const sky: Vec3 = [
      mix(0.97, 0.9, v),
      mix(0.98, 0.94, v),
      mix(0.99, 0.98, v),
    ];
    const ridge =
      0.33 + 0.05 * fbm(u * 4, 0, 31, 3) + 0.02 * fbm(u * 40, v * 20, 32, 2);
    const foliage = clamp01((ridge - v) / 0.04);
    const leaf = fbm(u * 60, v * 40, 33, 4);
    const t = (0.45 + 0.6 * leaf) * mix(0.7, 1, v / 0.35);
    const haze = 0.2 * (v / 0.35);
    const green = [
      mix(0.42 * t, sky[0], haze),
      mix(0.52 * t, sky[1], haze),
      mix(0.36 * t, sky[2], haze),
    ];
    return [
      [
        mix(sky[0], green[0], foliage),
        mix(sky[1], green[1], foliage),
        mix(sky[2], green[2], foliage),
      ],
    ];
  });
  return canvasTexture(canvas);
});

// Softly lit corridor seen through interior glazing.
const corridorTexture = once(() => {
  const [canvas] = paint(512, 256, 1, (u, v) => {
    const wall = 0.8 + 0.06 * fbm(u * 4, v * 4, 101, 3);
    const floor = v < 0.22 ? 0.55 + 0.05 * fbm(u * 20, v * 20, 102, 2) : 0;
    const door =
      mod(u * 3, 1) > 0.42 && mod(u * 3, 1) < 0.58 && v < 0.75 && v >= 0.22;
    const light =
      Math.exp(-Math.pow((mod(u * 3, 1) - 0.5) / 0.25, 2)) * 0.08 * v;
    if (floor) return [[floor * 0.9, floor * 0.8, floor * 0.68]];
    if (door) return [[0.62, 0.5, 0.38]];
    const t = wall + light;
    return [[t, t * 0.98, t * 0.94]];
  });
  return canvasTexture(canvas);
});

// Broad leaf with veins; alpha cut-out.
const leafTextures = once(() => {
  const [color, bump] = paint(256, 256, 2, (u, v) => {
    const x = (u - 0.5) * 2;
    const waist = 1 - 0.12 * Math.exp(-Math.pow((v - 0.42) / 0.12, 2));
    const width =
      0.96 *
      Math.pow(Math.sin(Math.PI * Math.pow(Math.min(v, 0.999), 0.5)), 0.6) *
      (0.5 + 0.5 * v) *
      waist;
    const inside = Math.abs(x) < width ? 1 : 0;
    const midrib = Math.abs(x) < 0.025 ? 1 : 0;
    const vein =
      Math.abs(mod(v * 5 - Math.abs(x) * 1.3, 1) - 0.5) < 0.03 ? 1 : 0;
    const shade = 0.82 + 0.18 * fbm(u * 6, v * 6, 41, 3);
    const edge =
      1 - 0.2 * clamp01((Math.abs(x) / Math.max(width, 0.01) - 0.8) * 5);
    const light = (midrib ? 1.5 : vein ? 1.18 : 1) * edge;
    const height = midrib || vein ? 0.35 : 0.6;
    return [
      [
        0.19 * shade * light,
        0.31 * shade * light,
        0.12 * shade * light,
        inside,
      ],
      [height, height, height],
    ];
  });
  const map = canvasTexture(color);
  return { map, bumpMap: own(new THREE.CanvasTexture(bump)) };
});

// ---------------------------------------------------------------- geometry

// Scales BoxGeometry UVs (0..1 per face) to meters so tiled textures keep
// their real-world size on any box.
function meterUVs(
  geometry: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
) {
  const uv = geometry.getAttribute('uv');
  const perFace = uv.count / 6;
  const sizes = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i++) {
    const [su, sv] = sizes[Math.floor(i / perFace)];
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return geometry;
}

// Box with rounded edges; `puff` bulges the top/bottom faces like a cushion.
function roundedBox(
  w: number,
  h: number,
  d: number,
  r: number,
  puff = 0,
  segments = 4,
) {
  const geometry = own(
    meterUVs(
      new THREE.BoxGeometry(w, h, d, segments, segments, segments),
      w,
      h,
      d,
    ),
  );
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const p = new THREE.Vector3();
  const inner = new THREE.Vector3();
  const n = new THREE.Vector3();
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  const hz = d / 2 - r;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i);
    inner.set(
      THREE.MathUtils.clamp(p.x, -hx, hx),
      THREE.MathUtils.clamp(p.y, -hy, hy),
      THREE.MathUtils.clamp(p.z, -hz, hz),
    );
    n.subVectors(p, inner).normalize();
    p.copy(inner).addScaledVector(n, r);
    if (puff) {
      const fx = Math.max(0, 1 - Math.pow(p.x / (w / 2), 2));
      const fz = Math.max(0, 1 - Math.pow(p.z / (d / 2), 2));
      p.y += Math.sign(p.y) * puff * Math.sqrt(fx * fz);
    }
    position.setXYZ(i, p.x, p.y, p.z);
    normal.setXYZ(i, n.x, n.y, n.z);
  }
  if (puff) geometry.computeVertexNormals();
  return geometry;
}

// Rectangle in the XY plane, UVs in meters, with optional rectangular holes.
function panel(
  w: number,
  h: number,
  holes: [number, number, number, number][] = [],
) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -h / 2);
  shape.lineTo(w / 2, -h / 2);
  shape.lineTo(w / 2, h / 2);
  shape.lineTo(-w / 2, h / 2);
  for (const [x0, y0, x1, y1] of holes) {
    const hole = new THREE.Path();
    hole.moveTo(x0, y0);
    hole.lineTo(x0, y1);
    hole.lineTo(x1, y1);
    hole.lineTo(x1, y0);
    shape.holes.push(hole);
  }
  return own(new THREE.ShapeGeometry(shape));
}

const unitPlane = own(new THREE.PlaneGeometry(1, 1));

// --------------------------------------------------------------- materials

const standard = (params: THREE.MeshStandardMaterialParameters) =>
  own(new THREE.MeshStandardMaterial(params));

const mats = {
  trim: once(() => standard({ color: '#f3f1ec', roughness: 0.5 })),
  walnut: once(() => standard({ map: walnutTexture(), roughness: 0.5 })),
  darkWalnut: once(() =>
    standard({ map: walnutTexture(), color: '#8a7a70', roughness: 0.55 }),
  ),
  oak: once(() => standard({ map: oakVeneerTexture(), roughness: 0.55 })),
  blackMetal: once(() =>
    standard({ color: '#1a1a1a', roughness: 0.4, metalness: 0.85 }),
  ),
  steel: once(() =>
    standard({ color: '#b8b8b4', roughness: 0.3, metalness: 1 }),
  ),
  brass: once(() =>
    standard({ color: '#c6a062', roughness: 0.28, metalness: 1 }),
  ),
  ceramic: once(() => standard({ color: '#ebe6dc', roughness: 0.3 })),
  stoneware: once(() => standard({ color: '#4a4844', roughness: 0.55 })),
  terracotta: once(() => standard({ color: '#a65f40', roughness: 0.85 })),
  soil: once(() => standard({ color: '#2a2019', roughness: 1 })),
  white: once(() => standard({ color: '#f2efe9', roughness: 0.6 })),
  charcoal: once(() => standard({ color: '#2b2b2d', roughness: 0.75 })),
  stone: once(() => standard({ color: '#e4e0d8', roughness: 0.35 })),
  book: once(() => standard({ roughness: 0.8 })),
  pot: once(() => standard({ color: '#e4ded3', roughness: 0.85 })),
  glass: once(() =>
    standard({
      color: '#e6f0f5',
      roughness: 0.03,
      transparent: true,
      opacity: 0.12,
    }),
  ),
  hidden: once(() => own(new THREE.MeshBasicMaterial({ visible: false }))),
  bulb: once(() => {
    const material = own(new THREE.MeshBasicMaterial({ color: '#fff1dc' }));
    material.color.setScalar(5);
    return material;
  }),
  lampShade: once(() =>
    standard({
      color: '#efe4cf',
      roughness: 1,
      side: THREE.DoubleSide,
      emissive: '#ffc985',
      emissiveIntensity: 1.1,
    }),
  ),
  linenShade: once(() =>
    standard({ color: '#d8d0c2', roughness: 0.9, side: THREE.DoubleSide }),
  ),
  screen: once(() =>
    customizeEnvironment(
      standard({
        color: '#050506',
        roughness: 0.05,
        metalness: 0.2,
        envMapIntensity: 0.3,
      }),
      { boxProjected: true },
    ),
  ),
  mirror: once(() =>
    customizeEnvironment(
      standard({ color: '#d8dcdc', roughness: 0.15, metalness: 1 }),
      { boxProjected: true },
    ),
  ),
  leaf: once(() =>
    standard({
      ...leafTextures(),
      bumpScale: 0.6,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.45,
      envMapIntensity: 0.12,
    }),
  ),
  bark: once(() => standard({ color: '#5b4835', roughness: 0.9 })),
};

const coloredMaterials = new Map<string, THREE.MeshStandardMaterial>();
// A plain material by color, shared per (color, roughness, metalness).
function paintMaterial(color: string, roughness = 0.7, metalness = 0) {
  const key = `${color}:${roughness}:${metalness}`;
  let material = coloredMaterials.get(key);
  if (!material) {
    material = standard({ color, roughness, metalness });
    coloredMaterials.set(key, material);
  }
  return material;
}

const fabricMaterials = new Map<string, THREE.MeshStandardMaterial>();
// Woven upholstery in `color`.
function fabricMaterial(color: string, seed = 51) {
  const key = `${color}:${seed}`;
  let material = fabricMaterials.get(key);
  if (!material) {
    material = standard({
      color,
      roughness: 0.95,
      ...fabricTexture(seed),
      bumpScale: 0.5,
    });
    fabricMaterials.set(key, material);
  }
  return material;
}

// --------------------------------------------------------------- the room

type Occluder = { min: THREE.Vector3; max: THREE.Vector3; strength: number };

interface WindowSpec {
  wall: Wall;
  at: number;
  width: number;
  sill?: number;
  head?: number;
  // 'outside' (default) lets in daylight and sun; 'corridor' is interior
  // glazing onto a softly lit corridor, with a frosted band.
  view?: 'outside' | 'corridor';
  sheers?: boolean;
  mullions?: number;
  // Fraction (0..1) a roller blind is lowered.
  blind?: number;
}

interface DoorSpec {
  wall: Wall;
  at: number;
  width?: number;
  height?: number;
}

interface RoomSpec {
  name: string;
  width: number;
  depth: number;
  height?: number;
  // Back wall z; the default puts the origin 60% of the way to the front.
  z0?: number;
  windows: WindowSpec[];
  doors?: DoorSpec[];
  floor?: 'oak' | 'carpet' | 'concrete';
  wall?: string;
  // Sun through one outside window (`window` indexes the outside windows
  // only, skipping corridor glazing): elevation and azimuth in degrees
  // (azimuth turns it along the wall).
  sun?: { window?: number; elevation?: number; azimuth?: number };
  downlights?: [number, number][];
  texelsPerMeter?: number;
  // A robot vacuum driving an elliptical loop: visible, hit-testable and in
  // depth, but not a tracked plane/mesh.
  robot?: {
    center: [number, number];
    radius: [number, number];
    speed?: number;
  };
}

interface Win {
  wall: Wall;
  at: number;
  width: number;
  sill: number;
  head: number;
  exterior: boolean;
  light: number;
  normal: THREE.Vector3;
  u: THREE.Vector3;
  center: THREE.Vector3;
  samples: THREE.Vector3[];
  sampleArea: number;
  spec: WindowSpec;
}

interface RoomState {
  spec: RoomSpec;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
  windows: Win[];
  sunDirection: THREE.Vector3;
  sunTarget: THREE.Vector3;
  hasSun: boolean;
  patchSamples: THREE.Vector3[];
  patchSampleArea: number[];
  bounceScale: number;
  probe: THREE.Vector3;
  occluders: Occluder[];
  lit: { object: THREE.Mesh; w: number; h: number }[];
  wallColor: string;
}

let R: RoomState;
// Baked lightmap values are irradiance / LIGHTMAP_INTENSITY.
const LIGHTMAP_INTENSITY = 2.4;
const SUN_INTENSITY = 22;

function wallInfo(wall: Wall) {
  const { x0, x1, z0, z1, h } = R;
  const zc = (z0 + z1) / 2;
  const V = THREE.Vector3;
  switch (wall) {
    case 'back':
      return {
        normal: new V(0, 0, 1),
        u: new V(1, 0, 0),
        rotationY: 0,
        length: x1 - x0,
        center: new V(0, h / 2, z0),
        point: (at: number, y: number) => new V(at, y, z0),
      };
    case 'front':
      return {
        normal: new V(0, 0, -1),
        u: new V(-1, 0, 0),
        rotationY: Math.PI,
        length: x1 - x0,
        center: new V(0, h / 2, z1),
        point: (at: number, y: number) => new V(at, y, z1),
      };
    case 'left':
      return {
        normal: new V(1, 0, 0),
        u: new V(0, 0, -1),
        rotationY: Math.PI / 2,
        length: z1 - z0,
        center: new V(x0, h / 2, zc),
        point: (at: number, y: number) => new V(x0, y, at),
      };
    case 'right':
      return {
        normal: new V(-1, 0, 0),
        u: new V(0, 0, 1),
        rotationY: -Math.PI / 2,
        length: z1 - z0,
        center: new V(x1, h / 2, zc),
        point: (at: number, y: number) => new V(x1, y, at),
      };
  }
}

// Windows (with their sheers and rods) and doors must fit their wall and not
// overlap, or the wall holes and window geometry break.
function checkOpenings(spec: RoomSpec, h: number, z0: number) {
  // `owner` is the opening a span belongs to (a window and its sheers).
  const spans: {
    wall: Wall;
    from: number;
    to: number;
    name: string;
    owner: string;
  }[] = [];
  const add = (
    name: string,
    owner: string,
    wall: Wall,
    at: number,
    halfWidth: number,
    top: number,
  ) => {
    const [min, max] =
      wall === 'back' || wall === 'front'
        ? [-spec.width / 2, spec.width / 2]
        : [z0, z0 + spec.depth];
    if (at - halfWidth < min || at + halfWidth > max || top > h) {
      throw new Error(`${spec.name}: ${name} does not fit the ${wall} wall`);
    }
    spans.push({ wall, from: at - halfWidth, to: at + halfWidth, name, owner });
  };
  spec.windows.forEach((w, i) => {
    const sill = w.sill ?? 0.55;
    const head = w.head ?? Math.min(h - 0.35, 2.35);
    if (sill < 0 || sill >= head) {
      throw new Error(`${spec.name}: window ${i} needs 0 <= sill < head`);
    }
    add(`window ${i}`, `window ${i}`, w.wall, w.at, w.width / 2, head);
    const sheers = (w.view ?? 'outside') === 'outside' && !w.blind;
    if (sheers && w.sheers !== false) {
      add(
        `window ${i}'s sheers`,
        `window ${i}`,
        w.wall,
        w.at,
        w.width / 2 + 0.53,
        head + 0.17,
      );
    }
  });
  (spec.doors ?? []).forEach((d, i) =>
    add(
      `door ${i}`,
      `door ${i}`,
      d.wall,
      d.at,
      (d.width ?? 0.86) / 2,
      d.height ?? 2.06,
    ),
  );
  for (const a of spans) {
    for (const b of spans) {
      if (a.owner === b.owner || a.wall !== b.wall) continue;
      if (a.from < b.to && b.from < a.to) {
        throw new Error(`${spec.name}: ${a.name} overlaps ${b.name}`);
      }
    }
  }
}

function createRoom(spec: RoomSpec) {
  if (spec.width > MAX_ROOM_SIZE || spec.depth > MAX_ROOM_SIZE) {
    throw new Error(
      `${spec.name}: ${spec.width} x ${spec.depth} m exceeds the ${MAX_ROOM_SIZE} x ${MAX_ROOM_SIZE} m a Quest room scan supports`,
    );
  }
  const h = spec.height ?? 2.7;
  const z0 = spec.z0 ?? -spec.depth * 0.6;
  checkOpenings(spec, h, z0);
  R = {
    spec,
    x0: -spec.width / 2,
    x1: spec.width / 2,
    z0,
    z1: z0 + spec.depth,
    h,
    windows: [],
    sunDirection: new THREE.Vector3(0, -1, 0),
    sunTarget: new THREE.Vector3(),
    hasSun: false,
    patchSamples: [],
    patchSampleArea: [],
    bounceScale: 1,
    probe: new THREE.Vector3(0, 1.3, z0 + spec.depth / 2),
    occluders: [],
    lit: [],
    wallColor: spec.wall ?? '#eeeae3',
  };

  for (const w of spec.windows) {
    const info = wallInfo(w.wall);
    const sill = w.sill ?? 0.55;
    const head = w.head ?? Math.min(h - 0.35, 2.35);
    const exterior = (w.view ?? 'outside') === 'outside';
    const center = info.point(w.at, (sill + head) / 2);
    const samples: THREE.Vector3[] = [];
    const columns = Math.max(2, Math.round(w.width / 0.45));
    for (let i = 0; i < columns; i++) {
      for (let j = 0; j < 3; j++) {
        const along = -w.width / 2 + ((i + 0.5) / columns) * w.width;
        samples.push(
          info
            .point(w.at, sill + ((j + 0.5) / 3) * (head - sill))
            .addScaledVector(info.u, along),
        );
      }
    }
    R.windows.push({
      wall: w.wall,
      at: w.at,
      width: w.width,
      sill,
      head,
      exterior,
      light: exterior ? 1 : 0.3,
      normal: info.normal,
      u: info.u,
      center,
      samples,
      sampleArea: (w.width * (head - sill)) / samples.length,
      spec: w,
    });
  }

  // Sun through an outside window, landing on the floor.
  const outside = R.windows.filter((w) => w.exterior);
  const sunWindow = outside[spec.sun?.window ?? 0];
  if (sunWindow) {
    const elevation = THREE.MathUtils.degToRad(spec.sun?.elevation ?? 39);
    const azimuth = THREE.MathUtils.degToRad(spec.sun?.azimuth ?? 15);
    R.sunDirection = sunWindow.normal
      .clone()
      .multiplyScalar(Math.cos(elevation) * Math.cos(azimuth))
      .addScaledVector(sunWindow.u, Math.cos(elevation) * Math.sin(azimuth))
      .add(new THREE.Vector3(0, -Math.sin(elevation), 0))
      .normalize();
    R.sunTarget = sunWindow.center
      .clone()
      .addScaledVector(R.sunDirection, -sunWindow.center.y / R.sunDirection.y);
    R.hasSun = true;
    const d = R.sunDirection;
    for (const w of outside) {
      const facing = d.dot(w.normal);
      if (facing <= 0.05) continue;
      for (const s of w.samples) {
        const f = s.clone().addScaledVector(d, -s.y / d.y);
        if (f.x > R.x0 && f.x < R.x1 && f.z > R.z0 && f.z < R.z1) {
          R.patchSamples.push(f);
          R.patchSampleArea.push((w.sampleArea * facing) / -d.y);
        }
      }
    }
  }

  // Indirect light scales with how much window the room has for its size,
  // relative to the reference living room (a 2.1 x 1.8 m window, 116 m2).
  const surface =
    2 * spec.width * spec.depth + 2 * (spec.width + spec.depth) * h;
  const opening = R.windows.reduce(
    (sum, w) => sum + w.width * (w.head - w.sill) * w.light,
    0,
  );
  R.bounceScale = THREE.MathUtils.clamp(opening / surface / 0.0325, 0.6, 1.5);

  // A group on a wall at height y, `out` meters into the room, facing in.
  const onWall = (wall: Wall, at: number, y = 0, out = 0) => {
    const info = wallInfo(wall);
    const p = info.point(at, y).addScaledVector(info.normal, out);
    return group(p.x, p.y, p.z, info.rotationY);
  };

  return {
    bounds: { x0: R.x0, x1: R.x1, z0: R.z0, z1: R.z1, height: h },
    // A group at floor position (x, z), turned by rotationY.
    place(x: number, z: number, rotationY = 0, y = 0) {
      return group(x, y, z, rotationY);
    },
    onWall,
    // A group for furniture of the given depth standing against a wall.
    against(wall: Wall, at: number, depth: number, gap = 0.02) {
      return onWall(wall, at, 0, depth / 2 + gap);
    },
    finish,
  };
}

// --------------------------------------------------------------- helpers

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  [x, y, z]: Vec3,
  parent: THREE.Object3D = scene,
  { cast = true, receive = true } = {},
) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  object.castShadow = cast;
  object.receiveShadow = receive;
  parent.add(object);
  return object;
}

function box(
  [w, h, d]: Vec3,
  material: THREE.Material,
  position: Vec3,
  parent: THREE.Object3D = scene,
) {
  return mesh(
    own(meterUVs(new THREE.BoxGeometry(w, h, d), w, h, d)),
    material,
    position,
    parent,
  );
}

function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  material: THREE.Material,
  position: Vec3,
  parent: THREE.Object3D,
  segments = 24,
) {
  return mesh(
    own(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments)),
    material,
    position,
    parent,
  );
}

function group(
  x: number,
  y: number,
  z: number,
  rotationY = 0,
  parent: THREE.Object3D = scene,
) {
  const object = new THREE.Group();
  object.position.set(x, y, z);
  object.rotation.y = rotationY;
  parent.add(object);
  return object;
}

// Invisible furniture volume, reported as an XRMesh and used as an occluder
// for the baked lighting.
function volume(
  label: string,
  [w, h, d]: Vec3,
  position: Vec3,
  parent: THREE.Object3D,
  strength = 0.7,
) {
  const object = mesh(
    own(new THREE.BoxGeometry(w, h, d)),
    mats.hidden(),
    position,
    parent,
    { cast: false, receive: false },
  );
  object.userData.xrMesh = label;
  object.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3().setFromObject(object);
  R.occluders.push({ min: bounds.min, max: bounds.max, strength });
  return object;
}

// Like volume(), but only occludes the baked lighting: nothing is added to
// the scene or reported.
function occluder(
  _label: string,
  [w, h, d]: Vec3,
  [x, y, z]: Vec3,
  parent: THREE.Object3D,
  strength = 0.7,
) {
  parent.updateWorldMatrix(true, false);
  const bounds = new THREE.Box3(
    new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
    new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
  ).applyMatrix4(parent.matrixWorld);
  R.occluders.push({ min: bounds.min, max: bounds.max, strength });
}

// Registers a flat mesh (UVs = local XY in meters over a centered w x h
// rectangle) for a baked lightmap. Its material must not be shared.
function litSurface(object: THREE.Mesh, w: number, h: number) {
  R.lit.push({ object, w, h });
  return object;
}

// --------------------------------------------------------- baked lighting

const toSample = new THREE.Vector3();
const closest = new THREE.Vector3();
const center = new THREE.Vector3();

// True if the segment a -> b passes through the box (slab test).
function blocks(a: THREE.Vector3, b: THREE.Vector3, o: Occluder) {
  let t0 = 0.0001;
  let t1 = 0.9999;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < o.min[axis] || a[axis] > o.max[axis]) return false;
      continue;
    }
    let near = (o.min[axis] - a[axis]) / delta;
    let far = (o.max[axis] - a[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

const inside = (p: THREE.Vector3, o: Occluder) =>
  p.x > o.min.x - 0.02 &&
  p.x < o.max.x + 0.02 &&
  p.y > o.min.y - 0.02 &&
  p.y < o.max.y + 0.02 &&
  p.z > o.min.z - 0.02 &&
  p.z < o.max.z + 0.02;

// Ambient occlusion from room corners and nearby furniture.
function occlusion(p: THREE.Vector3, n: THREE.Vector3, active: Occluder[]) {
  const planes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), -R.x0],
    [new THREE.Vector3(-1, 0, 0), R.x1],
    [new THREE.Vector3(0, 1, 0), 0],
    [new THREE.Vector3(0, -1, 0), R.h],
    [new THREE.Vector3(0, 0, 1), -R.z0],
    [new THREE.Vector3(0, 0, -1), R.z1],
  ];
  let ao = 1;
  for (const [normal, d] of planes) {
    if (Math.abs(normal.dot(n)) > 0.5) continue;
    const distance = Math.max(0, normal.dot(p) + d);
    ao *=
      (1 - 0.45 * Math.exp(-distance / 0.3)) *
      (1 - 0.2 * Math.exp(-distance / 0.04));
  }
  for (const o of active) {
    center.addVectors(o.min, o.max).multiplyScalar(0.5);
    if (n.dot(toSample.subVectors(center, p)) < 0) continue;
    closest.copy(p).clamp(o.min, o.max);
    const distance = closest.distanceTo(p);
    ao *=
      (1 - o.strength * Math.exp(-distance / 0.25)) *
      (1 - 0.5 * Math.exp(-distance / 0.04));
  }
  return ao;
}

// Diffuse irradiance (relative units) at p with normal n: skylight through
// the windows (area lights shadowed by furniture), bounce from the sun patch
// and a warm multi-bounce ambient. `self` ignores the volume containing p.
function irradiance(
  p: THREE.Vector3,
  n: THREE.Vector3,
  self = false,
): [number, number, number] {
  const active = self ? R.occluders.filter((o) => !inside(p, o)) : R.occluders;
  let sky = 0;
  for (const w of R.windows) {
    for (const s of w.samples) {
      toSample.subVectors(s, p);
      const d2 = Math.max(toSample.lengthSq(), 0.05);
      toSample.normalize();
      const cosP = n.dot(toSample);
      const cosW = -w.normal.dot(toSample);
      if (cosP <= 0 || cosW <= 0) continue;
      if (active.some((o) => blocks(p, s, o))) continue;
      sky += (w.light * cosP * cosW * w.sampleArea) / (Math.PI * d2);
    }
  }
  let patch = 0;
  for (let i = 0; i < R.patchSamples.length; i++) {
    toSample.subVectors(R.patchSamples[i], p);
    const d2 = Math.max(toSample.lengthSq(), 0.1);
    toSample.normalize();
    const cosP = n.dot(toSample);
    const cosE = -toSample.y;
    if (cosP > 0 && cosE > 0)
      patch += (cosP * cosE * R.patchSampleArea[i]) / (Math.PI * d2);
  }
  const ao = occlusion(p, n, active);
  const bounce =
    ((1.2 * R.bounceScale) / LIGHTMAP_INTENSITY) * ao * (n.y < -0.5 ? 0.7 : 1);
  const direct = sky * (0.6 + 0.4 * ao) * 1.6;
  // Floor exitance in the patch: sun x cos(elevation) x albedo (0.45).
  const warm =
    ((SUN_INTENSITY * -R.sunDirection.y * 0.45) / LIGHTMAP_INTENSITY) *
    patch *
    (Math.abs(n.y) < 0.5 && p.y < R.h / 2 ? 1.25 : 1);
  return [
    bounce * 1.0 + direct * 0.93 + warm,
    bounce * 0.9 + direct * 0.95 + warm * 0.85,
    bounce * 0.78 + direct * 1.0 + warm * 0.66,
  ];
}

// Bakes a half-float lightmap for a registered lit surface.
function bakeLightmap(object: THREE.Object3D, w: number, h: number) {
  object.updateWorldMatrix(true, false);
  // Keep textures modest in large rooms.
  const texelsPerMeter = Math.min(
    R.spec.texelsPerMeter ?? 24,
    256 / Math.max(w, h),
  );
  const width = Math.max(8, Math.round(w * texelsPerMeter));
  const height = Math.max(8, Math.round(h * texelsPerMeter));
  const data = new Uint16Array(width * height * 4);
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(
    object.matrixWorld,
  );
  const p = new THREE.Vector3();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      p.set(((x + 0.5) / width - 0.5) * w, ((y + 0.5) / height - 0.5) * h, 0);
      p.applyMatrix4(object.matrixWorld);
      const [r, g, b] = irradiance(p, normal);
      const i = (y * width + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = own(
    new THREE.DataTexture(
      data,
      width,
      height,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    ),
  );
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.repeat.set(1 / w, 1 / h);
  tex.offset.set(0.5, 0.5);
  tex.needsUpdate = true;
  return tex;
}

// Environment shader tweaks:
// - boxProjected: the probe is parallax-corrected against the room box, so
//   the window reflects where it actually is.
// - specularOnly: lightmapped surfaces already have their diffuse light, so
//   they only take reflections from the probe.
function customizeEnvironment(
  material: THREE.MeshStandardMaterial,
  { boxProjected = false, specularOnly = false },
) {
  let chunk = THREE.ShaderChunk.envmap_physical_pars_fragment;
  if (boxProjected) {
    // The world-space reflection line: `inverseTransformDirection` in current
    // three.js, `transformDirectionByInverseViewMatrix` in older versions.
    const patched = chunk.replace(
      /reflectVec = (?:inverseTransformDirection|transformDirectionByInverseViewMatrix)\( reflectVec, viewMatrix \);/,
      (line) => `${line}
      vec3 boxHit = mix( boxMin, boxMax, step( 0.0, reflectVec ) );
      vec3 boxT = ( boxHit - vBoxWorldPosition ) / reflectVec;
      float boxDistance = min( min( boxT.x, boxT.y ), boxT.z );
      reflectVec = normalize( vBoxWorldPosition + reflectVec * boxDistance - probePosition );`,
    );
    if (patched === chunk) {
      console.warn(
        'Box-projected reflections are not supported by this three.js version',
      );
    }
    chunk = patched;
  }
  if (specularOnly) {
    chunk = chunk.replace(
      'return PI * envMapColor.rgb * envMapIntensity;',
      'return vec3( 0.0 );',
    );
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.boxMin = { value: new THREE.Vector3(R.x0, 0, R.z0) };
    shader.uniforms.boxMax = { value: new THREE.Vector3(R.x1, R.h, R.z1) };
    shader.uniforms.probePosition = { value: R.probe };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vBoxWorldPosition;',
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvBoxWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vBoxWorldPosition;\nuniform vec3 boxMin;\nuniform vec3 boxMax;\nuniform vec3 probePosition;',
      )
      .replace('#include <envmap_physical_pars_fragment>', chunk);
  };
  material.customProgramCacheKey = () =>
    `environment:${boxProjected}:${specularOnly}`;
  return material;
}

// Room surfaces get their indirect light from baked lightmaps, so their
// environment map only contributes reflections. One material per surface.
function shellMaterial(params: THREE.MeshStandardMaterialParameters) {
  const material = standard({
    envMapIntensity: 0.5,
    lightMapIntensity: LIGHTMAP_INTENSITY,
    ...params,
  });
  material.shadowSide = THREE.DoubleSide;
  return customizeEnvironment(material, { specularOnly: true });
}

function floorMaterial() {
  switch (R.spec.floor ?? 'oak') {
    case 'carpet':
      return shellMaterial({
        map: carpetTexture(),
        roughness: 1,
        envMapIntensity: 0.1,
      });
    case 'concrete':
      return customizeEnvironment(
        shellMaterial({
          map: concreteTexture(),
          roughness: 0.55,
          envMapIntensity: 0.6,
        }),
        { boxProjected: true, specularOnly: true },
      );
    default:
      return customizeEnvironment(
        shellMaterial({
          ...oakTextures(),
          bumpScale: 0.15,
          roughness: 1,
          envMapIntensity: 0.5,
        }),
        { boxProjected: true, specularOnly: true },
      );
  }
}

function wallMaterial() {
  return shellMaterial({
    color: R.wallColor,
    roughness: 0.9,
    bumpMap: plasterBump(),
    bumpScale: 0.12,
  });
}

// ------------------------------------------------------------------ shell

function buildShell() {
  const { x0, x1, z0, z1, h } = R;
  const W = x1 - x0;
  const D = z1 - z0;
  const zc = (z0 + z1) / 2;
  const SEAM = 0.004;

  const floor = mesh(panel(W, D), floorMaterial(), [0, 0, zc], scene, {
    cast: false,
  });
  floor.rotation.x = -Math.PI / 2;
  floor.userData.xrPlane = 'floor';
  litSurface(floor, W, D);
  const ceiling = mesh(
    panel(W, D),
    shellMaterial({ color: '#f7f4ef', roughness: 0.95 }),
    [0, h, zc],
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.userData.xrPlane = 'ceiling';
  litSurface(ceiling, W, D);

  // Walls overlap the floor, ceiling and each other slightly so no seam
  // shows a hairline.
  for (const wall of WALLS) {
    const info = wallInfo(wall);
    const holes = R.windows
      .filter((w) => w.wall === wall)
      .map((w): [number, number, number, number] => {
        const lx = w.center.clone().sub(info.center).dot(info.u);
        return [
          lx - w.width / 2,
          w.sill - h / 2,
          lx + w.width / 2,
          w.head - h / 2,
        ];
      });
    const object = mesh(
      panel(info.length + SEAM, h + SEAM, holes),
      wallMaterial(),
      [info.center.x, info.center.y, info.center.z],
    );
    object.rotation.y = info.rotationY;
    object.userData.xrPlane = 'wall';
    litSurface(object, info.length + SEAM, h + SEAM);
    // Baseboard.
    const base = group(info.center.x, 0, info.center.z, info.rotationY);
    box([info.length, 0.09, 0.014], mats.trim(), [0, 0.045, 0.007], base);
  }

  buildShadowShell();
  for (const w of R.windows) buildWindow(w);
  for (const d of R.spec.doors ?? []) buildDoor(d);

  // Recessed downlights (off during the day): trim ring and lens.
  const ring = own(new THREE.RingGeometry(0.045, 0.062, 32));
  const lens = own(new THREE.CircleGeometry(0.045, 32));
  const lensMaterial = paintMaterial('#dcd7ce', 0.3);
  const lights =
    R.spec.downlights ??
    [x0 + W / 4, x1 - W / 4].flatMap((x) =>
      (D > 6 ? [z0 + D / 6, zc, z1 - D / 6] : [z0 + D / 4, z1 - D / 4]).map(
        (z): [number, number] => [x, z],
      ),
    );
  for (const [x, z] of lights) {
    mesh(ring, mats.trim(), [x, h - 0.002, z], scene, {
      cast: false,
    }).rotation.x = Math.PI / 2;
    mesh(lens, lensMaterial, [x, h - 0.004, z], scene, {
      cast: false,
    }).rotation.x = Math.PI / 2;
  }
}

// Shadow-only shell: thick boxes around the room (with the outside window
// openings) so no sunlight leaks in where the thin wall and ceiling planes
// meet. They write neither color nor depth and ignore hit-test rays.
function buildShadowShell() {
  const { x0, x1, z0, z1, h } = R;
  const caster = own(
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
  );
  caster.shadowSide = THREE.DoubleSide;
  const slab = (min: Vec3, max: Vec3) => {
    const object = box(
      [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      caster,
      [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    );
    object.receiveShadow = false;
    object.userData.shadowOnly = true;
  };
  const t = 0.2;
  const inset = 0.03;
  const margin = 0.4;
  slab(
    [x0 - margin, h - inset, z0 - margin],
    [x1 + margin, h + t, z1 + margin],
  );
  for (const wall of WALLS) {
    const openings = R.windows.filter((w) => w.wall === wall && w.exterior);
    // Walls with openings sit outside the window reveals, so the reveals
    // catch the sun.
    const [near, far] = openings.length ? [0.2, 0.2 + t] : [-inset, t];
    const horizontal = wall === 'back' || wall === 'front';
    const [lo, hi] = horizontal
      ? [x0 - margin, x1 + margin]
      : [z0 - margin, z1 + margin];
    const cuts = [
      lo,
      hi,
      ...openings.flatMap((w) => [w.at - w.width / 2, w.at + w.width / 2]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const [u0, u1] = [cuts[i], cuts[i + 1]];
      if (u1 - u0 < 1e-4) continue;
      const opening = openings.find(
        (w) =>
          (u0 + u1) / 2 > w.at - w.width / 2 &&
          (u0 + u1) / 2 < w.at + w.width / 2,
      );
      const spans: [number, number][] = opening
        ? [
            [-0.1, opening.sill],
            [opening.head, h + t],
          ]
        : [[-0.1, h + t]];
      for (const [y0, y1] of spans) {
        if (wall === 'back') slab([u0, y0, z0 - far], [u1, y1, z0 - near]);
        if (wall === 'front') slab([u0, y0, z1 + near], [u1, y1, z1 + far]);
        if (wall === 'left') slab([x0 - far, y0, u0], [x0 - near, y1, u1]);
        if (wall === 'right') slab([x1 + near, y0, u0], [x1 + far, y1, u1]);
      }
    }
  }
}

const curtainMaterial = once(() =>
  standard({
    vertexColors: true,
    color: '#f5f2ea',
    roughness: 1,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.82,
    emissive: '#fff6e6',
    emissiveIntensity: 0.25,
  }),
);

// Window: reveal, frame, glass, the view outside, sheers or a blind. The
// WebXR plane is flush with the wall, as a room scan reports it.
function buildWindow(w: Win) {
  const info = wallInfo(w.wall);
  const base = info.point(w.at, 0);
  const win = group(base.x, 0, base.z, info.rotationY);
  const { width, sill, head } = w;
  const reveal = 0.16;
  // Reveals have no lightmap, so they take their diffuse light from the probe.
  const revealMaterial = standard({
    color: R.wallColor,
    roughness: 0.9,
    bumpMap: plasterBump(),
    bumpScale: 0.12,
    envMapIntensity: 1,
  });
  revealMaterial.shadowSide = THREE.DoubleSide;
  box(
    [0.02, head - sill, reveal],
    revealMaterial,
    [-width / 2 - 0.01, (sill + head) / 2, -reveal / 2],
    win,
  );
  box(
    [0.02, head - sill, reveal],
    revealMaterial,
    [width / 2 + 0.01, (sill + head) / 2, -reveal / 2],
    win,
  );
  box(
    [width, 0.02, reveal],
    revealMaterial,
    [0, head + 0.01, -reveal / 2],
    win,
  );
  box(
    [width + 0.12, 0.03, reveal + 0.06],
    mats.trim(),
    [0, sill - 0.015, -reveal / 2 + 0.03],
    win,
  );
  const frameZ = -reveal + 0.04;
  box([width, 0.05, 0.06], mats.trim(), [0, sill + 0.025, frameZ], win);
  box([width, 0.05, 0.06], mats.trim(), [0, head - 0.025, frameZ], win);
  box(
    [0.05, head - sill, 0.06],
    mats.trim(),
    [-width / 2 + 0.025, (sill + head) / 2, frameZ],
    win,
  );
  box(
    [0.05, head - sill, 0.06],
    mats.trim(),
    [width / 2 - 0.025, (sill + head) / 2, frameZ],
    win,
  );
  const mullions =
    w.spec.mullions ??
    (width > 1.4 ? Math.max(1, Math.round(width / 1.2) - 1) : 0);
  for (let i = 1; i <= mullions; i++) {
    box(
      [0.05, head - sill, 0.06],
      mats.trim(),
      [-width / 2 + (i * width) / (mullions + 1), (sill + head) / 2, frameZ],
      win,
    );
  }
  const glass = mesh(
    unitPlane,
    mats.glass(),
    [0, (sill + head) / 2, frameZ],
    win,
    { cast: false, receive: false },
  );
  glass.scale.set(width, head - sill, 1);
  const plane = mesh(
    unitPlane,
    mats.hidden(),
    [0, (sill + head) / 2, 0.002],
    win,
    { cast: false, receive: false },
  );
  plane.scale.set(width, head - sill, 1);
  plane.userData.xrPlane = 'window';

  if (w.exterior) {
    const view = own(new THREE.MeshBasicMaterial({ map: outsideTexture() }));
    view.color.setScalar(4); // overexposed, like a photo of a window
    const outside = mesh(unitPlane, view, [0, 1.3, -4], win, {
      cast: false,
      receive: false,
    });
    outside.scale.set(Math.max(12, width * 3), 6, 1);
    outside.userData.xrGlobalMesh = false; // outside the room, not scanned
  } else {
    const view = own(new THREE.MeshBasicMaterial({ map: corridorTexture() }));
    view.color.setScalar(1.25);
    const corridor = mesh(unitPlane, view, [0, R.h / 2, -1.6], win, {
      cast: false,
      receive: false,
    });
    corridor.scale.set(width + 2, R.h, 1);
    corridor.userData.xrGlobalMesh = false; // beyond the glass, not scanned
    const frosted = mesh(
      unitPlane,
      standard({
        color: '#ffffff',
        roughness: 0.9,
        transparent: true,
        opacity: 0.6,
      }),
      [0, 1.3, frameZ + 0.004],
      win,
      { cast: false, receive: false },
    );
    frosted.scale.set(width, 0.5, 1);
  }

  if (w.spec.blind) {
    const drop = (head - sill) * w.spec.blind;
    cylinder(
      0.03,
      0.03,
      width - 0.04,
      paintMaterial('#e8e1d4', 0.9),
      [0, head - 0.04, -0.03],
      win,
      16,
    ).rotation.z = Math.PI / 2;
    const fabric = mesh(
      unitPlane,
      standard({
        color: '#e8e1d4',
        roughness: 1,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        emissive: '#fff4e2',
        emissiveIntensity: 0.3,
      }),
      [0, head - 0.04 - drop / 2, -0.01],
      win,
      { cast: true, receive: false },
    );
    fabric.scale.set(width - 0.06, drop, 1);
  } else if (w.exterior && w.spec.sheers !== false) {
    mesh(
      own(new THREE.CylinderGeometry(0.012, 0.012, width + 1, 12)),
      mats.brass(),
      [0, head + 0.15, 0.1],
      win,
    ).rotation.z = Math.PI / 2;
    for (const [x, seed] of [
      [-width / 2 - 0.22, 1],
      [width / 2 + 0.22, 4],
    ]) {
      const height = head + 0.13;
      const geometry = own(new THREE.PlaneGeometry(0.62, height, 48, 8));
      const position = geometry.getAttribute('position');
      const colors = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i++) {
        const px = position.getX(i);
        const py = position.getY(i) / height + 0.5;
        const phase = (px / 0.11) * Math.PI * 2 + Math.sin(px * 9 + seed) * 1.2;
        const fold = Math.sin(phase);
        position.setZ(i, fold * 0.03 * (0.8 + 0.2 * py));
        colors.fill(0.85 + 0.15 * (fold * 0.5 + 0.5), i * 3, i * 3 + 3);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();
      mesh(geometry, curtainMaterial(), [x, height / 2 + 0.02, 0.1], win, {
        cast: false,
      });
    }
  }
}

// Door: slab with a dark gap, trim and a lever handle.
function buildDoor(d: DoorSpec) {
  const info = wallInfo(d.wall);
  const base = info.point(d.at, 0);
  const door = group(base.x, 0, base.z, info.rotationY);
  const width = d.width ?? 0.86;
  const height = d.height ?? 2.06;
  box(
    [width, height + 0.005, 0.01],
    paintMaterial('#3a3836', 1),
    [0, (height + 0.005) / 2, 0.005],
    door,
  );
  const slab = mesh(
    roundedBox(width - 0.006, height - 0.004, 0.04, 0.004, 0, 2),
    mats.trim(),
    [0, (height - 0.004) / 2, 0.022],
    door,
  );
  slab.userData.xrPlane = 'door';
  for (const [w, h, x, y] of [
    [0.07, height + 0.07, -width / 2 - 0.035, (height + 0.07) / 2],
    [0.07, height + 0.07, width / 2 + 0.035, (height + 0.07) / 2],
    [width + 0.14, 0.07, 0, height + 0.035],
  ]) {
    box([w, h, 0.022], mats.trim(), [x, y, 0.011], door);
  }
  box([0.025, 0.12, 0.012], mats.brass(), [width / 2 - 0.07, 1.0, 0.05], door);
  mesh(
    own(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 12)),
    mats.brass(),
    [width / 2 - 0.11, 1.02, 0.07],
    door,
  ).rotation.z = Math.PI / 2;
}

// --------------------------------------------------------------- finishing

// Bakes ambient occlusion into furniture as vertex colors (and instance
// colors): darker near the floor and next to other furniture.
function bakeFurnitureShading() {
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const shade = (y: number) => {
    const ao = occlusion(
      p,
      n,
      R.occluders.filter((o) => !inside(p, o)),
    );
    const floor = n.y > 0.7 ? 1 : 1 - 0.35 * Math.exp(-y / 0.15);
    return THREE.MathUtils.clamp(0.55 + 0.45 * ao, 0.55, 1) * floor;
  };
  const skip = (material: THREE.Material) => {
    const m = material as THREE.MeshStandardMaterial;
    return (
      !m.isMeshStandardMaterial ||
      m === mats.trim() ||
      m.transparent ||
      !m.visible ||
      !!m.lightMap ||
      m.emissive.getHex() !== 0
    );
  };
  const seen = new Set<THREE.BufferGeometry>();
  const shaded = new Set<THREE.Material>();
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    const target = object as THREE.Mesh;
    if (!target.isMesh || skip(target.material as THREE.Material)) return;
    shaded.add(target.material as THREE.Material);
    const instanced = object as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const matrix = new THREE.Matrix4();
      const color = new THREE.Color();
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, matrix);
        p.setFromMatrixPosition(matrix.premultiply(instanced.matrixWorld));
        n.set(0, 1, 0);
        const f = shade(p.y);
        if (instanced.instanceColor) instanced.getColorAt(i, color);
        else color.setRGB(1, 1, 1);
        instanced.setColorAt(i, color.multiplyScalar(f));
      }
      return;
    }
    if (seen.has(target.geometry))
      target.geometry = own(target.geometry.clone());
    seen.add(target.geometry);
    const position = target.geometry.getAttribute('position');
    const normal = target.geometry.getAttribute('normal');
    const colors = new Float32Array(position.count * 3);
    normalMatrix.getNormalMatrix(target.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(target.matrixWorld);
      n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      colors.fill(shade(p.y), i * 3, i * 3 + 3);
    }
    target.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
  shaded.forEach((material) => (material.vertexColors = true));
  // Shared materials on meshes without a color attribute get plain white.
  scene.traverse((object) => {
    const target = object as THREE.Mesh;
    if (!target.isMesh || !(target.material as THREE.Material).vertexColors)
      return;
    if (target.geometry.getAttribute('color')) return;
    const count = target.geometry.getAttribute('position').count;
    target.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3),
    );
  });
}

// Merges static meshes that share a material into one draw call each.
// Labelled meshes stay separate so they remain WebXR planes / meshes.
function mergeStaticMeshes() {
  scene.updateMatrixWorld(true);
  // Objects tagged xrGlobalMesh = false (moving objects, views outside) stay
  // separate, so they keep their tag and can still move.
  const untracked = (object: THREE.Object3D | null) => {
    for (; object; object = object.parent) {
      if (object.userData.xrGlobalMesh === false) return true;
    }
    return false;
  };
  const buckets = new Map<string, THREE.Mesh[]>();
  scene.traverse((object) => {
    const target = object as THREE.Mesh;
    if (!target.isMesh || (target as THREE.InstancedMesh).isInstancedMesh)
      return;
    const material = target.material as THREE.Material;
    if (!material.visible || material.transparent) return;
    if (target.userData.xrPlane || target.userData.xrMesh) return;
    if (untracked(target)) return;
    const attributes = Object.keys(target.geometry.attributes).sort().join();
    const key = `${material.uuid}:${target.castShadow}:${target.receiveShadow}:${attributes}`;
    buckets.set(key, [...(buckets.get(key) ?? []), target]);
  });
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const names = Object.keys(meshes[0].geometry.attributes);
    const vertexCount = meshes.reduce(
      (sum, m) => sum + m.geometry.getAttribute('position').count,
      0,
    );
    const arrays = Object.fromEntries(
      names.map((name) => [
        name,
        new Float32Array(
          vertexCount * meshes[0].geometry.getAttribute(name).itemSize,
        ),
      ]),
    );
    const indices: number[] = [];
    let base = 0;
    for (const m of meshes) {
      const geometry = m.geometry.clone();
      geometry.applyMatrix4(m.matrixWorld);
      for (const name of names) {
        const attribute = geometry.getAttribute(name);
        arrays[name].set(
          attribute.array as Float32Array,
          base * attribute.itemSize,
        );
      }
      const index = geometry.getIndex();
      const count = geometry.getAttribute('position').count;
      if (index)
        for (let i = 0; i < index.count; i++)
          indices.push(index.getX(i) + base);
      else for (let i = 0; i < count; i++) indices.push(i + base);
      base += count;
      geometry.dispose();
      m.removeFromParent();
    }
    const merged = own(new THREE.BufferGeometry());
    for (const name of names) {
      merged.setAttribute(
        name,
        new THREE.BufferAttribute(
          arrays[name],
          meshes[0].geometry.getAttribute(name).itemSize,
        ),
      );
    }
    merged.setIndex(indices);
    const combined = new THREE.Mesh(merged, meshes[0].material);
    if (meshes[0].userData.shadowOnly) combined.raycast = () => {};
    combined.castShadow = meshes[0].castShadow;
    combined.receiveShadow = meshes[0].receiveShadow;
    scene.add(combined);
  }
}

// True if the ray from p back towards the sun leaves through an outside window.
function sunThroughWindow(p: THREE.Vector3) {
  const toSun = R.sunDirection.clone().negate();
  for (const w of R.windows) {
    if (!w.exterior) continue;
    const denom = -w.normal.dot(toSun);
    if (denom <= 1e-4) continue;
    const t = w.normal.dot(toSample.subVectors(p, w.center)) / denom;
    if (t <= 0) continue;
    const q = p.clone().addScaledVector(toSun, t);
    if (
      q.y > w.sill &&
      q.y < w.head &&
      Math.abs(q.clone().sub(w.center).dot(w.u)) < w.width / 2
    )
      return true;
  }
  return false;
}

// Environment probe: an HDR equirect painted by ray casting the room from
// its center and shading each hit with the same baked irradiance, so
// reflections show the actual room, windows and sun patch.
function roomEnvironment() {
  const width = 96;
  const height = 48;
  const data = new Float32Array(width * height * 4);
  const probe = R.probe;
  // Average linear albedo of each floor texture.
  const floorAlbedo = {
    oak: [0.4, 0.27, 0.15],
    carpet: [0.34, 0.32, 0.29],
    concrete: [0.48, 0.46, 0.43],
  }[R.spec.floor ?? 'oak'];
  const d = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const n = new THREE.Vector3();
  const room = {
    min: new THREE.Vector3(R.x0, 0, R.z0),
    max: new THREE.Vector3(R.x1, R.h, R.z1),
    strength: 0,
  };
  const exit = (o: Occluder) => {
    let t = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[axis]) < 1e-6) continue;
      const bound = d[axis] > 0 ? o.max[axis] : o.min[axis];
      t = Math.min(t, (bound - probe[axis]) / d[axis]);
    }
    return t;
  };
  const entry = (o: Occluder) => {
    let near = -Infinity;
    let far = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[axis]) < 1e-6) {
        if (probe[axis] < o.min[axis] || probe[axis] > o.max[axis])
          return Infinity;
        continue;
      }
      const a = (o.min[axis] - probe[axis]) / d[axis];
      const b = (o.max[axis] - probe[axis]) / d[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    return near > 0 && near <= far ? near : Infinity;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const theta = ((y + 0.5) / height - 0.5) * Math.PI;
      d.set(
        Math.cos(theta) * Math.cos(phi),
        Math.sin(theta),
        Math.cos(theta) * Math.sin(phi),
      );
      let t = exit(room);
      let furniture: Occluder | undefined;
      for (const o of R.occluders) {
        const te = entry(o);
        if (te < t) {
          t = te;
          furniture = o;
        }
      }
      hit.copy(probe).addScaledVector(d, t);
      const boxHit = furniture ?? room;
      const sign = furniture ? 1 : -1;
      if (Math.abs(hit.x - boxHit.min.x) < 1e-3) n.set(-sign, 0, 0);
      else if (Math.abs(hit.x - boxHit.max.x) < 1e-3) n.set(sign, 0, 0);
      else if (Math.abs(hit.y - boxHit.min.y) < 1e-3) n.set(0, -sign, 0);
      else if (Math.abs(hit.y - boxHit.max.y) < 1e-3) n.set(0, sign, 0);
      else if (Math.abs(hit.z - boxHit.min.z) < 1e-3) n.set(0, 0, -sign);
      else n.set(0, 0, sign);
      const window = furniture
        ? undefined
        : R.windows.find(
            (w) =>
              n.dot(w.normal) > 0.5 &&
              hit.y > w.sill &&
              hit.y < w.head &&
              Math.abs(hit.clone().sub(w.center).dot(w.u)) < w.width / 2,
          );
      let rgb: number[];
      if (window) {
        rgb = window.exterior ? [3.2, 3.4, 3.6] : [0.9, 0.88, 0.84];
      } else {
        const albedo = furniture
          ? [0.3, 0.28, 0.26]
          : n.y > 0.5
            ? floorAlbedo
            : n.y < -0.5
              ? [0.9, 0.87, 0.83]
              : [0.82, 0.77, 0.69];
        const e = irradiance(hit, n);
        rgb = albedo.map((a, i) => (a * e[i] * LIGHTMAP_INTENSITY) / Math.PI);
        if (R.hasSun && !furniture && n.y > 0.5 && sunThroughWindow(hit)) {
          const sun = (SUN_INTENSITY * -R.sunDirection.y * 0.45) / Math.PI;
          rgb = [rgb[0] + sun, rgb[1] + sun * 0.86, rgb[2] + sun * 0.67];
        }
      }
      data.set([rgb[0], rgb[1], rgb[2], 1], (y * width + x) * 4);
    }
  }
  const tex = own(
    new THREE.DataTexture(
      data,
      width,
      height,
      THREE.RGBAFormat,
      THREE.FloatType,
    ),
  );
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Afternoon sun through the window: a static shadow, rendered once.
function addSun() {
  if (!R.hasSun) return;
  // Owned so its shadow map is freed when the room unloads.
  const sun = own(new THREE.DirectionalLight('#ffdcaa', SUN_INTENSITY));
  const position = R.sunTarget.clone().addScaledVector(R.sunDirection, -12);
  sun.position.copy(position);
  sun.target.position.copy(R.sunTarget);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Fit the shadow frustum tightly around the room (outside it would be lit).
  const view = new THREE.Matrix4().lookAt(
    position,
    R.sunTarget,
    new THREE.Vector3(0, 1, 0),
  );
  view.setPosition(position).invert();
  const bounds = new THREE.Box3();
  for (const x of [R.x0 - 0.3, R.x1 + 0.3]) {
    for (const y of [0, R.h]) {
      for (const z of [R.z0 - 0.3, R.z1 + 0.3])
        bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(view));
    }
  }
  Object.assign(sun.shadow.camera, {
    left: bounds.min.x - 0.05,
    right: bounds.max.x + 0.05,
    bottom: bounds.min.y - 0.05,
    top: bounds.max.y + 0.05,
    near: -bounds.max.z - 0.5,
    far: -bounds.min.z + 0.5,
  });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 0.8;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);
}

// Robot vacuum: added after the bake and merge so it stays a separate,
// movable object. Like on real devices it is not a tracked plane/mesh. Its
// materials are its own, since the bake may have set vertexColors on shared
// ones, and it casts no shadow into the sun's shadow map, which is rendered
// once; the blob shadow follows it instead.
function addRobot({
  center,
  radius,
  speed = 0.35,
}: NonNullable<RoomSpec['robot']>) {
  const robot = new THREE.Group();
  robot.name = 'robot';
  // It moves, so it is not part of the room's global mesh.
  robot.userData.xrGlobalMesh = false;
  scene.add(robot);
  mesh(
    own(new THREE.CylinderGeometry(0.17, 0.17, 0.075, 48)),
    standard({ color: '#232325', roughness: 0.25, metalness: 0.1 }),
    [0, 0.045, 0],
    robot,
    { cast: false },
  );
  mesh(
    own(new THREE.TorusGeometry(0.17, 0.012, 8, 48)),
    standard({ color: '#4a4a4c', roughness: 0.6 }),
    [0, 0.03, 0],
    robot,
    { cast: false },
  ).rotation.x = Math.PI / 2;
  mesh(
    own(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 32)),
    standard({ color: '#3a3a3c', roughness: 0.4 }),
    [0, 0.095, 0.06],
    robot,
    { cast: false },
  );
  mesh(
    own(new THREE.CircleGeometry(0.008, 12)),
    mats.bulb(),
    [0.05, 0.0835, -0.1],
    robot,
    { cast: false },
  ).rotation.x = -Math.PI / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 24, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const shadow = mesh(
    own(new THREE.PlaneGeometry(0.4, 0.4)),
    own(
      new THREE.MeshBasicMaterial({
        color: 'black',
        alphaMap: own(new THREE.CanvasTexture(canvas)),
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    ),
    [0, 0.008, 0],
    robot,
    { cast: false, receive: false },
  );
  shadow.rotation.x = -Math.PI / 2;
  let time = 0;
  const place = () => {
    const angle = time * speed;
    robot.position.set(
      center[0] + Math.cos(angle) * radius[0],
      0,
      center[1] + Math.sin(angle) * radius[1],
    );
    robot.rotation.y = Math.atan2(
      Math.sin(angle) * radius[0],
      -Math.cos(angle) * radius[1],
    );
  };
  place();
  onFrame((delta) => {
    time += delta;
    place();
  });
}

function finish() {
  buildShell();
  for (const { object, w, h } of R.lit) {
    (object.material as THREE.MeshStandardMaterial).lightMap = bakeLightmap(
      object,
      w,
      h,
    );
  }
  bakeFurnitureShading();
  mergeStaticMeshes();
  scene.background = new THREE.Color('#e6e1d8');
  scene.environment = roomEnvironment();
  scene.environmentIntensity = 1.2;
  addSun();
  scene.rendering.shadows = true;
  scene.rendering.toneMapping = THREE.AgXToneMapping;
  scene.rendering.toneMappingExposure = 0.95;
  if (R.spec.robot) addRobot(R.spec.robot);

  let entities = 0;
  scene.traverse((object) => {
    if (object.userData.xrPlane) entities++;
    if (object.userData.xrMesh) entities++;
  });
  if (entities > MAX_ENTITIES) {
    console.warn(
      `${R.spec.name}: ${entities} planes and meshes; a scanned room usually reports at most ${MAX_ENTITIES}`,
    );
  }
}

// ---------------------------------------------------------------- seating

// A room scan reports a couch as a volume plus a seat plane; the seat plane is
// invisible (the cushions are what you see and hit).
function couchSeat(
  g: THREE.Object3D,
  width: number,
  depth: number,
  height: number,
  z = 0,
) {
  const seat = mesh(unitPlane, mats.hidden(), [0, height, z], g, {
    cast: false,
    receive: false,
  });
  seat.rotation.x = -Math.PI / 2;
  seat.scale.set(width, depth, 1);
  seat.userData.xrPlane = 'couch';
  return seat;
}

// Three-seat (or two-seat) sofa with seat and back cushions and two pillows.
function sofa(
  g: THREE.Object3D,
  { width = 2.1, color = '#7f868b', pillows = ['#c79e68', '#e8e2d5'] } = {},
) {
  const fabric = fabricMaterial(color, 51);
  mesh(roundedBox(width, 0.2, 0.92, 0.04), fabric, [0, 0.19, 0], g);
  mesh(roundedBox(width, 0.52, 0.2, 0.07), fabric, [0, 0.55, -0.36], g);
  for (const s of [-1, 1]) {
    mesh(
      roundedBox(0.2, 0.38, 0.92, 0.07, 0.008),
      fabric,
      [s * (width / 2 - 0.1), 0.45, 0],
      g,
    );
    for (const z of [-0.36, 0.36])
      cylinder(
        0.016,
        0.011,
        0.09,
        mats.blackMetal(),
        [s * (width / 2 - 0.08), 0.045, z],
        g,
        10,
      ).castShadow = false;
  }
  const seats = width > 1.7 ? 3 : 2;
  const seat = (width - 0.4) / seats;
  for (let i = 0; i < seats; i++) {
    const x = -width / 2 + 0.2 + seat * (i + 0.5);
    mesh(
      roundedBox(seat - 0.008, 0.16, 0.68, 0.06, 0.022, 6),
      fabric,
      [x, 0.37, 0.1],
      g,
    );
    mesh(
      roundedBox(seat - 0.015, 0.46, 0.2, 0.09, 0.025, 6),
      fabric,
      [x, 0.66, -0.2],
      g,
    ).rotation.x = -0.2;
  }
  pillows.forEach((pillow, i) => {
    const side = i === 0 ? -1 : 1;
    const object = mesh(
      roundedBox(0.46, 0.46, 0.13, 0.07, 0.04, 6),
      fabricMaterial(pillow, 52 + i),
      [side * (width / 2 - 0.38), 0.67, -0.07],
      g,
    );
    object.rotation.set(-0.3, -side * 0.3, side * 0.13);
  });
  couchSeat(g, width - 0.4, 0.66, 0.45, 0.1);
  volume('couch', [width, 0.86, 0.94], [0, 0.43, 0], g, 0.85);
  return g;
}

// Upholstered armchair with wooden legs.
function armchair(g: THREE.Object3D, { color = '#b2643e' } = {}) {
  const fabric = fabricMaterial(color, 54);
  mesh(roundedBox(0.78, 0.28, 0.8, 0.06, 0.008), fabric, [0, 0.29, 0], g);
  mesh(
    roundedBox(0.66, 0.12, 0.62, 0.05, 0.022, 6),
    fabric,
    [0, 0.48, 0.06],
    g,
  );
  mesh(
    roundedBox(0.78, 0.5, 0.14, 0.06, 0.008),
    fabric,
    [0, 0.65, -0.33],
    g,
  ).rotation.x = -0.14;
  for (const s of [-1, 1]) {
    mesh(roundedBox(0.1, 0.22, 0.74, 0.045), fabric, [s * 0.36, 0.55, 0.02], g);
    for (const z of [-0.32, 0.32])
      mesh(
        roundedBox(0.035, 0.16, 0.035, 0.012),
        mats.walnut(),
        [s * 0.32, 0.08, z],
        g,
      ).rotation.z = s * 0.12;
  }
  couchSeat(g, 0.62, 0.58, 0.54, 0.06);
  volume('couch', [0.8, 0.9, 0.82], [0, 0.45, 0], g, 0.6);
  return g;
}

// Lounge chair: wooden side frames with seat and back cushions.
function loungeChair(
  g: THREE.Object3D,
  { color = '#7d8a6a', wood = mats.walnut() } = {},
) {
  const fabric = fabricMaterial(color, 57);
  for (const s of [-1, 1]) {
    mesh(roundedBox(0.04, 0.04, 0.78, 0.012), wood, [s * 0.34, 0.56, 0], g);
    const front = mesh(
      roundedBox(0.04, 0.58, 0.04, 0.012),
      wood,
      [s * 0.34, 0.28, 0.32],
      g,
    );
    front.rotation.x = 0.08;
    const back = mesh(
      roundedBox(0.04, 0.8, 0.04, 0.012),
      wood,
      [s * 0.34, 0.4, -0.3],
      g,
    );
    back.rotation.x = -0.32;
  }
  mesh(roundedBox(0.66, 0.11, 0.6, 0.04, 0.02, 6), fabric, [0, 0.4, 0.04], g);
  const back = mesh(
    roundedBox(0.62, 0.52, 0.11, 0.04, 0.015, 6),
    fabric,
    [0, 0.7, -0.24],
    g,
  );
  back.rotation.x = -0.32;
  couchSeat(g, 0.62, 0.56, 0.455, 0.04);
  volume('couch', [0.74, 0.88, 0.84], [0, 0.44, 0], g, 0.5);
  return g;
}

// Wooden dining chair.
function woodChair(g: THREE.Object3D, { wood = mats.oak() } = {}) {
  mesh(roundedBox(0.44, 0.03, 0.42, 0.012), wood, [0, 0.45, 0], g);
  const back = mesh(
    roundedBox(0.42, 0.16, 0.025, 0.01),
    wood,
    [0, 0.76, -0.2],
    g,
  );
  back.rotation.x = 0.1;
  for (const x of [-0.19, 0.19]) {
    for (const z of [-0.18, 0.18]) {
      const height = z < 0 ? 0.84 : 0.44;
      mesh(
        roundedBox(0.025, height, 0.025, 0.008),
        wood,
        [x, height / 2, z],
        g,
      );
    }
  }
  volume('other', [0.44, 0.85, 0.42], [0, 0.425, 0], g, 0.4);
  return g;
}

// Office task chair on a five-star base.
function taskChair(g: THREE.Object3D, { color = '#2f3033' } = {}) {
  const fabric = fabricMaterial(color, 58);
  const plastic = mats.charcoal();
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spoke = box(
      [0.03, 0.025, 0.3],
      plastic,
      [Math.sin(angle) * 0.15, 0.06, Math.cos(angle) * 0.15],
      g,
    );
    spoke.rotation.y = angle;
    mesh(
      own(new THREE.SphereGeometry(0.025, 10, 8)),
      plastic,
      [Math.sin(angle) * 0.29, 0.025, Math.cos(angle) * 0.29],
      g,
    );
  }
  cylinder(0.022, 0.022, 0.36, mats.steel(), [0, 0.24, 0], g, 12);
  mesh(roundedBox(0.5, 0.08, 0.48, 0.03, 0.012, 4), fabric, [0, 0.46, 0.02], g);
  const back = mesh(
    roundedBox(0.46, 0.56, 0.06, 0.03, 0, 4),
    fabric,
    [0, 0.82, -0.22],
    g,
  );
  back.rotation.x = -0.1;
  box([0.04, 0.3, 0.03], plastic, [0, 0.58, -0.24], g).rotation.x = -0.1;
  for (const s of [-1, 1]) {
    box([0.025, 0.18, 0.025], plastic, [s * 0.25, 0.56, 0.02], g);
    mesh(
      roundedBox(0.06, 0.025, 0.24, 0.01),
      plastic,
      [s * 0.25, 0.66, 0.02],
      g,
    );
  }
  volume('other', [0.62, 1.1, 0.62], [0, 0.55, 0], g, 0.35);
  return g;
}

// Upholstered shell chair on slim metal legs (meeting rooms).
function shellChair(g: THREE.Object3D, { color = '#7d8a6a' } = {}) {
  const fabric = fabricMaterial(color, 59);
  mesh(roundedBox(0.5, 0.09, 0.48, 0.04, 0.012, 4), fabric, [0, 0.46, 0.02], g);
  const back = mesh(
    roundedBox(0.52, 0.36, 0.08, 0.04, 0, 4),
    fabric,
    [0, 0.7, -0.21],
    g,
  );
  back.rotation.x = -0.14;
  for (const s of [-1, 1])
    mesh(
      roundedBox(0.07, 0.2, 0.4, 0.03, 0, 4),
      fabric,
      [s * 0.24, 0.58, -0.02],
      g,
    );
  for (const x of [-0.2, 0.2]) {
    for (const z of [-0.18, 0.2]) {
      const leg = cylinder(
        0.01,
        0.008,
        0.44,
        mats.blackMetal(),
        [x * 1.05, 0.22, z * 1.05],
        g,
        8,
      );
      leg.rotation.set(z > 0 ? 0.08 : -0.08, 0, x > 0 ? -0.06 : 0.06);
    }
  }
  volume('other', [0.58, 0.88, 0.56], [0, 0.44, 0], g, 0.35);
  return g;
}

// Bar or counter stool with a round seat and a foot ring.
function stool(g: THREE.Object3D, { height = 0.65, wood = mats.oak() } = {}) {
  cylinder(0.18, 0.17, 0.04, wood, [0, height - 0.02, 0], g, 32);
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = cylinder(
      0.014,
      0.016,
      height - 0.03,
      wood,
      [Math.sin(angle) * 0.14, (height - 0.03) / 2, Math.cos(angle) * 0.14],
      g,
      8,
    );
    leg.rotation.set(Math.cos(angle) * 0.1, 0, -Math.sin(angle) * 0.1);
  }
  const ring = mesh(
    own(new THREE.TorusGeometry(0.15, 0.008, 6, 32)),
    mats.blackMetal(),
    [0, height * 0.35, 0],
    g,
  );
  ring.rotation.x = Math.PI / 2;
  volume('other', [0.4, height, 0.4], [0, height / 2, 0], g, 0.3);
  return g;
}

// ------------------------------------------------------------ tables, desks

type LegStyle = 'four' | 'frame' | 'pedestal';

// Rectangular table: the top is a WebXR plane (`label`, default 'table').
function table(
  g: THREE.Object3D,
  {
    width = 1.2,
    depth = 0.75,
    height = 0.74,
    top = mats.oak() as THREE.Material,
    legs = 'four' as LegStyle,
    legMaterial = mats.blackMetal() as THREE.Material,
    label = 'table',
  } = {},
) {
  const surface = mesh(
    roundedBox(width, 0.03, depth, 0.01),
    top,
    [0, height - 0.015, 0],
    g,
  );
  surface.userData.xrPlane = label;
  const legHeight = height - 0.03;
  if (legs === 'pedestal') {
    cylinder(0.04, 0.05, legHeight, legMaterial, [0, legHeight / 2, 0], g, 16);
    cylinder(
      Math.min(width, depth) * 0.28,
      Math.min(width, depth) * 0.3,
      0.02,
      legMaterial,
      [0, 0.01, 0],
      g,
      32,
    );
  } else {
    const inset = 0.06;
    for (const x of [-width / 2 + inset, width / 2 - inset]) {
      for (const z of [-depth / 2 + inset, depth / 2 - inset]) {
        mesh(
          roundedBox(0.04, legHeight, 0.04, 0.008),
          legMaterial,
          [x, legHeight / 2, z],
          g,
        );
      }
      if (legs === 'frame')
        box([0.04, 0.03, depth - 2 * inset], legMaterial, [x, 0.04, 0], g);
    }
  }
  volume(label, [width, height, depth], [0, height / 2, 0], g, 0.45);
  return g;
}

// Round pedestal table: the top is a WebXR plane.
function roundTable(
  g: THREE.Object3D,
  {
    radius = 0.45,
    height = 0.74,
    top = mats.oak() as THREE.Material,
    label = 'table',
  } = {},
) {
  const surface = mesh(
    own(new THREE.CylinderGeometry(radius, radius, 0.03, 64)),
    top,
    [0, height - 0.015, 0],
    g,
  );
  surface.userData.xrPlane = label;
  cylinder(
    0.04,
    0.05,
    height - 0.03,
    mats.blackMetal(),
    [0, (height - 0.03) / 2, 0],
    g,
    16,
  );
  cylinder(
    radius * 0.53,
    radius * 0.58,
    0.02,
    mats.blackMetal(),
    [0, 0.01, 0],
    g,
    48,
  );
  volume(label, [radius * 2, height, radius * 2], [0, height / 2, 0], g, 0.45);
  return g;
}

// Desk: a 'desk' table, optionally with a drawer pedestal on one side.
function desk(
  g: THREE.Object3D,
  {
    width = 1.4,
    depth = 0.7,
    height = 0.74,
    top = mats.oak() as THREE.Material,
    drawers = 'right' as 'left' | 'right' | 'none',
  } = {},
) {
  table(g, { width, depth, height, top, legs: 'four', label: 'desk' });
  if (drawers !== 'none') {
    const side = drawers === 'right' ? 1 : -1;
    const pedestal = group(side * (width / 2 - 0.26), 0, 0, 0, g);
    casegood(pedestal, {
      width: 0.4,
      height: height - 0.04,
      depth: depth - 0.12,
      fronts: 'drawers',
      count: 3,
      body: top,
      label: '',
    });
  }
  return g;
}

// ---------------------------------------------------------------- storage

// Cabinet, sideboard, dresser, nightstand or wardrobe: a carcass with door
// or drawer fronts (or open shelves), optional legs, reported as an XRMesh
// (`label`, default 'shelf'; '' for none).
function casegood(
  g: THREE.Object3D,
  {
    width = 1.2,
    height = 0.75,
    depth = 0.45,
    fronts = 'doors' as 'doors' | 'drawers' | 'open',
    count = 2,
    body = mats.walnut() as THREE.Material,
    front = undefined as THREE.Material | undefined,
    legs = 0,
    handles = 'bar' as 'bar' | 'knob' | 'none',
    label = 'shelf',
  } = {},
) {
  const h = height - legs;
  const y0 = legs;
  const faces = front ?? body;
  if (fronts === 'open') {
    for (const x of [-width / 2 + 0.01, width / 2 - 0.01])
      box([0.02, h, depth], body, [x, y0 + h / 2, 0], g);
    box([width, h, 0.012], body, [0, y0 + h / 2, -depth / 2 + 0.006], g);
    for (let i = 0; i <= count; i++)
      box(
        [width - 0.04, 0.02, depth],
        body,
        [0, y0 + 0.01 + (i * (h - 0.02)) / count, 0],
        g,
      );
  } else {
    box([width, h, depth], body, [0, y0 + h / 2, 0], g);
    const columns = fronts === 'doors' ? count : 1;
    const rows = fronts === 'drawers' ? count : 1;
    const cw = width / columns;
    const ch = h / rows;
    for (let c = 0; c < columns; c++) {
      for (let r = 0; r < rows; r++) {
        const x = -width / 2 + cw * (c + 0.5);
        const y = y0 + ch * (r + 0.5);
        box(
          [cw - 0.006, ch - 0.006, 0.018],
          faces,
          [x, y, depth / 2 + 0.009],
          g,
        );
        if (handles === 'bar') {
          if (fronts === 'drawers')
            box(
              [Math.min(0.16, cw * 0.4), 0.012, 0.014],
              mats.blackMetal(),
              [x, y + ch * 0.25, depth / 2 + 0.025],
              g,
            );
          else
            box(
              [0.012, Math.min(0.18, ch * 0.3), 0.014],
              mats.blackMetal(),
              [x + (c % 2 ? -1 : 1) * (cw / 2 - 0.05), y, depth / 2 + 0.025],
              g,
            );
        } else if (handles === 'knob') {
          mesh(
            own(new THREE.SphereGeometry(0.014, 12, 8)),
            mats.brass(),
            [
              fronts === 'drawers' ? x : x + (c % 2 ? -1 : 1) * (cw / 2 - 0.05),
              y + (fronts === 'drawers' ? ch * 0.2 : 0),
              depth / 2 + 0.03,
            ],
            g,
          );
        }
      }
    }
  }
  if (legs > 0) {
    for (const x of [-width / 2 + 0.05, width / 2 - 0.05]) {
      for (const z of [-depth / 2 + 0.05, depth / 2 - 0.05])
        cylinder(0.016, 0.011, legs, mats.walnut(), [x, legs / 2, z], g, 8);
    }
  }
  if (label)
    volume(
      label,
      [width, height, depth + 0.03],
      [0, height / 2, 0.015],
      g,
      0.7,
    );
  return g;
}

// Open bookshelf filled with instanced books.
function bookshelf(
  g: THREE.Object3D,
  {
    width = 0.9,
    height = 1.9,
    depth = 0.34,
    levels = 5,
    wood = mats.walnut() as THREE.Material,
    seed = 0,
  } = {},
) {
  for (const x of [-width / 2, width / 2])
    box([0.025, height, depth], wood, [x, height / 2, 0], g);
  box(
    [width, height, 0.012],
    wood === mats.walnut() ? mats.darkWalnut() : wood,
    [0, height / 2, -depth / 2 + 0.006],
    g,
  );
  const ys = Array.from(
    { length: levels + 1 },
    (_, i) => 0.05 + (i * (height - 0.06)) / levels,
  );
  for (const y of ys) box([width, 0.025, depth], wood, [0, y, 0], g);
  const palette = [
    '#2f3e46',
    '#b08d57',
    '#e3dccf',
    '#7a3b2e',
    '#55624a',
    '#cbb79a',
    '#3c3c3c',
    '#8c4f3b',
  ];
  const capacity = levels * 40;
  const books = own(
    new THREE.InstancedMesh(
      own(new THREE.BoxGeometry(1, 1, 1)),
      mats.book(),
      capacity,
    ),
  );
  books.castShadow = books.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const color = new THREE.Color();
  const spacing = (height - 0.06) / levels;
  let count = 0;
  for (let level = 0; level < levels; level++) {
    let x = -width / 2 + 0.02;
    const y = ys[level] + 0.0125;
    const end = (level + seed) % 2 ? width * 0.15 : width / 2 - 0.02;
    while (x < end - 0.03 && count < capacity) {
      const k = count + seed * 97;
      const thickness = 0.018 + hash(k, 5, 5) * 0.03;
      const tall = Math.min(spacing - 0.04, 0.19 + hash(k, 6, 6) * 0.11);
      const deep = Math.min(depth - 0.04, 0.17 + hash(k, 7, 7) * 0.07);
      rotation.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        x + thickness > end - 0.05 ? -0.18 : 0,
      );
      matrix.compose(
        new THREE.Vector3(x + thickness / 2, y + tall / 2, 0.02),
        rotation,
        new THREE.Vector3(thickness, tall, deep),
      );
      books.setMatrixAt(count, matrix);
      color.set(palette[Math.floor(hash(k, 8, 8) * palette.length)]);
      books.setColorAt(count, color.multiplyScalar(0.8 + hash(k, 9, 9) * 0.3));
      x += thickness + 0.0015;
      count++;
    }
  }
  books.count = count;
  g.add(books);
  volume('shelf', [width, height, depth], [0, height / 2, 0], g, 0.7);
  return g;
}

// ---------------------------------------------------------------- lighting

// Table lamp; `lit` adds a warm point light (use at most two per room).
function tableLamp(g: THREE.Object3D, { lit = false } = {}) {
  const base = mesh(
    own(new THREE.SphereGeometry(0.085, 24, 16)),
    mats.ceramic(),
    [0, 0.09, 0],
    g,
  );
  base.scale.y = 1.1;
  cylinder(0.009, 0.009, 0.18, mats.brass(), [0, 0.24, 0], g, 8);
  mesh(
    own(new THREE.CylinderGeometry(0.12, 0.16, 0.22, 40, 1, true)),
    lit ? mats.lampShade() : mats.linenShade(),
    [0, 0.38, 0],
    g,
    { cast: false },
  );
  if (lit) {
    mesh(
      own(new THREE.SphereGeometry(0.03, 12, 8)),
      mats.bulb(),
      [0, 0.33, 0],
      g,
      { cast: false, receive: false },
    );
    const glow = new THREE.PointLight('#ffc27a', 1.4, 3.5, 2);
    glow.position.set(0, 0.35, 0);
    g.add(glow);
  }
  volume('lamp', [0.32, 0.5, 0.32], [0, 0.25, 0], g, 0.3);
  return g;
}

// Floor lamp with a drum shade.
function floorLamp(g: THREE.Object3D, { lit = false } = {}) {
  cylinder(0.14, 0.15, 0.02, mats.blackMetal(), [0, 0.01, 0], g, 40);
  cylinder(0.009, 0.009, 1.45, mats.blackMetal(), [0, 0.74, 0], g, 10);
  mesh(
    own(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 48, 1, true)),
    lit ? mats.lampShade() : mats.linenShade(),
    [0, 1.55, 0],
    g,
  );
  const diffuser = mesh(
    own(new THREE.CircleGeometry(0.19, 40)),
    paintMaterial('#cfc7b8', 1),
    [0, 1.67, 0],
    g,
    { cast: false },
  );
  diffuser.rotation.x = Math.PI / 2;
  if (lit) {
    const glow = new THREE.PointLight('#ffc27a', 1.6, 4, 2);
    glow.position.set(0, 1.5, 0);
    g.add(glow);
  }
  volume('lamp', [0.4, 1.72, 0.4], [0, 0.86, 0], g, 0.4);
  return g;
}

// Pendant lamp hanging from a ceiling point (put `g` on the ceiling).
function pendant(
  g: THREE.Object3D,
  { drop = 0.75, color = '#a65f40', radius = 0.2 } = {},
) {
  cylinder(0.05, 0.05, 0.015, mats.blackMetal(), [0, -0.008, 0], g, 24);
  cylinder(0.003, 0.003, drop, mats.blackMetal(), [0, -drop / 2, 0], g, 6);
  const shade = mesh(
    own(
      new THREE.SphereGeometry(radius, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    ),
    standard({ color, roughness: 0.6, side: THREE.DoubleSide }),
    [0, -drop - radius * 0.55, 0],
    g,
  );
  shade.scale.y = 0.75;
  volume(
    'lamp',
    [radius * 2, radius * 0.8, radius * 2],
    [0, -drop - radius * 0.35, 0],
    g,
    0.2,
  );
  return g;
}

// Adjustable desk lamp (no volume: it sits on a desk volume).
function deskLamp(g: THREE.Object3D) {
  cylinder(0.07, 0.08, 0.02, mats.blackMetal(), [0, 0.01, 0], g, 24);
  const lower = cylinder(
    0.008,
    0.008,
    0.34,
    mats.blackMetal(),
    [0.05, 0.17, 0],
    g,
    8,
  );
  lower.rotation.z = -0.3;
  const upper = cylinder(
    0.008,
    0.008,
    0.3,
    mats.blackMetal(),
    [0.03, 0.42, 0],
    g,
    8,
  );
  upper.rotation.z = 1.1;
  const head = mesh(
    own(new THREE.ConeGeometry(0.06, 0.12, 24, 1, true)),
    standard({ color: '#1f1f1f', roughness: 0.5, side: THREE.DoubleSide }),
    [-0.12, 0.47, 0],
    g,
  );
  head.rotation.z = 0.9;
  return g;
}

// ------------------------------------------------------------------ plants

// Leafy floor plant (fiddle-leaf fig style) in a pot.
function plant(
  g: THREE.Object3D,
  { height = 1.7, pot = mats.pot() as THREE.Material, seed = 0 } = {},
) {
  const s = height / 1.95;
  const potRadius = 0.19 * Math.max(0.7, s);
  cylinder(potRadius, potRadius * 0.82, 0.38 * s, pot, [0, 0.19 * s, 0], g, 40);
  cylinder(
    potRadius * 0.94,
    potRadius * 0.94,
    0.01,
    mats.soil(),
    [0, 0.37 * s, 0],
    g,
    24,
  );
  mesh(
    own(
      new THREE.CylinderGeometry(0.014, 0.026, 1.5 * s, 8).translate(
        0,
        0.75 * s,
        0,
      ),
    ),
    mats.bark(),
    [0, 0.36 * s, 0],
    g,
  );
  const leafGeometry = own(new THREE.PlaneGeometry(0.28, 0.38, 3, 4));
  const lp = leafGeometry.getAttribute('position');
  for (let i = 0; i < lp.count; i++) {
    const x = lp.getX(i);
    const y = lp.getY(i) + 0.19;
    lp.setXYZ(i, x, y + 0.04, Math.abs(x) * 0.3 - Math.pow(y / 0.38, 2) * 0.05);
  }
  leafGeometry.computeVertexNormals();
  const twig = own(
    new THREE.CylinderGeometry(0.007, 0.011, 1, 6).translate(0, 0.5, 0),
  );
  const anchors: { at: THREE.Vector3; yaw: number }[] = [];
  for (let b = 0; b < 4; b++) {
    const start = new THREE.Vector3(0, (1.05 + b * 0.19) * s, 0);
    const yaw = b * 2.1 + seed;
    const length = (0.42 - b * 0.05) * s;
    const direction = new THREE.Vector3(
      Math.sin(yaw) * 0.75,
      0.66,
      Math.cos(yaw) * 0.75,
    ).normalize();
    const branch = mesh(twig, mats.bark(), [start.x, start.y, start.z], g);
    branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    branch.scale.set(1, length, 1);
    for (let k = 1; k <= 3; k++)
      anchors.push({
        at: start.clone().addScaledVector(direction, (length * k) / 3),
        yaw,
      });
  }
  for (let k = 0; k < 10; k++)
    anchors.push({
      at: new THREE.Vector3(0.02, (1.0 + k * 0.08) * s, 0.01),
      yaw: k * 2.39996 + seed,
    });
  const leaves = own(
    new THREE.InstancedMesh(leafGeometry, mats.leaf(), anchors.length * 2),
  );
  leaves.castShadow = leaves.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const color = new THREE.Color();
  let index = 0;
  for (const [a, { at, yaw }] of anchors.entries()) {
    for (const side of [-1, 1]) {
      const k = a + seed * 13;
      const leafYaw = yaw + side * (0.5 + hash(k, side + 2, 3) * 0.6);
      const droop = hash(k, side + 2, 8) < 0.3;
      const pitch = droop
        ? -1.65 - hash(k, side + 2, 1) * 0.3
        : -0.85 - hash(k, side + 2, 1) * 0.55;
      euler.set(pitch, leafYaw, (hash(k, side + 2, 5) - 0.5) * 0.88, 'YXZ');
      rotation.setFromEuler(euler);
      const size = (0.6 + hash(k, side + 2, 2) * 0.6) * Math.max(0.75, s);
      matrix.compose(at, rotation, new THREE.Vector3(size, size, size));
      leaves.setMatrixAt(index, matrix);
      const lit = 0.65 + 0.35 * hash(k, side + 2, 6);
      color.setRGB(lit, lit, lit * 0.88);
      leaves.setColorAt(index, color);
      index++;
    }
  }
  g.add(leaves);
  volume('plant', [0.75 * s, height, 0.75 * s], [0, height / 2, 0], g, 0.4);
  return g;
}

// Small tabletop plant (no volume).
function smallPlant(
  g: THREE.Object3D,
  { size = 0.22, pot = mats.terracotta() as THREE.Material, seed = 0 } = {},
) {
  const r = size * 0.32;
  cylinder(r, r * 0.8, size * 0.45, pot, [0, size * 0.225, 0], g, 24);
  const leafGeometry = own(
    new THREE.PlaneGeometry(0.28, 0.38, 2, 3).translate(0, 0.21, 0),
  );
  const leaves = own(new THREE.InstancedMesh(leafGeometry, mats.leaf(), 12));
  leaves.castShadow = true;
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler();
  for (let i = 0; i < 12; i++) {
    euler.set(
      -0.4 - hash(i, 1, seed) * 0.8,
      (i / 12) * Math.PI * 2 + seed,
      0,
      'YXZ',
    );
    const scale = size * (0.7 + hash(i, 2, seed) * 0.5);
    matrix.compose(
      new THREE.Vector3(0, size * 0.42, 0),
      new THREE.Quaternion().setFromEuler(euler),
      new THREE.Vector3(scale, scale, scale),
    );
    leaves.setMatrixAt(i, matrix);
  }
  g.add(leaves);
  return g;
}

// ---------------------------------------------------------- floor and walls

// Rug lying on the floor, lit like the floor beneath it.
function rug(
  g: THREE.Object3D,
  {
    width = 2.4,
    depth = 1.7,
    style = 'lattice' as RugStyle,
    field = '#e6ddcc',
    accent = '#5a524a',
  } = {},
) {
  const material = shellMaterial({
    map: fitted(rugCanvas(width, depth, style, field, accent), width, depth),
    roughness: 1,
  });
  const object = mesh(panel(width, depth), material, [0, 0.006, 0], g, {
    cast: false,
  });
  object.rotation.x = -Math.PI / 2;
  litSurface(object, width, depth);
  return g;
}

type ArtStyle = 'abstract' | 'botanical' | 'landscape';

// Framed picture on a wall group (local +Z into the room). The whole frame
// is the WebXR 'wall art' plane, as a room scan would label it.
function picture(
  g: THREE.Object3D,
  {
    width = 0.9,
    height = 0.65,
    art = 'abstract' as ArtStyle,
    seed = 1,
    frame = mats.blackMetal() as THREE.Material,
    palette = ['#b9673f', '#2c4547', '#d7a24b', '#8d9b85'],
  } = {},
) {
  box([width, height, 0.03], frame, [0, 0, 0.015], g).userData.xrPlane =
    'wall art';
  const matBorder = Math.min(width, height) * 0.1;
  mesh(unitPlane, mats.trim(), [0, 0, 0.0305], g, { cast: false }).scale.set(
    width - 0.04,
    height - 0.04,
    1,
  );
  const w = width - 2 * matBorder;
  const h = height - 2 * matBorder;
  const map =
    art === 'botanical'
      ? botanicalTexture(seed)
      : art === 'landscape'
        ? landscapeTexture(seed, w / h)
        : paintingTexture(seed, palette, w / h);
  mesh(unitPlane, standard({ map, roughness: 0.85 }), [0, 0, 0.031], g, {
    cast: false,
  }).scale.set(w, h, 1);
  return g;
}

// Mirror on a wall group: round with a brass ring, or rectangular with a
// wooden frame. A 'wall art' plane.
function mirror(
  g: THREE.Object3D,
  {
    radius = 0.36,
    width = 0,
    height = 0,
    frame = mats.oak() as THREE.Material,
  } = {},
) {
  if (width && height) {
    box([width, height, 0.03], frame, [0, 0, 0.015], g).userData.xrPlane =
      'wall art';
    mesh(unitPlane, mats.mirror(), [0, 0, 0.031], g, { cast: false }).scale.set(
      width - 0.08,
      height - 0.08,
      1,
    );
  } else {
    const glass = mesh(
      own(new THREE.CircleGeometry(radius, 64)),
      mats.mirror(),
      [0, 0, 0.012],
      g,
      { cast: false },
    );
    glass.userData.xrPlane = 'wall art';
    mesh(
      own(new THREE.TorusGeometry(radius + 0.01, 0.012, 12, 96)),
      mats.brass(),
      [0, 0, 0.014],
      g,
    );
  }
  return g;
}

// Wall-mounted display (screen off). A room scan reports screens as volumes
// only (no plane).
function wallScreen(g: THREE.Object3D, { width = 1.46, height = 0.84 } = {}) {
  box(
    [width, height, 0.028],
    paintMaterial('#0a0a0a', 0.35, 0.5),
    [0, 0, 0.014],
    g,
  );
  const screen = mesh(unitPlane, mats.screen(), [0, 0, 0.0285], g, {
    cast: false,
  });
  screen.scale.set(width - 0.03, height - 0.03, 1);
  volume('screen', [width, height, 0.04], [0, 0, 0.02], g, 0.3);
  return g;
}

// Desk monitor on a stand (put `g` on the desk top); a 'screen' volume, as a
// room scan reports screens.
// A desk monitor; `tracked: false` leaves out its 'screen' volume (rooms with
// many monitors stay within the objects a room scan reports).
function monitor(
  g: THREE.Object3D,
  { width = 0.62, height = 0.37, tracked = true } = {},
) {
  box([0.22, 0.012, 0.16], mats.charcoal(), [0, 0.006, 0], g);
  box([0.04, 0.16, 0.025], mats.charcoal(), [0, 0.09, -0.04], g);
  box(
    [width, height, 0.025],
    paintMaterial('#141414', 0.4),
    [0, 0.12 + height / 2, -0.02],
    g,
  );
  const screen = mesh(
    unitPlane,
    mats.screen(),
    [0, 0.12 + height / 2, -0.007],
    g,
    { cast: false },
  );
  screen.scale.set(width - 0.02, height - 0.03, 1);
  (tracked ? volume : occluder)(
    'screen',
    [width, height + 0.12, 0.16],
    [0, (height + 0.12) / 2, -0.02],
    g,
    0.2,
  );
  return g;
}

// Whiteboard or cork pinboard on a wall group; a 'wall art' plane.
function board(
  g: THREE.Object3D,
  {
    width = 1.2,
    height = 0.9,
    kind = 'white' as 'white' | 'cork',
    seed = 0,
  } = {},
) {
  box(
    [width, height, 0.02],
    kind === 'white' ? mats.steel() : mats.oak(),
    [0, 0, 0.01],
    g,
  ).userData.xrPlane = 'wall art';
  const surface = mesh(
    unitPlane,
    kind === 'white'
      ? paintMaterial('#f6f6f3', 0.25)
      : standard({ map: corkTexture(), roughness: 0.95 }),
    [0, 0, 0.0205],
    g,
    { cast: false },
  );
  surface.scale.set(width - 0.04, height - 0.04, 1);
  if (kind === 'cork') {
    const papers = ['#f3efe6', '#e7d9c4', '#d9e3d6', '#efe2d4'];
    for (let i = 0; i < 4; i++) {
      const sheet = mesh(
        unitPlane,
        paintMaterial(papers[i], 0.9),
        [
          (hash(i, 1, seed) - 0.5) * (width - 0.35),
          (hash(i, 2, seed) - 0.5) * (height - 0.35),
          0.022 + i * 0.0005,
        ],
        g,
        { cast: false },
      );
      sheet.scale.set(0.21, 0.28, 1);
      sheet.rotation.z = (hash(i, 3, seed) - 0.5) * 0.15;
    }
  }
  return g;
}

// Felt acoustic panel on a wall group (no WebXR label).
function acousticPanel(
  g: THREE.Object3D,
  { width = 0.6, height = 1.2, color = '#7d8a6a' } = {},
) {
  mesh(
    roundedBox(width, height, 0.04, 0.01),
    fabricMaterial(color, 60),
    [0, 0, 0.02],
    g,
  );
  return g;
}
