import { checkInContext } from "./checker.ts";
import type { CheckOptions } from "./types.ts";

const [requestFile, resultFile] = Deno.args;
if (!requestFile || !resultFile) {
  throw new Error("Missing check worker request/result files");
}
try {
  const options = JSON.parse(
    await Deno.readTextFile(requestFile),
  ) as CheckOptions;
  const result = await checkInContext(options);
  await Deno.writeTextFile(resultFile, JSON.stringify({ result }));
} catch (error) {
  await Deno.writeTextFile(
    resultFile,
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

// Project plugins may leave timers running after config resolution. All checker
// resources have closed before the result is written, so end this isolated run.
Deno.exit(0);
