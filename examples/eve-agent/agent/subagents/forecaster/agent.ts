import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const realModel = process.env.EVE_EXAMPLE_MODEL;

const OUTLOOK: Record<string, string> = {
  Sunny: "staying clear through tomorrow.",
  Rain: "showers easing by evening.",
  Cloudy: "clouds breaking up overnight.",
  Fog: "fog lifting by midday.",
};

export default defineAgent({
  description: "Writes a one-line weather outlook from current conditions. Send the city and its current conditions.",
  model:
    realModel ??
    mockModel({
      modelId: "forecaster-script",
      provider: "eve-mock",
      respond: ({ lastUserMessage }) => {
        const condition = Object.keys(OUTLOOK).find((c) => lastUserMessage?.includes(c));
        return condition ? OUTLOOK[condition]! : "no change expected.";
      },
    }),
});
