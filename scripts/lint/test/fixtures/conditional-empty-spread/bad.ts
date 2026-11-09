// Every line with the expect marker must produce a finding.
declare const name: string | undefined;
declare const tags: string[];
export const a = { ...(name ? { name } : {}) }; // slop:expect
export const b = { ...(name !== undefined ? {} : { anonymous: true }) }; // slop:expect
export const c = [...(tags.length ? tags : [])]; // slop:expect
export const d = { ...(name && { name }) }; // slop:expect
export const e = {
  ...(name // slop:expect
    ? { name, upper: name.toUpperCase() }
    : {}),
};
export const f = { ...(name ? { nested: { deep: name } } : {}) }; // slop:expect
export const g = [...(tags.length ? [] : ["none"])]; // slop:expect
