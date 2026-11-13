// esbuild bundles the skills' .md files as text (scripts/bundle.mjs: loader { ".md": "text" }).
declare module "*.md" {
  const text: string;
  export default text;
}
