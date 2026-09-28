import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { check } from "../src/checker.ts";
import { prepareLspConfig } from "../src/config.ts";

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "svelte-check-config-" });
  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, file);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, source);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

for (const explicit of [false, true]) {
  Deno.test(`checker ${explicit ? "explicit" : "automatic"} tsconfig preserves inheritance, paths, rootDirs, types and strict false`, async () => {
    await fixture({
      "tsconfig.json": JSON.stringify({
        extends: "./config/base.json",
        include: ["src"],
      }),
      "config/base.json": JSON.stringify({
        compilerOptions: {
          strict: false,
          paths: { "@model": ["../src/model.ts"] },
          rootDirs: ["../src", "../generated"],
          types: ["../globals.d.ts"],
        },
      }),
      "globals.d.ts": "declare type Custom = number;",
      "src/model.ts": "export const value: number = 1;",
      "generated/routes/$types.d.ts": "export type Props = { name: number };",
      "src/routes/App.svelte":
        '<script lang="ts">import {value} from "@model"; import type {Props} from "./$types"; let {name}:Props=$props(); let nullable:number=null; let custom:Custom=1;</script><p>{value.toUpperCase()} {name.toUpperCase()} {custom.toUpperCase()} {nullable}</p>',
      ...(explicit
        ? {
          "package.json": JSON.stringify({
            name: "probe",
            type: "module",
            dependencies: { svelte: "5.57.0" },
          }),
        }
        : {}),
    }, async (root) => {
      const configBefore = await Deno.readTextFile(join(root, "tsconfig.json"));
      const result = await check({
        workspace: root,
        ...(explicit ? { config: "tsconfig.json" } : {}),
      });
      assertEquals(result.errorCount, 3, JSON.stringify(result));
      assert(
        result.diagnostics.every((diagnostic) =>
          [2339, 2551].includes(Number(diagnostic.code))
        ),
        JSON.stringify(result),
      );
      assert(
        result.diagnostics.every((diagnostic) =>
          diagnostic.message.includes("toUpperCase")
        ),
      );
      assertEquals(
        await Deno.readTextFile(join(root, "tsconfig.json")),
        configBefore,
      );
    });
  });
}

Deno.test("checker keeps a Deno project's own imports ahead of the fallback map", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      imports: { svelte: "npm:svelte@5.57.0", "@model": "./model.ts" },
      compilerOptions: { strict: false },
    }),
    "model.ts": "export const value: number = 1;",
    "App.svelte":
      '<script lang="ts">import {value} from "@model"; let nullable:number=null;</script><p>{value.toUpperCase()} {nullable}</p>',
  }, async (root) => {
    const original = await Deno.readTextFile(join(root, "deno.json"));
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assert([2339, 2551].includes(Number(result.diagnostics[0].code)));
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), original);
  });
});

Deno.test("checker adds Svelte helpers when a Deno map only defines app aliases", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      imports: { "@model": "./model.ts" },
      compilerOptions: { strict: false },
    }),
    "model.ts": "export const value: number = 1;",
    "App.svelte":
      '<script lang="ts">import {value} from "@model"; let nullable:number=null;</script><p>{value.toUpperCase()} {nullable}</p>',
  }, async (root) => {
    const original = await Deno.readTextFile(join(root, "deno.json"));
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assert([2339, 2551].includes(Number(result.diagnostics[0].code)));
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), original);
    const names = Array.fromAsync(Deno.readDir(root), (entry) => entry.name);
    assert(
      !(await names).some((name) => name.startsWith(".deno-svelte-check-")),
    );
  });
});

Deno.test("checker preserves external map bases and scoped aliases while adding Svelte", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      importMap: "./config/maps/imports.json",
      compilerOptions: { strict: false },
    }),
    "config/maps/imports.json": JSON.stringify({
      imports: { "@model": "../default.ts" },
      scopes: { "../../src/": { "@model": "../scoped.ts" } },
    }),
    "config/default.ts": 'export const value: string = "ok";',
    "config/scoped.ts": "export const value: number = 1;",
    "src/App.svelte":
      '<script lang="ts">import {value} from "@model"; let nullable:number=null;</script><p>{value.toUpperCase()} {nullable}</p>',
  }, async (root) => {
    const original = await Deno.readTextFile(join(root, "deno.json"));
    const map = await Deno.readTextFile(join(root, "config/maps/imports.json"));
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assert([2339, 2551].includes(Number(result.diagnostics[0].code)));
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), original);
    assertEquals(
      await Deno.readTextFile(join(root, "config/maps/imports.json")),
      map,
    );
  });
});

