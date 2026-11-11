import { spawnSync } from "node:child_process";
spawnSync("npm", ["install", "-g", "--no-fund", "./coding.sh.tgz"]); // slop:expect
