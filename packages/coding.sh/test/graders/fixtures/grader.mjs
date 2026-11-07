export default function grade(ctx, options) {
  const want = options?.upper ? String(ctx.expected).toUpperCase() : ctx.expected;
  return { score: ctx.output === want ? 1 : 0, reason: `compared with ${want}` };
}
export function lengthy(ctx) {
  return String(ctx.output).length > 3;
}
