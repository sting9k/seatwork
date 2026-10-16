/**
 * One real decision through the provider in force: its key, model and wire answer, and what it cost.
 *   node --require ./test/register.cjs tools/jev-check.ts
 */
import { Jev } from "../server/jev/index";
import { JEV_DIR } from "../server/paths";
import { loadPolicy } from "../server/policy";

async function main(): Promise<void> {
  const policy = loadPolicy();
  const jev = new Jev({ dir: JEV_DIR, policy: () => policy.jev });
  const why = jev.why();
  if (why) throw new Error(why);
  try {
    const probe = await jev.probeEndpoint();
    if (probe) console.log(JSON.stringify({ probe }, null, 2));
    const decision = await jev.decide("check", "The test suite ran after the last edit, and all 42 tests passed.", {
      passed: { type: "noul", instructions: "Does the text say the tests passed?" },
      sure: {
        type: "score",
        instructions: "How certain does the text sound?",
        criteria: ["unsure", "fairly sure", "certain"],
      },
    });
    const { model, answers, latencyMs, attempts, usd } = decision;
    console.log(
      JSON.stringify(
        { provider: policy.jev?.provider, model, answers, latencyMs, attempts, usd, month: jev.spent() },
        null,
        2,
      ),
    );
  } finally {
    jev.close();
  }
}

main().catch((error) => {
  console.error(`jev check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
