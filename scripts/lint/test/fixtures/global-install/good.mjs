import { spawnSync } from "node:child_process";
// The prefix is set once for every child.
const env = { ...process.env, npm_config_prefix: "/tmp/prefix" };
spawnSync("npm", ["install", "-g", "./coding.sh.tgz"], { env });
const text = "run npm install -g in docs";
export const re = /npm install -g coding\.sh/;
