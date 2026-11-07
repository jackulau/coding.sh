// One cube for the whole brand: the nav mark, the favicon and every cube in
// the hero field are this solid cube, lit from above. At the default angle
// (yaw 45°, pitch 35.26°) it is the classic isometric cube: white top, light
// grey left face, darker grey right face.
//
// Shared by build-time SVG (mark, favicon, foreground cubes) and the hero's
// canvas script, so the shading can never drift between them.

export type Pt = [number, number];
export interface Face {
  pts: Pt[];
  /** 0..255 grey. */
  grey: number;
}

export const ISO_YAW = Math.PI / 4;
export const ISO_PITCH = Math.atan(1 / Math.SQRT2);

// Face normals and their corner indices into VERTS (counter-clockwise from outside).
const VERTS: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const FACES: { n: [number, number, number]; v: number[] }[] = [
  { n: [0, 1, 0], v: [3, 2, 6, 7] },
  { n: [0, -1, 0], v: [0, 4, 5, 1] },
  { n: [1, 0, 0], v: [1, 5, 6, 2] },
  { n: [-1, 0, 0], v: [0, 3, 7, 4] },
  { n: [0, 0, 1], v: [4, 7, 6, 5] },
  { n: [0, 0, -1], v: [0, 1, 2, 3] },
];

// Shade from the screen-space normal; solved so the iso angle gives exactly
// top #f4, left #b9, right #76 (the logo's three greys).
const shade = (nx: number, ny: number) => Math.max(0, Math.min(255, 244 * (0.747 + 0.309 * ny - 0.197 * nx)));

/**
 * Visible faces of a cube with half-edge `s`, centred on (0, 0), screen y down.
 * Faces come back far-to-near, so painting them in order is correct.
 */
export function cubeFaces(yaw: number, pitch: number, s: number): Face[] {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const rot = ([x, y, z]: [number, number, number]): [number, number, number] => {
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  };
  const out: (Face & { z: number })[] = [];
  for (const f of FACES) {
    const [nx, ny, nz] = rot(f.n);
    if (nz <= 1e-6) continue;
    out.push({ pts: f.v.map((i) => { const [x, y] = rot(VERTS[i]); return [x * s, -y * s] as Pt; }), grey: shade(nx, ny), z: nz });
  }
  return out.sort((a, b) => a.z - b.z);
}

export const hex = (g: number) => {
  const h = Math.round(g).toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
};

/** The cube as SVG polygons in a box starting at (0, 0). */
export function cubeSvg(yaw = ISO_YAW, pitch = ISO_PITCH, s = 10) {
  const faces = cubeFaces(yaw, pitch, s);
  const all = faces.flatMap((f) => f.pts);
  const minX = Math.min(...all.map((p) => p[0])), minY = Math.min(...all.map((p) => p[1]));
  const width = Math.max(...all.map((p) => p[0])) - minX;
  const height = Math.max(...all.map((p) => p[1])) - minY;
  const body = faces
    .map((f) => `<polygon fill="${hex(f.grey)}" stroke="${hex(f.grey)}" stroke-width="${(s * 0.05).toFixed(2)}" stroke-linejoin="round" points="${f.pts.map(([x, y]) => `${+(x - minX).toFixed(2)},${+(y - minY).toFixed(2)}`).join(" ")}"/>`)
    .join("");
  return { body, width: +width.toFixed(2), height: +height.toFixed(2) };
}

/** Small deterministic PRNG so the field is the same on every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
