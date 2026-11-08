const { execFileSync } = require("node:child_process");
const path = require("node:path");
const t = path.join(__dirname, "tz.hidden.js");
for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
  execFileSync(process.execPath, [t], { env: { ...process.env, TZ: tz }, stdio: "inherit" });
}
