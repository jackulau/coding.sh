// esbuild bundles .html files as text (scripts/build.mjs: loader { ".html": "text" }).
declare module "*.html" {
  const html: string;
  export default html;
}
