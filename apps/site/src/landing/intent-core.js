// Guesses which button a moving pointer is about to stop on, from how it is slowing down.
// No DOM in here: it takes pointer samples and button boxes, and returns the index of a box or -1.
//
// A hand moving to a target speeds up, then slows down. From the distance it has come (d), its
// speed (v) and how fast that speed is dropping (a), the distance still to go is about
//   q * d / (q + 1.5 * d),  with q = v * v / a.
// Just past top speed that is close to d (a reach is roughly even on both sides of its fastest
// point); near the end it is two thirds of q, which is what a smooth reach does as it lands.
// The button around that stopping point is the guess. A button the pointer only crosses on the
// way is not, because the stopping point is past it.
function createIntent(opts) {
  const o = Object.assign(
    {
      window: 70, // ms of samples kept
      minSpeed: 0.12, // px per ms; slower than this is a stopped pointer
      minSlowing: 0.0004, // px per ms squared; less than this is not slowing yet
      maxReach: 1100, // px; a guess further away than this is noise
      trust: 0.8, // a guess counts once the distance to go is under this share of the distance come
      slack: 0.1, // a box counts if the stopping point is within this share of the distance to go
      slackMin: 8, // px
      slackMax: 44, // px
      settle: 20, // ms the same guess must hold before it counts
      grace: 140, // ms a guess outlives the moment the pointer stops giving one
    },
    opts,
  );
  let samples = [];
  let origin = null; // where this movement began
  let guess = -1;
  let guessSince = 0;
  let armed = -1;
  let armedSeen = 0;

  // Mean velocity between the first and last sample of a slice.
  const velocity = (a) => {
    const p = a[0];
    const q = a[a.length - 1];
    const dt = q.t - p.t;
    return dt > 0 ? { x: (q.x - p.x) / dt, y: (q.y - p.y) / dt, at: (p.t + q.t) / 2 } : null;
  };

  // Where the pointer will stop, or null while it is not slowing toward anything.
  function stop() {
    const n = samples.length;
    const last = samples[n - 1];
    if (!origin) origin = { x: last.x, y: last.y };
    if (n < 4 || last.t - samples[0].t < o.window * 0.5) return null;
    const mid = last.t - (last.t - samples[0].t) / 2;
    const older = samples.filter((s) => s.t <= mid);
    const newer = samples.filter((s) => s.t >= mid);
    if (older.length < 2 || newer.length < 2) return null;
    const v0 = velocity(older);
    const v1 = velocity(newer);
    if (!v0 || !v1) return null;
    const s0 = Math.hypot(v0.x, v0.y);
    const s1 = Math.hypot(v1.x, v1.y);
    // Stopped, or turned by more than about 35 degrees: the next movement starts here.
    if (s1 < o.minSpeed || (v0.x * v1.x + v0.y * v1.y) / (s0 * s1 || 1) < 0.82) {
      origin = { x: last.x, y: last.y };
      return null;
    }
    const slowing = (s0 - s1) / (v1.at - v0.at);
    if (slowing < o.minSlowing) return null;
    // The speed was measured half a slice ago; it has gone on slowing since.
    const now = Math.max(0, s1 - slowing * (last.t - v1.at));
    const d = Math.hypot(last.x - origin.x, last.y - origin.y);
    const q = (now * now) / slowing;
    const reach = (q * d) / (q + 1.5 * d || 1);
    // Too early to say: the slowing has only just begun, so the estimate is mostly the guess
    // that the reach is even on both sides.
    if (reach > o.maxReach || reach > d * o.trust) return null;
    return { x: last.x + (v1.x / s1) * reach, y: last.y + (v1.y / s1) * reach, reach };
  }

  function pick(p, boxes, x, y) {
    const slack = Math.min(o.slackMax, Math.max(o.slackMin, p.reach * o.slack));
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b) continue;
      // The button already under the pointer has its own hover; it is never the guess.
      if (x >= b.l && x <= b.r && y >= b.t && y <= b.b) continue;
      if (p.x < b.l - slack || p.x > b.r + slack || p.y < b.t - slack || p.y > b.b + slack) continue;
      const d = Math.hypot(p.x - (b.l + b.r) / 2, p.y - (b.t + b.b) / 2);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  return {
    // One pointer sample and the boxes as they are now. Returns the armed box index, or -1.
    move(x, y, t, boxes) {
      samples.push({ x, y, t });
      while (samples.length && t - samples[0].t > o.window) samples.shift();
      const p = stop();
      const g = p ? pick(p, boxes, x, y) : -1;
      if (g !== guess) {
        guess = g;
        guessSince = t;
      }
      if (guess >= 0 && t - guessSince >= o.settle) {
        armed = guess;
        armedSeen = t;
      } else if (armed >= 0 && guess === armed) {
        armedSeen = t;
      } else if (armed >= 0 && t - armedSeen > o.grace) {
        armed = -1;
      }
      // Once the pointer is on the armed button, hover has taken over.
      const b = armed >= 0 ? boxes[armed] : null;
      if (b && x >= b.l && x <= b.r && y >= b.t && y <= b.b) armed = -1;
      return armed;
    },
    // No samples for a while (the pointer left, or the page scrolled under it).
    reset() {
      samples = [];
      origin = null;
      guess = armed = -1;
    },
  };
}

// Where a scroll that is coasting to a stop will come to rest: the offset now plus the speed
// times how long a fling takes to die away. The time differs between phones, so this is an
// estimate that gets better as the scroll slows.
function restOffset(y, pxPerMs, coastMs) {
  return y + pxPerMs * (coastMs == null ? 325 : coastMs);
}
