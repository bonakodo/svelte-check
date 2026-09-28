import { dirname, join, relative } from "@std/path";
import { discover } from "../src/project.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && pattern.test(error.message)) return;
    throw new Error(`Expected ${pattern}, got ${String(error)}`);
  }
  throw new Error(`Expected ${pattern}`);
}

async function fixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
  suffix = "project",
): Promise<void> {
  const temporary = await Deno.makeTempDir({ prefix: "svelte-check-project-" });
  const root = join(temporary, suffix);
  try {
    await Deno.mkdir(root, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      const path = join(root, name);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, contents);
    }
    await run(root);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

function names(root: string, files: Iterable<string>): string[] {
  return [...files].map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
}

Deno.test("discovery ignores generated names only below the workspace root", async () => {
  await fixture({
    "src/App.svelte": "",
    "src/helper.ts": "",
    "src/types.d.ts": "",
    "dist/generated.svelte": "",
    "node_modules/pkg/App.svelte": "",
    ".hidden/Keep.svelte": "",
  }, async (root) => {
    const result = await discover(root, {});
    equal(names(root, result.all), [
      ".hidden/Keep.svelte",
      "src/App.svelte",
      "src/helper.ts",
    ]);
    equal(names(root, result.diagnose), names(root, result.all));
  }, "build/.git/[fixtures]/project");
});

Deno.test("discovery includes plain JS and TS modules but excludes JSX and TSX", async () => {
  const supported = ["svelte", "ts", "js", "mts", "cts", "mjs", "cjs"];
  const unsupported = ["tsx", "jsx", "mtsx", "ctsx", "mjsx", "cjsx"];
  await fixture(
    Object.fromEntries(
      [...supported, ...unsupported].map((
        extension,
      ) => [`src/File.${extension}`, ""]),
    ),
    async (root) => {
      const result = await discover(root, {});
      equal(
        names(root, result.all),
        supported.map((extension) => `src/File.${extension}`).sort(),
      );
      equal(names(root, result.diagnose), names(root, result.all));
      for (const extension of ["tsx", "jsx"]) {
        await rejects(
          () => discover(root, { files: [`src/File.${extension}`] }),
          /No source files match/,
        );
      }
    },
  );
});

Deno.test("explicit selection and ignore keep all dependency components open", async () => {
  await fixture(
    { "Parent.svelte": "", "Child.svelte": "", "other.ts": "" },
    async (root) => {
      const selected = await discover(root, {
        files: ["Parent.svelte"],
        ignore: ["Child.svelte"],
      });
      equal(names(root, selected.diagnose), ["Parent.svelte"]);
      equal(names(root, selected.all), [
        "Child.svelte",
        "Parent.svelte",
        "other.ts",
      ]);
      const ignored = await discover(root, {
        ignore: ["*.svelte", "!Parent.svelte"],
      });
      equal(names(root, ignored.diagnose), ["Parent.svelte", "other.ts"]);
      await rejects(
        () => discover(root, { files: ["missing/**/*.svelte"] }),
        /No source files match/,
      );
      await rejects(
        () => discover(root, { files: ["../outside.svelte"] }),
        /No source files match/,
      );
    },
  );
});

Deno.test("Deno JSONC includes, excludes and ordered reinclusion select diagnostics", async () => {
  await fixture({
    "deno.jsonc":
      '{ // project roots\n "include": ["src/"], "exclude": ["src/skip", "!src/skip/Keep.svelte"], }',
    "src/App.svelte": "",
    "src/skip/Bad.svelte": "",
    "src/skip/Keep.svelte": "",
    "test/Test.svelte": "",
  }, async (root) => {
    const result = await discover(root, {});
    equal(names(root, result.diagnose), [
      "src/App.svelte",
      "src/skip/Keep.svelte",
    ]);
    equal(result.all.length, 4);
    const explicit = await discover(root, { files: ["test/**/*.svelte"] });
    equal(names(root, explicit.diagnose), ["test/Test.svelte"]);
  });
});

Deno.test("custom config filenames and glob characters in the workspace name work", async () => {
  await fixture({
    "checks.json":
      '{"include":["src/**/*.{svelte,ts}"],"exclude":["**/skip?.ts"]}',
    "src/App.svelte": "",
    "src/helper.ts": "",
    "src/skip1.ts": "",
    "elsewhere.svelte": "",
  }, async (root) => {
    const result = await discover(root, { config: "checks.json" });
    equal(names(root, result.diagnose), ["src/App.svelte", "src/helper.ts"]);
  }, "[a] project (copy)");
});

Deno.test("relative extends preserves the directory of inherited selection rules", async () => {
  await fixture({
    "tsconfig.json": '{"extends":"./configs/middle"}',
    "configs/middle.json": '{"extends":"./base.json"}',
    "configs/base.json": '{"include":["../src"],"exclude":["../src/skip"]}',
    "src/App.svelte": "",
    "src/skip/Child.svelte": "",
    "outside.svelte": "",
  }, async (root) => {
    const result = await discover(root, {});
    equal(names(root, result.diagnose), ["src/App.svelte"]);
    equal(result.all.length, 3);
  });
});

Deno.test("multiple extends, files union, empty overrides and configDir work", async () => {
  await fixture({
    "tsconfig.json":
      '{"extends":["./configs/first.json","./configs/second.json"],"exclude":[],"files":["extra.svelte"]}',
    "configs/first.json":
      '{"include":["${configDir}/src"],"exclude":["${configDir}/src/skip"]}',
    "configs/second.json": '{"compilerOptions":{"strict":true}}',
    "src/App.svelte": "",
    "src/skip/Child.svelte": "",
    "extra.svelte": "",
    "unselected.svelte": "",
  }, async (root) => {
    const result = await discover(root, {});
    equal(names(root, result.diagnose), [
      "extra.svelte",
      "src/App.svelte",
      "src/skip/Child.svelte",
    ]);
    await Deno.writeTextFile(
      join(root, "tsconfig.json"),
      '{"files":["extra.svelte"],"exclude":["extra.svelte"]}',
    );
    equal(names(root, (await discover(root, {})).diagnose), ["extra.svelte"]);
    await Deno.writeTextFile(join(root, "tsconfig.json"), '{"include":[]}');
    equal((await discover(root, {})).diagnose.size, 0);
  });
});

Deno.test("installed config packages and inherited output directories resolve", async () => {
  await fixture({
    "tsconfig.json": '{"extends":"@example/config"}',
    "node_modules/@example/config/package.json": '{"tsconfig":"base.json"}',
    "node_modules/@example/config/base.json":
      '{"include":["${configDir}/**/*"],"compilerOptions":{"outDir":"${configDir}/generated"}}',
    "App.svelte": "",
    "generated/Output.svelte": "",
  }, async (root) => {
    const result = await discover(root, {});
    equal(names(root, result.diagnose), ["App.svelte"]);
    equal(result.all.length, 2);
  });
});

Deno.test("Kit 3 generated $app config keeps file selection in the consuming project", async () => {
  await fixture({
    "tsconfig.json": JSON.stringify({
      extends: "$app/tsconfig",
      include: ["src/routes"],
      files: ["src/app.ts"],
    }),
    // Shape emitted by @sveltejs/kit 3.0.0-next.27's write_parent_tsconfig.
    "node_modules/$app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        paths: {},
        rootDirs: ["../..", "../../.svelte-kit/types"],
        types: ["$app/types"],
        lib: ["ESNext", "DOM", "DOM.Iterable"],
      },
    }),
    "src/routes/+page.svelte": "",
    "src/app.ts": "",
    "src/lib/Unused.svelte": "",
  }, async (root) => {
    equal(names(root, (await discover(root, {})).diagnose), [
      "src/app.ts",
      "src/routes/+page.svelte",
    ]);
    await Deno.writeTextFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: "$app/tsconfig" }),
    );
    equal(names(root, (await discover(root, {})).diagnose), [
      "src/app.ts",
      "src/lib/Unused.svelte",
      "src/routes/+page.svelte",
    ]);
  });
});

