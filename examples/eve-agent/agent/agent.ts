import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Deterministic by default: no API key, no cost, same trace shape every run.
// Set EVE_EXAMPLE_MODEL (e.g. "anthropic/claude-haiku-4.5") plus a credential
// (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY) to use a real model.
const realModel = process.env.EVE_EXAMPLE_MODEL;

/** City named in a prompt like "weather in Paris?" (falls back to the whole prompt). */
function cityOf(prompt: string | null): string {
  const m = /\b(?:in|for|at)\s+([A-Z][\p{L} .'-]*?)\s*[?.!]*$/u.exec(prompt ?? "");
  return (m?.[1] ?? prompt ?? "Paris").trim();
}

type Msg = { readonly role: string; readonly text: string };

/** Index of the message that started this turn (the latest authored user message). */
function turnStart(messages: readonly Msg[], lastUserMessage: string | null): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && messages[i]!.text === lastUserMessage) return i;
  return 0;
}

/** Body of the forecaster's `<task_result>` block, once eve has delivered it. */
function forecasterResult(messages: readonly Msg[]): string | undefined {
  for (const m of messages) {
    const hit = /<task_result[^>]*tool="forecaster"[^>]*>([\s\S]*?)<\/task_result>/.exec(m.text);
    if (hit) return hit[1]!.trim();
  }
  return undefined;
}

const scripted = mockModel({
  modelId: "weather-script",
  provider: "eve-mock",
  respond: ({ lastUserMessage, toolResults: allResults, messages: allMessages }) => {
    // Only look at this turn: tool messages map 1:1, in order, onto toolResults.
    const start = turnStart(allMessages, lastUserMessage);
    const toolResults = allResults.slice(allMessages.slice(0, start).filter((m) => m.role === "tool").length);
    const messages = allMessages.slice(start);
    const weather = toolResults.find((r) => r.name === "get_weather");
    const delegated = toolResults.some((r) => r.name === "forecaster");
    const outlook = forecasterResult(messages);
    const city = cityOf(lastUserMessage);
    // Step 1: look up current conditions.
    if (!weather) return { toolCalls: [{ name: "get_weather", input: { city } }] };
    if (weather.isError) return `Sorry, I have no weather data for ${city}.`;
    // Step 2: delegate the outlook to the subagent (runs as an eve task).
    if (!delegated) {
      return {
        text: "Checking the outlook.",
        toolCalls: [{ name: "forecaster", input: { message: `Outlook for ${city}. Now: ${JSON.stringify(weather.output)}` } }],
      };
    }
    // Step 3: hold the reply until the subagent's <task_result> arrives.
    if (outlook === undefined) return { toolCalls: [{ name: "eve__task_wait", input: { timeoutSeconds: 30 } }] };
    // Step 4: answer.
    const w = weather.output as { city?: string; condition?: string; temperatureC?: number };
    return `${w.city ?? city}: ${w.condition ?? "unknown"}, ${w.temperatureC ?? "?"}°C. Outlook: ${outlook}`;
  },
});

export default defineAgent({
  description: "Weather assistant that looks up conditions and delegates the outlook to a subagent.",
  model: realModel ?? scripted,
});
