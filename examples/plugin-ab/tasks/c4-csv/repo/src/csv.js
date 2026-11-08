function parseLine(line) {
  return line.split(",").map((f) => f.replace(/^"|"$/g, ""));
}
module.exports = { parseLine };
