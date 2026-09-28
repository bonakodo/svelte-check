import { assertEquals, assertThrows } from "@std/assert";
import { formatResult, parseArgs } from "../cli.ts";

Deno.test("CLI parses project, warning, source and file options", () => {
  assertEquals(
    parseArgs([
      "--workspace",
      "/project",
      "--tsconfig=tsconfig.json",
      "--vite-config=custom.vite.ts",
      "--ignore",
      "dist,build",
      "--diagnostic-sources",
      "js,svelte",
      "--compiler-warnings",
      "css_unused_selector:ignore,a11y_missing_attribute:error",
      "--fail-on-warnings",
      "--output=json",
      "src/**/*.svelte",
    ]),
    {
      check: {
        workspace: "/project",
        config: "tsconfig.json",
        viteConfig: "custom.vite.ts",
        ignore: ["dist", "build"],
        diagnosticSources: ["js", "svelte"],
        compilerWarnings: {
          css_unused_selector: "ignore",
          a11y_missing_attribute: "error",
        },
        failOnWarnings: true,
        files: ["src/**/*.svelte"],
      },
      output: "json",
      watch: false,
      help: false,
      version: false,
    },
  );
});

Deno.test("CLI rejects unknown and incomplete options", () => {
  for (
    const args of [
      ["--what"],
      ["--svelte-config", "svelte.config.js"],
      ["--workspace"],
      ["--workspace", "--watch"],
      ["--output", "unknown"],
      ["--diagnostic-sources", "html"],
      ["--compiler-warnings", "bad:warn"],
    ]
  ) assertThrows(() => parseArgs(args));
});

Deno.test("CLI emits stable structured and human diagnostics", () => {
  const result = {
    diagnostics: [{
      file: "/project/App.svelte",
      range: {
        start: { line: 1, character: 2 },
        end: { line: 1, character: 4 },
      },
      severity: "error" as const,
      source: "js" as const,
      code: 2322,
      message: "Wrong type",
    }],
    fileCount: 1,
    errorCount: 1,
    warningCount: 0,
    success: false,
  };
  assertEquals(JSON.parse(formatResult(result, "/project", "json")), result);
  assertEquals(
    formatResult(result, "/project", "human"),
    "App.svelte:2:3 error [js/2322] Wrong type\nChecked 1 files: 1 errors, 0 warnings.",
  );
});
