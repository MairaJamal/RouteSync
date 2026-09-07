import { parseTripRequestText } from "./nlpParser";

async function main() {
  const utterances = [
    "from G-9 to NUST by 9am, women only",
    "heading to F-10 tomorrow around 6pm, also want the driver to be a woman",
    "just going to Aabpara",
  ];

  const refTime = new Date("2026-09-03T09:00:00.000Z");

  console.log("=== Testing parseTripRequestText ===");
  for (const u of utterances) {
    console.log(`\n--- Input: "${u}" ---`);
    const result = await parseTripRequestText(u, refTime);
    console.log("Parsed Output:", JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);