Deno.test("Kit 3 service-worker config resolves its nested generated filename", async () => {
  await fixture({
    "tsconfig.worker.json": JSON.stringify({
      extends: "$app/tsconfig/service-worker",
      files: ["src/service-worker.ts"],
    }),
    "node_modules/$app/tsconfig/service-worker.json": JSON.stringify({
      compilerOptions: {
        paths: {},
        types: ["$app/types"],
        lib: ["ESNext", "WebWorker"],
      },
    }),
    "src/service-worker.ts": "",
    "src/routes/+page.svelte": "",
  }, async (root) => {
    const result = await discover(root, { config: "tsconfig.worker.json" });
    equal(names(root, result.diagnose), ["src/service-worker.ts"]);
  });
});

Deno.test("Deno exclusions combine with adjacent tsconfig includes", async () => {
  await fixture({
    "deno.json": '{"exclude":["src/Excluded.svelte"]}',
    "tsconfig.json": '{"include":["src"]}',
    "src/App.svelte": "",
    "src/Excluded.svelte": "",
    "test/Test.svelte": "",
  }, async (root) => {
    equal(names(root, (await discover(root, {})).diagnose), ["src/App.svelte"]);
  });
});

Deno.test("bad configs fail clearly instead of silently selecting every file", async () => {
  await fixture({
    "App.svelte": "",
    "tsconfig.json": '{"extends":"./other.json"}',
    "other.json": '{"extends":"./tsconfig.json"}',
  }, async (root) => {
    await rejects(() => discover(root, {}), /Circular configuration extends/);
    await Deno.writeTextFile(
      join(root, "tsconfig.json"),
      '{"extends":"missing-config-package"}',
    );
    await rejects(
      () => discover(root, {}),
      /Cannot resolve extended configuration/,
    );
    await Deno.writeTextFile(join(root, "tsconfig.json"), '{"include":"src"}');
    await rejects(() => discover(root, {}), /include must be an array/);
    await Deno.writeTextFile(
      join(root, "tsconfig.json"),
      '{"files":["Missing.svelte"]}',
    );
    await rejects(() => discover(root, {}), /Configured source is missing/);
  });
});

Deno.test({
  name: "discovery skips symlink loops and source links outside the workspace",
  ignore: Deno.build.os === "windows",
  async fn() {
    await fixture(
      { "App.svelte": "", "../Outside.svelte": "" },
      async (root) => {
        await Deno.symlink(root, join(root, "loop"));
        await Deno.symlink(
          join(dirname(root), "Outside.svelte"),
          join(root, "External.svelte"),
        );
        equal(names(root, (await discover(root, {})).all), ["App.svelte"]);
        await rejects(
          () => discover(root, { files: ["External.svelte"] }),
          /No source files match/,
        );
      },
    );
  },
});
