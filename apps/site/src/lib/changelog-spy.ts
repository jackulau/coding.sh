// Marks the rail link for the section in view (aria-current="true") on
// /changelog and /changelog/<version>, and keeps it visible when the rail is a
// horizontal strip on narrow screens.
let stop: (() => void) | undefined;

export function setupRail() {
  stop?.();
  stop = undefined;
  const rail = document.querySelector<HTMLElement>("[data-cl-rail]");
  if (!rail) return;
  // Only sections on this page: a long release's rail also links its other pages.
  const links: HTMLAnchorElement[] = [];
  const targets: HTMLElement[] = [];
  for (const a of rail.querySelectorAll<HTMLAnchorElement>("a[href*='#']")) {
    const t = a.pathname === location.pathname ? document.getElementById(decodeURIComponent(a.hash.slice(1))) : null;
    if (t) {
      links.push(a);
      targets.push(t);
    }
  }
  if (!links.length) return;

  let current = -1;
  let frame = 0;
  const update = () => {
    frame = 0;
    // The last section whose top has passed a line a third of the way down.
    const line = window.innerHeight / 3;
    let i = 0;
    targets.forEach((t, n) => {
      if (t && t.getBoundingClientRect().top <= line) i = n;
    });
    // At the bottom of the page the last section wins, however short it is.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) i = targets.length - 1;
    if (i === current) return;
    current = i;
    links.forEach((a, n) => a.setAttribute("aria-current", String(n === i)));
    const strip = links[i].closest("ol");
    if (strip && strip.scrollWidth > strip.clientWidth) {
      const a = links[i].getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      strip.scrollTo({ left: strip.scrollLeft + a.left - s.left - (s.width - a.width) / 2 });
    }
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  };
}
