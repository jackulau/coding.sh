// Second-wave adapters: hook/plugin agents (Gemini CLI, Antigravity, Copilot CLI, Amp, Pi, Droid,
// Goose, Devin CLI), wrapper-only Aider, and the generic `coding.sh run -- <cmd>` wrapper (Tier C).
import type { Adapter } from "../../core/types.ts";
import { aiderAdapter } from "./aider.ts";
import { ampAdapter } from "./amp.ts";
import { antigravityAdapter } from "./antigravity.ts";
import { copilotCliAdapter } from "./copilot-cli.ts";
import { devinAdapter } from "./devin.ts";
import { droidAdapter } from "./droid.ts";
import { geminiCliAdapter } from "./gemini-cli.ts";
import { gooseAdapter } from "./goose.ts";
import { piAdapter } from "./pi.ts";
import { wrapperAdapter } from "./wrapper.ts";

export const MORE_ADAPTERS: Adapter[] = [geminiCliAdapter, antigravityAdapter, copilotCliAdapter, ampAdapter, piAdapter, droidAdapter, gooseAdapter, devinAdapter, aiderAdapter, wrapperAdapter];

export { aiderAdapter, ampAdapter, antigravityAdapter, copilotCliAdapter, devinAdapter, droidAdapter, geminiCliAdapter, gooseAdapter, piAdapter, wrapperAdapter };
