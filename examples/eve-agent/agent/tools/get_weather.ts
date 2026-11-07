import { defineTool } from "eve/tools";
import { z } from "zod";

// Fixed table so runs are reproducible and evals have a ground truth.
const TABLE: Record<string, { condition: string; temperatureC: number }> = {
  paris: { condition: "Sunny", temperatureC: 21 },
  london: { condition: "Rain", temperatureC: 14 },
  tokyo: { condition: "Cloudy", temperatureC: 18 },
  "san francisco": { condition: "Fog", temperatureC: 16 },
};

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    const hit = TABLE[city.trim().toLowerCase()];
    if (!hit) throw new Error(`No weather data for ${city}. Known cities: Paris, London, Tokyo, San Francisco.`);
    return { city, ...hit };
  },
});
