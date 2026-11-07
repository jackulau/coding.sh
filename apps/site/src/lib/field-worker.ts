// The hero's cube field, drawn on an OffscreenCanvas in a worker so the
// tumbling never costs the page's main thread a frame. The page sends the
// canvas once, then size + clear-zone updates and run/pause.
import { cubeFaces, hex, mulberry32, type Face, type Pt } from "./cube";

type Layer = "far" | "mid" | "near";
interface C {
  fx: number; // position as a fraction of the field
  fy: number;
  s: number; // half-edge, px
  b: number; // brightness 0..1
  layer: Layer;
  yaw: number;
  spin: number; // rad/s
  pitch: number;
  wob: number; // pitch wobble phase
  amp: number; // drift amplitude, px
  w: number; // drift angular speed
  ph: number; // drift phase
  stream?: boolean;
  hidden?: boolean;
  dim?: number;
  /** A one-off pass/fail flash: tone and start time (s). */
  sig?: { tone: Tone; at: number };
}
type Tone = "pass" | "fail";
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Keep-out zone. Soft (text): far cubes dim, others hide. Hard (a product frame): nothing touches it. */
export interface Zone extends Rect {
  hard?: boolean;
}
export type Msg =
  | { type: "init"; canvas: OffscreenCanvas; variant: string }
  | { type: "size"; W: number; H: number; dpr: number; clear: Zone[] }
  | { type: "run"; on: boolean }
  | { type: "signal"; tone: Tone };

// Minimum spacing between random cubes, in field fractions scaled to a 16:10
// box, so the scatter reads as placed rather than clumped.
function scatter(rand: () => number, n: number, minD: number, x0: number, x1: number, y0: number, y1: number, taken: [number, number][]) {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    let best: [number, number] = [0, 0];
    let bestD = -1;
    // Best of k candidates (Mitchell's): keeps the scatter even without a grid.
    for (let k = 0; k < 12; k++) {
      const p: [number, number] = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
      let d = Infinity;
      for (const q of taken) d = Math.min(d, Math.hypot((p[0] - q[0]) * 1.6, p[1] - q[1]));
      if (d >= minD) {
        best = p;
        bestD = d;
        break;
      }
      if (d > bestD) {
        best = p;
        bestD = d;
      }
    }
    taken.push(best);
    out.push(best);
  }
  return out;
}

function build(variant: string): C[] {
  const rand = mulberry32(variant === "hero" ? 0xc0d1 : 0x51de);
  const r = (a: number, b: number) => a + rand() * (b - a);
  const out: C[] = [];
  const add = (fx: number, fy: number, s: number, b: number, layer: Layer, stream = false) =>
    out.push({
      fx, fy, s, b, layer, stream,
      yaw: r(0, Math.PI * 2),
      spin: (rand() < 0.5 ? -1 : 1) * r(0.02, layer === "far" ? 0.04 : 0.1),
      pitch: r(0.42, 0.78),
      wob: r(0, Math.PI * 2),
      amp: layer === "near" ? r(10, 18) : layer === "mid" ? r(5, 11) : r(1.5, 4),
      // Far cubes drift about half as fast as near ones: parallax by speed.
      w: (Math.PI * 2) / (layer === "far" ? r(70, 120) : r(28, 60)),
      ph: r(0, Math.PI * 2),
    });

  const side = variant === "side";
  const taken: [number, number][] = [];
  // Depth falloff: far cubes sit at about a third of the near cubes' light.
  for (const [x, y] of scatter(rand, side ? 40 : 80, 0.07, side ? 0.5 : 0, 1, 0, 1, taken)) add(x, y, r(1.4, 3.4), r(0.18, 0.34), "far");
  for (const [x, y] of scatter(rand, side ? 12 : 16, 0.18, side ? 0.5 : 0, 1, 0.02, 0.9, taken)) add(x, y, r(4.5, 9), r(0.45, 0.7), "mid");
  // Currents of cubes, shrinking into the distance as they run down into the
  // recording window below the headline: the field is the event stream.
  const streams = side
    ? [{ a: [0.98, 0.85], c: [0.82, 0.55], e: [0.7, 0.2], n: 12 }]
    : [
        { a: [0.995, 0.16], c: [0.93, 0.44], e: [0.8, 0.58], n: 12 },
        { a: [0.005, 0.34], c: [0.07, 0.52], e: [0.19, 0.6], n: 9 },
      ];
  for (const st of streams) {
    for (let i = 0; i < st.n; i++) {
      const t = i / (st.n - 1);
      const q = (k: 0 | 1) => (1 - t) ** 2 * st.a[k] + 2 * (1 - t) * t * st.c[k] + t ** 2 * st.e[k];
      add(q(0) + r(-0.008, 0.008), q(1) + r(-0.014, 0.014), Math.max(1.8, 9.5 - 7.2 * t + r(-0.8, 0.8)), 0.9 - 0.55 * t, "mid", true);
    }
  }
  // Near: by hand, at the edges; the two largest are cropped by the viewport,
  // so they read as close to the camera rather than as objects on the page.
  const near = side
    ? [[0.62, 0.3, 14], [0.86, 0.22, 20]]
    : [[0.07, 0.15, 13], [0.9, 0.2, 16], [0.15, 0.44, 15], [0.86, 0.36, 13], [1.0, 0.46, 30], [0.0, 0.66, 26]];
  for (const [x, y, s] of near) add(x, y, s, r(0.9, 1), "near");
  return out.sort((a, b) => a.s - b.s);
}

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let canvas: OffscreenCanvas | null = null;
let cubes: C[] = [];
let W = 0, H = 0, scale = 1, running = false, timer = 0;
const t0 = performance.now();

