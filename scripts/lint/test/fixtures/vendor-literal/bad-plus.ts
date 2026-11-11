// A split literal: esbuild folds "a" + "b" back into one string in dist.
const id = "x";
export const a = "sk_test_" + id; // slop:expect
export const b = 'ghp_' + id; // slop:expect
export const c = "AKIA" + id; // slop:expect
export const d = `xoxb-` + id; // slop:expect
export const e = "github_pat_" + id; // slop:expect
