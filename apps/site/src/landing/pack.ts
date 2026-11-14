// Astro inserts the front page's body as written (set:html), so nothing minifies it. This does,
// at build time: HTML comments go, and each inline <style> and <script> is minified.
import { transformSync } from "esbuild";

const min = (code: string, loader: "js" | "css") =>
  transformSync(code, { loader, minify: true, legalComments: "none", target: loader === "js" ? "es2020" : undefined }).code.trim();

export const pack = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, open, css, close) => open + min(css, "css") + close)
    .replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g, (_, open, js, close) => open + min(js, "js") + close);
