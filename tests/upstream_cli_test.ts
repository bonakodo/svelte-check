import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, relative } from "@std/path";
import { check } from "../src/checker.ts";
import type { CheckResult } from "../src/types.ts";

const fixture = (name: string) =>
  fromFileUrl(
    new URL(`./fixtures/upstream-cli/test-${name}/`, import.meta.url),
  );

// Ported from packages/svelte-check/test-sanity.js at the pinned fixture commit.
// Deno reports no-local for missing imports. The call-based component emitter
// reports TS2345 (missing argument property), equivalent to upstream TS2741.
const expected = [
  { file: "Index.svelte", line: 3, column: 21, code: "no-local" },
  { file: "Index.svelte", line: 5, column: 8, code: 2322 },
  { file: "Index.svelte", line: 8, column: 4, code: 2367 },
  { file: "Index.svelte", line: 11, column: 4, code: 2367 },
  { file: "Index.svelte", line: 15, column: 0, code: 2345 },
  { file: "Jsdoc.svelte", line: 9, column: 23, code: 2322 },
  { file: "src/routes/+page.ts", line: 0, column: 13, code: 2322 },
];

function assertErrors(result: CheckResult, root: string) {
  const errors = result.diagnostics.filter((d) => d.severity === "error").map((
    d,
  ) => ({
    file: relative(root, d.file).replaceAll("\\", "/"),
    line: d.range.start.line,
    column: d.range.start.character,
    code: d.code,
  }));
  assertEquals(errors, expected, JSON.stringify(result.diagnostics, null, 2));
  const required = result.diagnostics.find((d) => d.code === 2345)!;
  assertStringIncludes(required.message, "missing");
  assertStringIncludes(required.message, "b");
  assertEquals(result.errorCount, 7);
  assertEquals(result.success, false);
}

Deno.test("upstream svelte-check sanity: clean project using original tsconfig", async () => {
  const result = await check({
    workspace: fixture("success"),
    config: "tsconfig.json",
  });
  assertEquals(result.diagnostics, []);
  assert(result.success);
});

Deno.test("upstream svelte-check sanity: seven source-mapped errors using original tsconfig", async () => {
  const root = fixture("error");
  assertErrors(await check({ workspace: root, config: "tsconfig.json" }), root);
});

async function cli(name: string) {
  const root = fixture(name);
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      fromFileUrl(new URL("../deno.json", import.meta.url)),
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-net",
      fromFileUrl(new URL("../cli.ts", import.meta.url)),
      "--workspace",
      root,
      "--config",
      "tsconfig.json",
      "--output",
      "json",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assert(output.code === 0 || output.code === 1, stderr);
  const result = JSON.parse(stdout) as CheckResult;
  return { root, result, code: output.code };
}

Deno.test("upstream svelte-check sanity: Deno CLI clean exit and JSON output", async () => {
  const { code, result } = await cli("success");
  assertEquals(code, 0, JSON.stringify(result.diagnostics));
  assertEquals(result.diagnostics, []);
  assert(result.success);
});

Deno.test("upstream svelte-check sanity: Deno CLI error exit and all seven errors", async () => {
  const { code, result, root } = await cli("error");
  assertEquals(code, 1);
  assertErrors(result, root);
});
