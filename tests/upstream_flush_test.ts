// Port of packages/svelte-check/test-flush.js (language-tools f03e566).
// See tests/fixtures/upstream-cli/LICENSE for the upstream MIT notice.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

Deno.test("upstream CLI output-flush regression: all 1500 diagnostics reach a slow pipe", async () => {
  const root = await Deno.makeTempDir({ prefix: "svelte-check-flush-" });
  const count = 1500;
  const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
  const config = fromFileUrl(new URL("../deno.json", import.meta.url));
  try {
    const names = Array.from(
      { length: count },
      (_, i) => `undeclaredIdentifierNumber${i}`,
    );
    await Deno.writeTextFile(
      join(root, "Index.svelte"),
      `<script lang="ts">\n${
        names.map((name) => name + ";").join("\n")
      }\n</script>`,
    );
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({
        nodeModulesDir: "none",
        imports: { svelte: "npm:svelte@5.57.0" },
        compilerOptions: { strict: true },
      }),
    );
    for (let iteration = 0; iteration < 10; iteration++) {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--config",
          config,
          "-A",
          cli,
          "--workspace",
          root,
          "--output",
          "json",
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const stderr = new Response(child.stderr).text();
      const decoder = new TextDecoder();
      let stdout = "";
      for await (const chunk of child.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        // Keep backpressure, as in the upstream regression for issue #3013.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      stdout += decoder.decode();
      assertEquals((await child.status).code, 1, await stderr);
      const result = JSON.parse(stdout);
      assertEquals(result.errorCount, count, `iteration ${iteration + 1}`);
      assertEquals(result.diagnostics.length, count);
      assertEquals(
        result.diagnostics.map((diagnostic: { code: number }) =>
          diagnostic.code
        ),
        Array(count).fill(2304),
      );
      assertEquals(result.diagnostics[0].range.start.line, 1);
      assertEquals(result.diagnostics.at(-1).range.start.line, count);
      assertEquals(result.success, false);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