Deno.test("fallback maps preserve explicit Svelte aliases, prefixes and blocks", async () => {
  const imports = {
    svelte: "npm:svelte@5.57.0",
    "svelte/": "./custom/",
    "svelte/elements": null,
  };
  const scopes = { "./src/": { svelte: "npm:svelte@5.56.0" } };
  await fixture(
    { "deno.json": JSON.stringify({ imports, scopes }) },
    async (root) => {
      const prepared = await prepareLspConfig(root);
      const file = prepared.options.config!;
      assertEquals(file, join(root, "deno.json"));
      try {
        const effective = JSON.parse(await Deno.readTextFile(file));
        assertEquals(effective.imports, imports);
        assertEquals(effective.scopes, scopes);
      } finally {
        await prepared.cleanup();
      }
      assertEquals(
        JSON.parse(await Deno.readTextFile(file)),
        { imports, scopes },
      );
    },
  );
});

Deno.test("temporary fallback import maps get removed without changing the project", async () => {
  await fixture({ "tsconfig.json": "{}" }, async (root) => {
    const prepared = await prepareLspConfig(root);
    const file = prepared.options.importMap;
    assert(file);
    const imports = JSON.parse(await Deno.readTextFile(file)).imports;
    assertEquals(imports["svelte/elements"], "npm:svelte@5.57.0/elements");
    assertEquals(prepared.options.config, join(root, "tsconfig.json"));
    await prepared.cleanup();
    let removed = false;
    try {
      await Deno.stat(file);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) removed = true;
      else throw error;
    }
    assert(removed);
    assertEquals(await Deno.readTextFile(join(root, "tsconfig.json")), "{}");
  });
});

for (const explicit of [false, true]) {
  Deno.test(`Kit 3 ${explicit ? "explicit" : "automatic"} config combines $app types and rootDirs with Deno imports`, async () => {
    await fixture({
      "deno.json": JSON.stringify({
        imports: { svelte: "npm:svelte@5.57.0", "@model": "./model.ts" },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "$app/tsconfig",
        include: ["src"],
      }),
      "node_modules/$app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          lib: ["ESNext", "DOM"],
          types: ["$app/types"],
          rootDirs: ["../..", "../../.svelte-kit/types"],
        },
      }),
      "node_modules/$app/types/index.d.ts":
        "declare type KitGenerated = number;",
      "model.ts": "export const value: number = 1;",
      ".svelte-kit/types/src/routes/$types.d.ts":
        "export type PageProps = {data: {name: number}};",
      "src/routes/+page.svelte":
        '<script lang="ts">import {value} from "@model"; let {data}=$props(); let custom:KitGenerated=1;</script><p>{value.toUpperCase()} {data.name.toUpperCase()} {custom.toUpperCase()}</p>',
    }, async (root) => {
      const before = await Deno.readTextFile(join(root, "deno.json"));
      const result = await check({
        workspace: root,
        ...(explicit ? { config: "tsconfig.json" } : {}),
      });
      assertEquals(result.errorCount, 3, JSON.stringify(result));
      assert(
        result.diagnostics.every((item) =>
          [2339, 2551].includes(Number(item.code))
        ),
        JSON.stringify(result),
      );
      assertEquals(await Deno.readTextFile(join(root, "deno.json")), before);
      assert(
        !(await Array.fromAsync(Deno.readDir(root))).some((entry) =>
          entry.name.startsWith(".deno-svelte-check-")
        ),
      );
    });
  });
}

