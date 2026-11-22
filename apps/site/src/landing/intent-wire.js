// Wires the predictor to the page. It only ever sets an attribute and asks the browser to load
// a page early: it never moves focus and never changes what a click lands on.
//   data-intent   on the button the pointer is heading for (styled like hover), or touched
//   data-preload  on a link whose page was asked for early
function wireIntent() {
  const PICK = "a[href], button, summary";
  // Wired once per document. The site swaps pages without a reload, so this script can run
  // again; the buttons are read again after each swap instead.
  const KEY = Symbol.for("coding.sh/intent");
  if (window[KEY]) return window[KEY]();
  let els = [];
  const it = createIntent();
  const asked = new Set();
  let armed = null;
  let touch = false;

  // People on Save-Data or a 2G link did not ask for pages they may never open.
  const frugal = () => {
    const c = navigator.connection;
    return !!c && (c.saveData || /2g/.test(c.effectiveType || ""));
  };
  function preload(el) {
    if (el.tagName !== "A" || frugal()) return;
    const href = el.getAttribute("href") || "";
    // This site's own pages only, once each.
    if (!href.startsWith("/") || href.startsWith("//") || asked.has(href)) return;
    asked.add(href);
    el.setAttribute("data-preload", "");
    if (!/^https?:$/.test(location.protocol)) return; // a file on disk has nothing to fetch
    const link = document.createElement("link");
    if (link.relList && link.relList.supports && link.relList.supports("prefetch")) {
      link.rel = "prefetch";
      link.href = href;
      document.head.append(link);
    } else fetch(href, { priority: "low", credentials: "same-origin" }).catch(() => {});
  }
  function arm(el) {
    if (el === armed) return;
    if (armed) armed.removeAttribute("data-intent");
    armed = el;
    if (el) {
      el.setAttribute("data-intent", "");
      preload(el);
    }
  }
  const clear = () => {
    it.reset();
    arm(null);
  };
  // Only on a page that carries this layout (main.f); elsewhere there is nothing to guess.
  const read = () => {
    armed = null;
    it.reset();
    els = document.querySelector("main.f") ? [...document.querySelectorAll(PICK)] : [];
  };
  window[KEY] = read;
  read();
  document.addEventListener("astro:after-swap", read);
  // Boxes are read as they are now, so an opened question or a scrolled page is never stale. A
  // button hidden in place (the install box's commands that are not picked) is left out.
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return r.width && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden" ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
  };

  // Mouse: guess the button from how the pointer is slowing.
  addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      touch = false;
      const i = it.move(e.clientX, e.clientY, e.timeStamp, els.map(box));
      arm(i >= 0 ? els[i] : null);
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", clear);
  addEventListener("blur", clear);

  // Touch: there is no pointer to watch, so the finger landing is the signal. The button takes
  // its pressed look and its page starts loading then, not when the tap is confirmed.
  addEventListener(
    "pointerdown",
    (e) => {
      touch = e.pointerType !== "mouse";
      if (!touch) return;
      const el = e.target.closest ? e.target.closest(PICK) : null;
      if (el) arm(el);
    },
    { passive: true },
  );
  // Lifted, or the touch turned into a scroll.
  for (const type of ["pointerup", "pointercancel"]) {
    addEventListener(type, (e) => e.pointerType !== "mouse" && arm(null), { passive: true });
  }

  // Touch scrolling: as a fling slows, work out where it will stop and ask for the (at most
  // two) links that will sit nearest the thumb. An estimate: flings differ between phones.
  let y0 = scrollY;
  let t0 = 0;
  let v0 = 0;
  let called = false;
  addEventListener(
    "scroll",
    () => {
      if (!touch) return clear(); // the page moved under a still mouse
      const t = performance.now();
      const dt = t - t0;
      if (dt > 0 && dt < 120) {
        const v = (scrollY - y0) / dt;
        const s = Math.abs(v);
        if (s > Math.abs(v0) * 1.2) called = false; // flicked again
        else if (!called && s < Math.abs(v0) && s > 0.05 && s < 1.2) {
          called = true;
          const shift = restOffset(scrollY, v) - scrollY;
          const thumb = innerHeight * 0.62;
          els
            // Links in the fixed nav do not move with the page, so they are left out.
            .filter((el) => el.tagName === "A" && !el.closest("header"))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { el, y: (r.top + r.bottom) / 2 - shift, w: r.width };
            })
            .filter((c) => c.w && c.y > 0 && c.y < innerHeight)
            .sort((a, b) => Math.abs(a.y - thumb) - Math.abs(b.y - thumb))
            .slice(0, 2)
            .forEach((c) => preload(c.el));
        }
        v0 = v;
      } else {
        v0 = 0;
        called = false;
      }
      y0 = scrollY;
      t0 = t;
    },
    { passive: true },
  );
}
// Started once the whole page is there, so links below this script (the footer) are included.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireIntent);
else wireIntent();
