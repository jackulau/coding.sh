import { version } from "../meta.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  if (c.out.json) c.out.data({ version: version() });
  else c.out.print(version());
  return 0;
}
