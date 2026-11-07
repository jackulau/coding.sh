// The shared BlobStore conformance suite from the core package: the published
// `coding.sh/store/conformance` export when present, else the workspace source
// (same suite; lets this package test before the core export is built).
export async function loadConformance() {
  try {
    return await import("coding.sh/store/conformance");
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && code !== "ERR_MODULE_NOT_FOUND") throw err;
    return await import(new URL("../../coding.sh/src/store/conformance.ts", import.meta.url).href);
  }
}
