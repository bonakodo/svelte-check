import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { checkInProjectRuntime } from "../src/project_runtime.ts";

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "svelte-runtime-test-" });
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

const packages = {
  "node_modules/vite/package.json": JSON.stringify({
    name: "vite",
    version: "8.3.0",
    type: "module",
    exports: { ".": "./index.js" },
  }),
  "node_modules/vite/index.js": `
    export async function resolveConfig(options) {
      const { pathToFileURL } = await import('node:url');
      const module = await import(pathToFileURL(options.configFile).href);
      return { plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: module.default } }] };
    }
  `,
  "node_modules/@sveltejs/kit/package.json":
    '{"name":"@sveltejs/kit","version":"3.0.0-next.27"}',
  "App.svelte":
    '<script lang="ts">let value: number = 1;</script><p>{value.toUpperCase()}</p>',
};

Deno.test("projects without Vite configs stay in the current runtime", async () => {
  await fixture({}, async (root) => {
    assertEquals(await checkInProjectRuntime(root, {}), undefined);
  });
});

Deno.test("project runtime preserves Deno aliases, package imports and checker dependencies", async () => {
  await fixture({
    ...packages,
    "deno.json": JSON.stringify({
      nodeModulesDir: "none",
      imports: { "@choice": "./choice.ts" },
    }),
    "package.json": JSON.stringify({
      type: "module",
      imports: { "#local": "./local.ts" },
    }),
    "choice.ts": "export const runes: boolean = true;",
    "local.ts": "export const name = 'local';",
    "vite.config.ts": `
      import { runes } from '@choice';
      import { name } from '#local';
      if (name !== 'local') throw new Error('Wrong package import');
      export default { compilerOptions: { runes }, preprocess: { markup: ({content}) => ({code:content}) } };
    `,
  }, async (root) => {
    const original = await Deno.readTextFile(join(root, "deno.json"));
    const result = await checkInProjectRuntime(root, { files: ["App.svelte"] });
    assertEquals(result?.errorCount, 1, JSON.stringify(result));
    assertEquals(result?.diagnostics[0].code, 2339);
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), original);
  });
});

Deno.test("project runtime rebases external maps and retains scoped overrides", async () => {
  await fixture({
    ...packages,
    "deno.json": JSON.stringify({
      nodeModulesDir: "none",
      importMap: "./maps/imports.json",
    }),
    "maps/imports.json": JSON.stringify({
      imports: { "@choice": "../wrong.ts" },
      scopes: { "../config/": { "@choice": "../correct.ts" } },
    }),
    "wrong.ts": "throw new Error('Wrong import-map scope');",
    "correct.ts": "export const runes = true;",
    "config/check.vite.ts":
      "import {runes} from '@choice'; export default {compilerOptions:{runes}};",
  }, async (root) => {
    assertEquals(await checkInProjectRuntime(root, {}), undefined);
    const result = await checkInProjectRuntime(root, {
      viteConfig: "config/check.vite.ts",
      files: ["App.svelte"],
    });
    assertEquals(result?.errorCount, 1, JSON.stringify(result));
    assertEquals(result?.diagnostics[0].code, 2339);
  });
});

Deno.test("project config logs stay off stdout and config errors reach the caller", async () => {
  await fixture({
    ...packages,
    "deno.json": '{"nodeModulesDir":"none"}',
    "vite.config.ts": "console.log('CONFIG-OUTPUT'); export default {};",
  }, async (root) => {
    const script = `
      import {checkInProjectRuntime} from ${
      JSON.stringify(new URL("../src/project_runtime.ts", import.meta.url).href)
    };
      const result = await checkInProjectRuntime(${
      JSON.stringify(root)
    }, {files:['App.svelte']});
      console.log(JSON.stringify(result));
    `;
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-lock", script],
      cwd: fromFileUrl(new URL("../", import.meta.url)),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
    assertEquals(
      JSON.parse(new TextDecoder().decode(output.stdout)).errorCount,
      1,
    );
    assertMatch(new TextDecoder().decode(output.stderr), /CONFIG-OUTPUT/);
    await Deno.writeTextFile(
      join(root, "vite.config.ts"),
      "throw new Error('broken project config');",
    );
    await assertRejects(
      () => checkInProjectRuntime(root, {}),
      Error,
      "broken project config",
    );
  });
});
