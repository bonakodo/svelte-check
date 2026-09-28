import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { loadSvelteConfig } from "../src/svelte_config.ts";

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "svelte-vite-config-" });
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

// A project-provided Vite API fixture keeps the checker's test graph free of Vite.
// The real Kit 3 / Vite 8 native-loader path also has a separate live smoke test.
const vite = {
  "node_modules/vite/package.json": JSON.stringify({
    name: "vite",
    version: "8.3.0",
    type: "module",
    exports: {
      ".": {
        types: "./wrong.d.ts",
        import: "./index.js",
        default: "./wrong.js",
      },
    },
  }),
  "node_modules/vite/index.js": `
    export async function resolveConfig(options, command) {
      if (options.configLoader !== 'native' || command !== 'serve' || options.logLevel !== 'error') {
        throw new Error('Unexpected Vite resolution options');
      }
      const url = new URL('file://' + options.configFile);
      const module = await import(url.href);
      const config = typeof module.default === 'function'
        ? await module.default({ command, mode: 'development' })
        : await module.default;
      return { ...config, root: options.root };
    }
  `,
  "node_modules/@sveltejs/kit/package.json": JSON.stringify({
    name: "@sveltejs/kit",
    version: "3.0.0-next.27",
  }),
  "node_modules/svelte/package.json": JSON.stringify({
    name: "svelte",
    version: "5.57.0",
  }),
};

Deno.test("raw component projects need no Vite configuration or packages", async () => {
  await fixture({}, async (root) => {
    assertEquals(await loadSvelteConfig(root), {});
  });
});

Deno.test("SvelteKit config loads native TypeScript and keeps preprocessor functions", async () => {
  await fixture({
    ...vite,
    "vite.config.ts": `
      const runes: boolean = true;
      export default async ({ command }) => ({
        plugins: [{ name: 'unrelated' }, {
          name: 'vite-plugin-sveltekit-setup',
          api: { options: {
            compilerOptions: { runes },
            preprocess: { markup: ({ content }) => ({ code: command + ':' + content }) },
            files: { routes: 'src/views' }
          }}
        }]
      });
    `,
  }, async (root) => {
    const config = await loadSvelteConfig(root);
    assertEquals(config.compilerOptions, { runes: true });
    assertEquals(config.routes, "src/views");
    assertEquals(config.configFile, join(root, "vite.config.ts"));
    const preprocess = Array.isArray(config.preprocess)
      ? config.preprocess[0]
      : config.preprocess;
    assertEquals(await preprocess?.markup?.({ content: "<p/>" }), {
      code: "serve:<p/>",
    });
  });
});

Deno.test("explicit Vite filenames resolve project packages from ancestor directories", async () => {
  await fixture({
    ...vite,
    "config/check.vite.mts": `export default {
      plugins: [{ name:'vite-plugin-sveltekit-setup', api:{ options:{ compilerOptions:{runes:false} } } }]
    };`,
  }, async (root) => {
    const config = await loadSvelteConfig(root, "config/check.vite.mts");
    assertEquals(config.configFile, join(root, "config/check.vite.mts"));
    assertEquals(config.compilerOptions, { runes: false });
  });
});

Deno.test("standalone Svelte configs fail with Kit 3 migration advice", async () => {
  for (const extension of ["js", "mjs", "ts", "cjs", "mts", "cts"]) {
    await fixture({ [`svelte.config.${extension}`]: "" }, async (root) => {
      await assertRejects(
        () => loadSvelteConfig(root),
        Error,
        "move the configuration and remove this file",
      );
    });
  }
});

Deno.test("installed unsupported Svelte and Kit versions fail explicitly", async () => {
  for (
    const [name, version, message] of [
      ["@sveltejs/kit", "2.70.0", "supports SvelteKit 3"],
      ["svelte", "4.2.20", "supports Svelte 5"],
      ["svelte", "6.0.0", "supports Svelte 5"],
    ]
  ) {
    await fixture({
      [`node_modules/${name}/package.json`]: JSON.stringify({ name, version }),
    }, async (root) => {
      await assertRejects(() => loadSvelteConfig(root), Error, message);
    });
  }
});

Deno.test("declared unsupported versions fail without installed packages", async () => {
  const cases: [Record<string, string>, string][] = [
    [{
      "deno.json": JSON.stringify({
        nodeModulesDir: "none",
        imports: { svelte: "npm:svelte@4.2.20" },
      }),
    }, "supports Svelte 5"],
    [{
      "deno.jsonc": `{
        // Prefix maps also select a compiler version.
        "imports": { "svelte/": "npm:svelte@^6.0.0/" },
      }`,
    }, "supports Svelte 5"],
    [{
      "deno.json": JSON.stringify({
        scopes: { "./src/": { "kit/vite": "npm:@sveltejs/kit@~2.70.0/vite" } },
      }),
    }, "supports SvelteKit 3"],
    [{
      "deno.json": JSON.stringify({ importMap: "./config/imports.json" }),
      "config/imports.json": JSON.stringify({
        imports: { svelte: "npm:svelte@4.2.20" },
      }),
    }, "supports Svelte 5"],
    [{
      "package.json": JSON.stringify({ dependencies: { svelte: "^4.2.0" } }),
    }, "supports Svelte 5"],
    [{
      "package.json": JSON.stringify({
        devDependencies: { "@sveltejs/kit": "~2.70.0" },
      }),
    }, "supports SvelteKit 3"],
    [{
      "package.json": JSON.stringify({ peerDependencies: { svelte: "6.x" } }),
    }, "supports Svelte 5"],
  ];
  for (const [files, message] of cases) {
    await fixture(files, async (root) => {
      await assertRejects(() => loadSvelteConfig(root), Error, message);
    });
  }
});

Deno.test("supported declarations and unresolved ranges avoid false version rejections", async () => {
  for (
    const version of [
      "^5.57.0",
      "~5.57",
      "5.x",
      "next",
      ">=4 <6",
      "^4 || ^5",
      "workspace:*",
    ]
  ) {
    await fixture({
      "package.json": JSON.stringify({ dependencies: { svelte: version } }),
      "deno.json": JSON.stringify({
        imports: { "@sveltejs/kit": "npm:@sveltejs/kit@3.0.0-next.27" },
      }),
    }, async (root) => {
      assertEquals(await loadSvelteConfig(root), {});
    });
  }
});

Deno.test("Vite configuration failures do not fall back to empty Svelte options", async () => {
  await fixture({}, async (root) => {
    await assertRejects(
      () => loadSvelteConfig(root, "missing.ts"),
      Error,
      "Vite configuration not found",
    );
  });
  await fixture({ "vite.config.ts": "export default {};" }, async (root) => {
    await assertRejects(
      () => loadSvelteConfig(root),
      Error,
      "install the project's Vite",
    );
  });
  await fixture(
    { ...vite, "vite.config.ts": "export default {plugins:[]};" },
    async (root) => {
      await assertRejects(
        () => loadSvelteConfig(root),
        Error,
        "No SvelteKit 3 configuration found",
      );
    },
  );
  await fixture({
    ...vite,
    "vite.config.ts": "throw new Error('broken user config');",
  }, async (root) => {
    await assertRejects(
      () => loadSvelteConfig(root),
      Error,
      "broken user config",
    );
  });
});
