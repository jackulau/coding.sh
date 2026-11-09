// Plain JS too.
export const pick = (o) => ({ ...(o.x ? { x: o.x } : {}) }); // slop:expect