async function installSvelte(root: string): Promise<void> {
  // These fixtures model installed apps; the checker itself can use Deno's cache.
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["install", "--cached-only", "--no-lock", "--quiet"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
}

Deno.test("Kit 3 checks excluded components imported through package #lib with an auto install", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      nodeModulesDir: "auto",
      imports: { svelte: "npm:svelte@5.57.0" },
    }),
    "package.json": JSON.stringify({
      name: "kit-imports-test",
      type: "module",
      dependencies: { svelte: "5.57.0" },
      imports: { "#lib/*": "./src/lib/*" },
    }),
    "tsconfig.json": JSON.stringify({
      extends: "$app/tsconfig",
      include: ["src/routes"],
      exclude: ["src/lib"],
    }),
    "node_modules/$app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        rootDirs: ["../..", "../../.svelte-kit/types"],
        lib: ["ESNext", "DOM", "DOM.Iterable"],
      },
    }),
    "src/routes/Main.svelte":
      '<script lang="ts">import Child from "#lib/Child.svelte";</script><Child value="bad"/>',
    "src/lib/Child.svelte":
      '<script lang="ts">let {value}: {value:number}=$props();</script>{value.toUpperCase()}',
  }, async (root) => {
    await installSvelte(root);
    const denoBefore = await Deno.readTextFile(join(root, "deno.json"));
    const packageBefore = await Deno.readTextFile(join(root, "package.json"));
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 2, JSON.stringify(result));
    assertEquals(result.diagnostics.map((item) => item.code).sort(), [
      2322,
      2339,
    ]);
    assert(
      result.diagnostics.some((item) =>
        item.file.endsWith("/src/lib/Child.svelte")
      ),
    );
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), denoBefore);
    assertEquals(
      await Deno.readTextFile(join(root, "package.json")),
      packageBefore,
    );
  });
});

Deno.test("Kit 3 package imports keep nearest scopes and conditional targets in snapshots", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      nodeModulesDir: "auto",
      imports: { svelte: "npm:svelte@5.57.0" },
      compilerOptions: { strict: true },
    }),
    "package.json": JSON.stringify({
      name: "kit-package-scopes-test",
      type: "module",
      dependencies: { svelte: "5.57.0" },
      imports: { "#lib/*": "./src/lib/*" },
    }),
    "tsconfig.json": JSON.stringify({ include: ["src/routes"] }),
    "src/routes/Main.svelte":
      '<script lang="ts">import Root from "#lib/Child.svelte"; import Inner from "../feature/Inner.svelte";</script><Root value="bad"/><Inner/>',
    "src/lib/Child.svelte":
      '<script lang="ts">let {value}: {value:number}=$props();</script>{value}',
    "src/feature/package.json": JSON.stringify({
      type: "module",
      imports: {
        "#lib/*": { deno: "./lib/*", default: "./browser/*" },
      },
    }),
    "src/feature/Inner.svelte":
      '<script lang="ts">import Child from "#lib/Child.svelte";</script><Child value={1}/>',
    "src/feature/lib/Child.svelte":
      '<script lang="ts">let {value}: {value:string}=$props();</script>{value}',
    "src/feature/browser/Child.svelte":
      '<script lang="ts">let {value}: {value:number}=$props();</script>{value}',
  }, async (root) => {
    await installSvelte(root);
    const denoBefore = await Deno.readTextFile(join(root, "deno.json"));
    const packageBefore = await Deno.readTextFile(
      join(root, "src/feature/package.json"),
    );
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 2, JSON.stringify(result));
    assertEquals(result.diagnostics.map((item) => item.code), [2322, 2322]);
    assert(
      result.diagnostics.some((item) =>
        item.file.endsWith("/src/feature/Inner.svelte")
      ),
    );
    assert(
      result.diagnostics.some((item) =>
        item.file.endsWith("/src/routes/Main.svelte")
      ),
    );
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), denoBefore);
    assertEquals(
      await Deno.readTextFile(join(root, "src/feature/package.json")),
      packageBefore,
    );
  });
});

Deno.test("generated Kit files alone do not switch cached Svelte imports to manual mode", async () => {
  await fixture({
    "deno.json": JSON.stringify({
      nodeModulesDir: "none",
      imports: { svelte: "npm:svelte@5.57.0" },
    }),
    "package.json": JSON.stringify({
      name: "kit-cached-svelte-test",
      type: "module",
      dependencies: { svelte: "5.57.0" },
    }),
    "tsconfig.json": JSON.stringify({
      extends: "$app/tsconfig",
      include: ["src"],
    }),
    "node_modules/$app/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, lib: ["ESNext", "DOM"] },
    }),
    "src/Main.svelte":
      '<script lang="ts">let {value}: {value:number}=$props();</script>{value.toUpperCase()}',
  }, async (root) => {
    const before = await Deno.readTextFile(join(root, "deno.json"));
    const prepared = await prepareLspConfig(root);
    try {
      const config = JSON.parse(
        await Deno.readTextFile(prepared.options.config!),
      );
      assertEquals(config.nodeModulesDir, "none");
    } finally {
      await prepared.cleanup();
    }
    const result = await check({ workspace: root });
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assertEquals(result.diagnostics[0].code, 2339);
    assertEquals(await Deno.readTextFile(join(root, "deno.json")), before);
  });
});
