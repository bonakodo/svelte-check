import { assertEquals, assertMatch } from "@std/assert";
import { dirname, join } from "@std/path";
import { check } from "../src/checker.ts";
import { prepareLspConfig } from "../src/config.ts";

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "svelte-config-inheritance-" });
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name);
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(file, content);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

for (const mode of ["child", "later parent", "adjacent Deno"] as const) {
  Deno.test(`${mode} baseUrl applies to inherited paths when checking components`, async () => {
    const adjacentDeno = mode === "adjacent Deno";
    await fixture({
      "config/base.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          ignoreDeprecations: "6.0",
          baseUrl: "../original",
          paths: { "@model": ["model.ts"] },
        },
      }),
      "config/override.json": JSON.stringify({
        compilerOptions: { baseUrl: "../override" },
      }),
      "tsconfig.json": JSON.stringify({
        extends: mode === "later parent"
          ? ["./config/base.json", "./config/override.json"]
          : "./config/base.json",
        ...(mode === "child"
          ? { compilerOptions: { baseUrl: "./override" } }
          : {}),
        include: ["App.svelte"],
      }),
      ...(adjacentDeno
        ? {
          "deno.json": JSON.stringify({
            imports: { svelte: "npm:svelte@5.57.0" },
            compilerOptions: { baseUrl: "./override" },
          }),
        }
        : {}),
      "original/model.ts": 'export const value: string = "wrong module";',
      "override/model.ts": "export const value: number = 1;",
      "App.svelte":
        '<script lang="ts">import {value} from "@model";</script><p>{value.toUpperCase()}</p>',
    }, async (root) => {
      const result = await check({ workspace: root });
      assertEquals(result.errorCount, 1, JSON.stringify(result));
      assertEquals(
        result.diagnostics[0].file,
        join(await Deno.realPath(root), "App.svelte"),
      );
      assertMatch(result.diagnostics[0].message, /toUpperCase.*number/);
      // The original alias must not make this invalid expression look valid.
      await Deno.writeTextFile(
        join(root, "App.svelte"),
        '<script lang="ts">import {value} from "@model";</script><p>{value.toFixed()}</p>',
      );
      assertEquals((await check({ workspace: root })).diagnostics, []);
    });
  });
}

Deno.test("no-config fallback uses installed packages without automatic installation", async () => {
  await fixture({
    "node_modules/svelte/package.json": JSON.stringify({
      name: "svelte",
      version: "5.57.0",
    }),
  }, async (root) => {
    const prepared = await prepareLspConfig(root);
    try {
      const config = JSON.parse(
        await Deno.readTextFile(prepared.options.config!),
      );
      assertEquals(config.nodeModulesDir, "manual");
      assertEquals(config.imports.svelte, "npm:svelte@5.57.0");
    } finally {
      await prepared.cleanup();
    }
  });
});
