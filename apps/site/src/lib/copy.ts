/** Copies text, falling back to a hidden textarea where the async API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    // Deprecated but still the only synchronous fallback.
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Shows a short "copied" state on a button (.is-copied, and [data-copy-label] text). */
export function flashCopied(btn: HTMLElement, label = "Copied", rest = "Copy") {
  const el = btn.querySelector<HTMLElement>("[data-copy-label]");
  btn.classList.add("is-copied");
  if (el) el.textContent = label;
  clearTimeout(Number(btn.dataset.copyTimer));
  btn.dataset.copyTimer = String(
    window.setTimeout(() => {
      btn.classList.remove("is-copied");
      if (el) el.textContent = rest;
    }, 1600),
  );
}
