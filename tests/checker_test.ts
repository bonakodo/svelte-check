import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { check } from "../src/checker.ts";
import { offsetAt } from "../src/transform/writer.ts";

async function fixture(
  files: Record<string, string>,
  config: Record<string, unknown> = {},
) {
  const root = await Deno.makeTempDir({ prefix: "svelte-check-project-" });
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "none",
      imports: { svelte: "npm:svelte@5.57.0" },
      compilerOptions: {
        strict: true,
        checkJs: true,
        lib: ["esnext", "dom", "dom.iterable"],
      },
      ...config,
    }),
  );
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  return { root, cleanup: () => Deno.remove(root, { recursive: true }) };
}

// Exercise the project's Vite loader and Kit plugin options without adding
// Vite or Kit to the checker's own dependency graph.
function vitePreprocessor(markup: string): Record<string, string> {
  return {
    "node_modules/vite/package.json": JSON.stringify({
      name: "vite",
      version: "8.3.0",
      type: "module",
      exports: { ".": "./index.js" },
    }),
    "node_modules/vite/index.js": `
      export async function resolveConfig(options, command) {
        if (options.configLoader !== 'native' || command !== 'serve') {
          throw new Error('Expected native Vite config loading');
        }
        return (await import(new URL('file://' + options.configFile).href)).default;
      }
    `,
    "node_modules/@sveltejs/kit/package.json": JSON.stringify({
      name: "@sveltejs/kit",
      version: "3.0.0-next.27",
    }),
    "vite.config.ts": `export default {
      plugins: [{ name: 'vite-plugin-sveltekit-setup', api: { options: {
        preprocess: { markup: ${markup} }
      } } }]
    };`,
  };
}

Deno.test("checker reports exact script, component-prop and markup positions", async () => {
  const source =
    `<script lang="ts">import Child from './Child.svelte'; let count: number = "bad";</script>\n<Child value="bad" />\n<p>{count.toUpperCase()}</p>`;
  const f = await fixture({
    "Child.svelte":
      `<script lang="ts">let { value }: {value: number} = $props();</script><p>{value}</p>`,
    "App.svelte": source,
  });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.errorCount, 3, JSON.stringify(result));
    assertEquals(result.diagnostics.map((d) => d.code), [2322, 2322, 2339]);
    assertEquals(result.diagnostics.map((d) => d.range.start.line), [0, 1, 2]);
    assertEquals(
      source.slice(
        offsetAt(source, result.diagnostics[2].range.start),
        offsetAt(source, result.diagnostics[2].range.end),
      ),
      "toUpperCase",
    );
    assertEquals(result.success, false);
  } finally {
    await f.cleanup();
  }
});

Deno.test("checker accepts valid runes, blocks and cross-component props", async () => {
  const f = await fixture({
    "Child.svelte":
      `<script lang="ts">let { value }: {value: number} = $props();</script><p>{value}</p>`,
    "App.svelte":
      `<script lang="ts">import Child from './Child.svelte'; let values = $state([1,2]);</script>\n{#each values as value}<Child {value} />{#if value > 1}<p>{value.toFixed()}</p>{/if}{/each}`,
  });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.diagnostics, []);
    assert(result.success);
  } finally {
    await f.cleanup();
  }
});

