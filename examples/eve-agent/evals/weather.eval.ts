import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// eve-native evals: eve boots the agent, drives it over its HTTP API and
// asserts on the session's events. The same cases also live in
// evals/coding-sh/weather.jsonl for coding.sh experiments (see README).
const known = [
  { city: "Paris", reply: "Paris: Sunny, 21°C. Outlook: staying clear through tomorrow." },
  { city: "Tokyo", reply: "Tokyo: Cloudy, 18°C. Outlook: clouds breaking up overnight." },
];

export default [
  ...known.map(({ city, reply }) =>
    defineEval({
      description: `weather in ${city}: tool, then the forecaster subagent`,
      tags: ["weather"],
      async test(t) {
        const turn = await t.send(`What is the weather in ${city}?`);
        t.succeeded();
        t.calledTool("get_weather", { input: { city }, count: 1 });
        t.calledAgent("forecaster", { count: 1 });
        t.check(turn.reply, includes(reply));
      },
    }),
  ),
  defineEval({
    description: "follow-up turn uses the new city",
    tags: ["weather", "multi-turn"],
    async test(t) {
      await t.send("What is the weather in Paris?");
      const second = await t.send("And the weather in London?");
      t.check(second.reply, includes("London: Rain, 14°C"));
      t.calledAgent("forecaster", { count: 2 });
    },
  }),
  defineEval({
    description: "unknown city: the tool fails and the agent says so",
    tags: ["weather", "error"],
    async test(t) {
      const turn = await t.send("What is the weather in Atlantis?");
      t.calledTool("get_weather", { status: "failed", count: 1 });
      t.check(turn.reply, includes("no weather data"));
    },
  }),
];
