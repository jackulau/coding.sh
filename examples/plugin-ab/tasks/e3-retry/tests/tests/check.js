const fs = require("node:fs");
const out = fs.readFileSync(process.env.CODING_SH_AGENT_OUTPUT, "utf8");
const need = JSON.parse(fs.readFileSync(__dirname + "/need.json", "utf8"));
const miss = need.filter(([label, re]) => !new RegExp(re, "i").test(out)).map(([label]) => label);
if (miss.length) { console.error("answer misses: " + miss.join(", ")); process.exit(1); }
console.log("answer covers: " + need.map(([l]) => l).join(", "));
