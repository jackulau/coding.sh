// Built at runtime with join: no whole value sits in the file, and join survives the bundle.
const id = "x";
export const a = ["sk_test_", id].join("");
export const b = ["ghp_", id].join("");
export const c = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
// A bare prefix and a regex source name a shape without being one.
export const prefix = "sk_test_";
export const re = /ghp_[0-9A-Za-z]{36}/;
export const re2 = new RegExp("xox[abprs]-[0-9A-Za-z-]{10,}");
// "ghp_" + x in a comment is not code.
export const next = prefix.concat(id);