Deno.test("checker honors Deno import maps and checks ordinary TypeScript", async () => {
  const f = await fixture({
    "model.ts": `export const value: number = 1;`,
    "App.svelte":
      `<script lang="ts">import {value} from '@model';</script><p>{value.toUpperCase()}</p>`,
    "consumer.ts":
      `import Child from './Child.svelte'; import type {ComponentProps} from 'svelte'; const p: ComponentProps<typeof Child> = {value: 'bad'}; export {p};`,
    "Child.svelte":
      `<script lang="ts">export let value: number;</script><p>{value}</p>`,
  }, { imports: { svelte: "npm:svelte@5.57.0", "@model": "./model.ts" } });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.errorCount, 2, JSON.stringify(result));
    assertEquals(
      new Set(result.diagnostics.map((d) => d.code)),
      new Set([2322, 2339]),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("checker includes compiler and CSS diagnostics with warning controls", async () => {
  const f = await fixture({
    "App.svelte":
      `<img src="test.png" />\n<style>.unused { colr: red; }</style>`,
  });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.errorCount, 0, JSON.stringify(result));
    assert(result.diagnostics.some((d) => d.code === "a11y_missing_attribute"));
    assert(result.diagnostics.some((d) => d.code === "css_unused_selector"));
    assert(
      result.diagnostics.some((d) =>
        d.source === "css" && d.code === "unknownProperties"
      ),
    );
    const strict = await check({ workspace: f.root, failOnWarnings: true });
    assertEquals(strict.success, false);
    const changed = await check({
      workspace: f.root,
      diagnosticSources: ["svelte"],
      compilerWarnings: {
        a11y_missing_attribute: "error",
        css_unused_selector: "ignore",
      },
    });
    assertEquals(changed.errorCount, 1);
    assertEquals(changed.warningCount, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("checker reports a parse failure without a cascade of generated errors", async () => {
  const f = await fixture({
    "App.svelte": `<script lang="ts">let = ;</script>`,
  });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.errorCount, 1);
    assertEquals(result.diagnostics[0].source, "svelte");
    assert(!result.success);
  } finally {
    await f.cleanup();
  }
});

Deno.test("selected files still resolve unselected local components", async () => {
  const f = await fixture({
    "Child.svelte":
      `<script lang="ts">export let value: number;</script><p>{value}</p>`,
    "App.svelte":
      `<script lang="ts">import Child from './Child.svelte';</script><Child value="wrong" />`,
    "unrelated.ts": `export const broken: number = 'bad';`,
  });
  try {
    const result = await check({ workspace: f.root, files: ["App.svelte"] });
    assertEquals(result.fileCount, 1);
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assertEquals(result.diagnostics[0].code, 2322);
    await assertRejects(
      () => check({ workspace: f.root, files: ["absent.svelte"] }),
      Error,
      "No source files match",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("checker works without project configuration and leaves no generated files", async () => {
  const f = await fixture({
    "App.svelte":
      `<script lang="ts">let value = $state(1);</script><button onclick={() => value++}>{value}</button>`,
  });
  try {
    await Deno.remove(join(f.root, "deno.json"));
    const result = await check({ workspace: f.root });
    assertEquals(result.diagnostics, []);
    const entries = [];
    for await (const entry of Deno.readDir(f.root)) entries.push(entry.name);
    assertEquals(entries, ["App.svelte"]);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a broken imported component cannot make a selected importer pass", async () => {
  const f = await fixture({
    "Child.svelte": `<script lang="ts">let = ;</script>`,
    "App.svelte":
      `<script>import Child from './Child.svelte';</script><Child />`,
    "Unrelated.svelte": `<script lang="ts">let = ;</script>`,
  });
  try {
    const result = await check({ workspace: f.root, files: ["App.svelte"] });
    assertEquals(result.success, false);
    assert(result.errorCount > 0);
    assert(result.diagnostics.every((d) => d.file.endsWith("App.svelte")));
  } finally {
    await f.cleanup();
  }
});

Deno.test("Kit 3 Vite preprocessor maps diagnostics back to the original component", async () => {
  const f = await fixture({
    ...vitePreprocessor(
      `({content, filename}) => ({code: '\\n' + content, map: {version:3, sources:[filename], sourcesContent:[content], names:[], mappings:';AAAA;AACA'}})`,
    ),
    "App.svelte":
      `<script lang="ts">let value: number = 'bad';</script>\n<p>{value}</p>`,
  });
  try {
    const result = await check({ workspace: f.root, files: ["App.svelte"] });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assertEquals(result.diagnostics[0].range.start.line, 0);
    assertEquals(result.diagnostics[0].code, 2322);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a changed Kit 3 Vite preprocessor output without a map fails explicitly", async () => {
  const f = await fixture({
    ...vitePreprocessor(`({content}) => ({code: '\\n' + content})`),
    "App.svelte": `<p>hello</p>`,
  });
  try {
    const result = await check({ workspace: f.root, files: ["App.svelte"] });
    assertEquals(result.errorCount, 1);
    assertMatch(result.diagnostics[0].message, /without a source map/);
  } finally {
    await f.cleanup();
  }
});

Deno.test("SvelteKit page props use generated route types through rootDirs", async () => {
  const f = await fixture({
    "src/routes/+page.svelte":
      `<script lang="ts">let {data} = $props();</script><p>{data.title.toFixed()}</p>`,
    ".svelte-kit/types/src/routes/$types.d.ts":
      `export type PageData = {title:string}; export type PageProps = {data:PageData};`,
  }, {
    compilerOptions: {
      strict: true,
      lib: ["esnext", "dom", "dom.iterable"],
      rootDirs: [".", "./.svelte-kit/types"],
    },
  });
  try {
    const result = await check({ workspace: f.root });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assertEquals(
      [2339, 2551].includes(Number(result.diagnostics[0].code)),
      true,
    );
    assertMatch(result.diagnostics[0].message, /toFixed.*string/);
    await Deno.writeTextFile(
      join(f.root, "src/routes/+page.svelte"),
      `<script lang="ts">let {data} = $props();</script><p>{data.title.toUpperCase()}</p>`,
    );
    assertEquals((await check({ workspace: f.root })).diagnostics, []);
  } finally {
    await f.cleanup();
  }
});

Deno.test("CLI uses exit 0 for success, 1 for diagnostics, 2 for invocation errors", async () => {
  const f = await fixture({ "App.svelte": `<p>valid</p>` });
  const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
  const config = fromFileUrl(new URL("../deno.json", import.meta.url));
  const run = (args: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "-A",
        cli,
        "--workspace",
        f.root,
        "--output",
        "json",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  try {
    const success = await run([]);
    assertEquals(success.code, 0, new TextDecoder().decode(success.stderr));
    assertEquals(
      JSON.parse(new TextDecoder().decode(success.stdout)).success,
      true,
    );
    await Deno.writeTextFile(
      join(f.root, "App.svelte"),
      `<script lang="ts">let value:number='bad';</script>{value}`,
    );
    assertEquals((await run([])).code, 1);
    assertEquals((await run(["--unknown-option"])).code, 2);
  } finally {
    await f.cleanup();
  }
});

Deno.test({
  name: "CLI watch rechecks edits and shuts down cleanly",
  ignore: Deno.build.os === "windows",
  async fn() {
    const f = await fixture({ "App.svelte": `<p>valid</p>` }, { imports: {} });
    const cli = fromFileUrl(new URL("../cli.ts", import.meta.url));
    const config = fromFileUrl(new URL("../deno.json", import.meta.url));
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "-A",
        cli,
        "--workspace",
        f.root,
        "--watch",
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let output = "";
    let cursor = 0;
    const stdout = (async () => {
      for await (
        const text of child.stdout.pipeThrough(new TextDecoderStream())
      ) output += text;
    })();
    const stderr = new Response(child.stderr).text();
    let stopped = false;
    const until = async (text: string) => {
      const deadline = Date.now() + 10_000;
      while (!output.slice(cursor).includes(text)) {
        if (Date.now() > deadline) {
          throw new Error(`Watch did not print ${text}: ${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      cursor = output.indexOf(text, cursor) + text.length;
    };
    try {
      await until("0 errors");
      const initialOutput = output;
      // Temporary fallback configs must not trigger a watch loop.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assertEquals(output, initialOutput);
      await Deno.writeTextFile(
        join(f.root, "App.svelte"),
        `<script lang="ts">let value:number='bad';</script>{value}`,
      );
      await until("1 errors");
      await Deno.writeTextFile(
        join(f.root, "App.svelte"),
        `<script lang="ts">let value:number=1;</script>{value}`,
      );
      await until("0 errors");
      child.kill("SIGINT");
      const status = await child.status;
      stopped = true;
      assertEquals(status.code, 0, await stderr);
    } finally {
      if (!stopped) {
        child.kill();
        await child.status;
      }
      await stdout;
      await stderr;
      await f.cleanup();
    }
  },
});
