// True when the importing module is the script node was started with. Compares paths, not URL
// strings: on Windows `import.meta.url` is file:///C:/... and argv[1] is C:\...
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}