function layout(clear: Zone[]) {
  scale = W < 768 ? 0.6 : W < 1200 ? 0.85 : 1;
  cubes.forEach((c, i) => {
    c.hidden = W < 768 && c.layer === "far" && i % 2 === 1;
    c.dim = 1;
    // Nothing under the nav bar (about 72px tall once it floats), counting the
    // cube's own size and how far it drifts.
    const reach = (c.layer === "far" ? c.s : c.s * scale) * 1.8 + c.amp;
    if (c.fy * H - reach < 80) c.hidden = true;
    const x = c.fx * W, y = c.fy * H;
    for (const z of clear) {
      // Text: hide mid/near cubes in the zone, dim far ones. A product frame:
      // nothing is drawn over it or within a cube's reach of its edge.
      const m = z.hard ? reach + 16 : c.layer === "far" ? 0 : 36;
      const inside = x > z.left - m && x < z.right + m && y > z.top - m && y < z.bottom + m;
      if (!inside) continue;
      if (!z.hard && c.layer === "far") c.dim = Math.min(c.dim, 0.35);
      else c.hidden = true;
    }
  });
}

// Signal colours, the page's only two (global.css --pass / --fail).
const TONE: Record<Tone, [number, number, number]> = { pass: [60, 207, 122], fail: [240, 97, 106] };
const SIG_S = 0.9;

/** Flash one visible stream cube, the nearest kind of cube to the viewer. */
function signal(tone: Tone, now: number) {
  const pool = cubes.filter((c) => !c.hidden && c.stream && c.s * scale >= 4);
  const from = pool.length ? pool : cubes.filter((c) => !c.hidden && c.layer !== "far");
  const pick = from[Math.floor(Math.random() * from.length)];
  if (pick) pick.sig = { tone, at: (now - t0) / 1000 };
}

/** Face colour: grey, or blended toward the signal colour while a flash runs. */
function faceColour(g: number, c: C, t: number) {
  if (!c.sig) return hex(g);
  const age = t - c.sig.at;
  if (age > SIG_S) {
    c.sig = undefined;
    return hex(g);
  }
  // Fast in (80ms), slow out: a blink, not a pulse.
  const k = age < 0.08 ? age / 0.08 : 1 - ((age - 0.08) / (SIG_S - 0.08)) ** 0.6;
  const [r, gg, b] = TONE[c.sig.tone];
  const l = g / 255;
  const mix = (a: number, v: number) => Math.round(a + (v * Math.max(0.55, l) - a) * k);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(mix(g, r))}${h(mix(g, gg))}${h(mix(g, b))}`;
}

function draw(now: number) {
  if (!ctx) return;
  const t = (now - t0) / 1000;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 0.6;
  ctx.lineJoin = "round";
  for (const c of cubes) {
    if (c.hidden) continue;
    const s = c.layer === "far" ? c.s : c.s * scale;
    const x = c.fx * W + Math.sin(t * c.w + c.ph) * c.amp;
    const y = c.fy * H + Math.cos(t * c.w * 0.8 + c.ph) * c.amp;
    const k = c.b * (c.dim ?? 1);
    const faces = cubeFaces(c.yaw + t * c.spin, c.pitch + Math.sin(t * 0.15 + c.wob) * 0.12, s);
    for (const f of faces) {
      const col = faceColour(f.grey * k, c, t);
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(x + f.pts[0][0], y + f.pts[0][1]);
      for (let i = 1; i < f.pts.length; i++) ctx.lineTo(x + f.pts[i][0], y + f.pts[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // The same light as the mark: a crisp lighter edge where the lit top face
    // meets the side faces, on cubes big enough to show it.
    if (s >= 5) {
      const edges = litEdges(faces);
      if (edges.length) {
        const top = faces.reduce((a, b) => (b.grey > a.grey ? b : a));
        ctx.strokeStyle = faceColour(Math.min(255, top.grey * k + 34), c, t);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [a, b] of edges) {
          ctx.moveTo(x + a[0], y + a[1]);
          ctx.lineTo(x + b[0], y + b[1]);
        }
        ctx.stroke();
        ctx.lineWidth = 0.6;
      }
    }
  }
}

/** Edges of the brightest (top) face that it shares with another visible face. */
function litEdges(faces: Face[]): [Pt, Pt][] {
  if (faces.length < 2) return [];
  const top = faces.reduce((a, b) => (b.grey > a.grey ? b : a));
  const key = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const others = new Set(faces.filter((f) => f !== top).flatMap((f) => f.pts.map(key)));
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < top.pts.length; i++) {
    const a = top.pts[i], b = top.pts[(i + 1) % top.pts.length];
    if (others.has(key(a)) && others.has(key(b))) out.push([a, b]);
  }
  return out;
}

// requestAnimationFrame exists in dedicated workers in Chromium and Firefox;
// elsewhere fall back to a ~30fps timer (the motion is slow).
const raf: (cb: (t: number) => void) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(performance.now()), 33) as unknown as number;
const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;

function loop(now: number) {
  draw(now);
  timer = running ? raf(loop) : 0;
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === "init") {
    canvas = m.canvas;
    ctx = canvas.getContext("2d");
    cubes = build(m.variant);
  } else if (m.type === "size" && canvas && ctx) {
    W = m.W;
    H = m.H;
    canvas.width = Math.round(W * m.dpr);
    canvas.height = Math.round(H * m.dpr);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    layout(m.clear);
    draw(performance.now());
  } else if (m.type === "signal") {
    if (running) signal(m.tone, performance.now());
  } else if (m.type === "run") {
    running = m.on;
    if (running && !timer) timer = raf(loop);
    if (!running && timer) {
      caf(timer);
      timer = 0;
    }
  }
};
