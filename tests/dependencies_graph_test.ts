import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import {
  buildDependencyGraph,
  type DependencyOptions,
} from "../src/dependencies.ts";
import { discover } from "../src/project.ts";

async function project(
  entries: Record<string, string>,
  roots: string[] | undefined,
  expected: string[],
  options: Partial<Pick<DependencyOptions, "config" | "ignore">> & {
    expectedReachable?: string[];
  } = {},
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "svelte-import-graph-" });
  try {
    for (const [name, source] of Object.entries(entries)) {
      await Deno.mkdir(dirname(join(root, name)), { recursive: true });
      await Deno.writeTextFile(join(root, name), source);
    }
    // Let the graph enforce its supported extensions even for a broad inventory.
    const files = Object.keys(entries).filter((name) =>
      !name.includes("node_modules/")
    ).map((name) => join(root, name));
    const { expectedReachable, ...graphOptions } = options;
    const actual = await buildDependencyGraph({
      root,
      files,
      roots: roots
        ? new Set(roots.map((name) => join(root, name)))
        : (await discover(root, graphOptions)).diagnose,
      ...graphOptions,
    });
    assertEquals(
      [...actual.diagnose].map((file) => relative(root, file)).sort(),
      expected.sort(),
    );
    if (expectedReachable) {
      assertEquals(
        [...actual.reachable].map((file) => relative(root, file)).sort(),
        expectedReachable.sort(),
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("dependency graph includes imported components outside config files and exclude", async () => {
  await project(
    {
      "tsconfig.json": JSON.stringify({
        files: ["Index.svelte"],
        exclude: ["excluded"],
      }),
      "Index.svelte":
        `<script>import Jsdoc from './excluded/Jsdoc.svelte';</script><Jsdoc/>`,
      "excluded/Jsdoc.svelte":
        `<script>import {value} from '../value.js';</script>{value}`,
      "value.ts": `export {value} from './nested/index';`,
      "nested/index.ts": `export const value = 1;`,
      "unused.svelte": `<script>let value=1;</script>{value}`,
    },
    ["Index.svelte"],
    ["Index.svelte", "excluded/Jsdoc.svelte", "value.ts", "nested/index.ts"],
  );
});

Deno.test("dependency graph traverses ignored files without diagnosing them", async () => {
  await project(
    {
      "Index.svelte":
        `<script>import Child from './hidden/Child.svelte';</script><Child/>`,
      "hidden/Child.svelte": `<script>import {x} from '../lib.ts';</script>{x}`,
      "lib.ts": `export const x = 1;`,
    },
    ["Index.svelte"],
    ["Index.svelte", "lib.ts"],
    {
      ignore: ["hidden/**"],
      expectedReachable: ["Index.svelte", "hidden/Child.svelte", "lib.ts"],
    },
  );
});

Deno.test("dependency graph follows import-map aliases and longest matching scopes", async () => {
  await project(
    {
      "deno.json": JSON.stringify({ importMap: "maps/import-map.json" }),
      "maps/import-map.json": JSON.stringify({
        imports: { "$lib/": "../shared/", item: "../Wrong.ts" },
        scopes: { "../src/": { item: "../Scoped.ts" } },
      }),
      "src/Index.svelte":
        `<script>import {x} from '$lib/value.ts'; import {y} from 'item';</script>{x+y}`,
      "shared/value.ts": `export const x = 1;`,
      "Scoped.ts": `export const y = 1;`,
      "Wrong.ts": `export const y = 'wrong';`,
    },
    ["src/Index.svelte"],
    ["src/Index.svelte", "shared/value.ts", "Scoped.ts"],
  );
});

Deno.test("dependency graph inherits baseUrl and paths relative to the declaring config", async () => {
  await project(
    {
      "tsconfig.json": JSON.stringify({
        extends: "./configs/base",
        files: ["Index.ts"],
      }),
      "configs/base.json": JSON.stringify({
        compilerOptions: {
          baseUrl: "../source",
          paths: { "$lib/*": ["missing/*", "lib/*"], exact: ["Exact.ts"] },
        },
      }),
      "Index.ts":
        `import {x} from '$lib/value'; export {e} from 'exact'; import 'base';`,
      "source/lib/value.ts": `export const x = 1;`,
      "source/Exact.ts": `export const e = 1;`,
      "source/base.ts": `export {};`,
    },
    ["Index.ts"],
    ["Index.ts", "source/lib/value.ts", "source/Exact.ts", "source/base.ts"],
  );
});

Deno.test("dependency graph resolves config package extends without scanning its source", async () => {
  await project(
    {
      "tsconfig.json": JSON.stringify({ extends: "@example/config" }),
      "node_modules/@example/config/package.json": JSON.stringify({
        tsconfig: "base.json",
      }),
      "node_modules/@example/config/base.json": JSON.stringify({
        compilerOptions: { paths: { "$lib/*": ["${configDir}/lib/*"] } },
      }),
      "Index.ts": `import '$lib/value'; import 'external-package';`,
      "lib/value.ts": `export {};`,
      "node_modules/external-package/index.ts":
        `import '../../../Unrelated.ts';`,
      "Unrelated.ts": `export {};`,
    },
    ["Index.ts"],
    ["Index.ts", "lib/value.ts"],
  );
});

Deno.test("dependency graph parses comments, escaped script endings, dynamic and type imports", async () => {
  await project(
    {
      "Index.ts": `
      // import './Ghost.ts';
      const text = "</script> import('./Ghost.ts')";
      const regex = /import\\(".\\/Ghost.ts"\\)/;
      type T = import('./Type.ts').T;
      const value = import('./Dynamic.ts');
      export {value as other} from './Export.ts';
    `,
      "Type.ts": `export type T = number;`,
      "Dynamic.ts": `export {};`,
      "Export.ts": `export const value = 1;`,
      "Ghost.ts": `export {};`,
    },
    ["Index.ts"],
    ["Index.ts", "Type.ts", "Dynamic.ts", "Export.ts"],
  );
});

Deno.test("dependency graph parses JSDoc import types and local reference comments", async () => {
  await project(
    {
      "Index.js": `
      /// <reference path="./Reference.ts" />
      /** @type {import('./Types.ts').T} */
      let value;
      /** The docs show import('./Ghost.ts') as an example. */
      const text = "/** @type {import('./Ghost.ts').T} */";
      export {value};
    `,
      "Types.ts": `export type T = number;`,
      "Reference.ts": `export {};`,
      "Ghost.ts": `export {};`,
    },
    ["Index.js"],
    ["Index.js", "Types.ts", "Reference.ts"],
  );
});

Deno.test("dependency graph scans incomplete TypeScript without treating comments or regex strings as imports", async () => {
  await project(
    {
      "Index.ts": [
        "import './Static.ts';",
        "// import './Ghost.ts';",
        "const text = \"import('./Ghost.ts')\";",
        "const pattern = /import\\('.\\/Ghost.ts'\\)/;",
        "if (true) /import\\('.\\/Ghost.ts'\\)/.test(text);",
        "const value = import('./Expression.ts');",
        "const label = `raw import('./Ghost.ts') ${import('./Template.ts')}`;",
        "const common = require('./Required.cjs');",
        "const incomplete =", // Force the fallback token scanner.
      ].join("\n"),
      "Static.ts": `export {};`,
      "Expression.ts": `export {};`,
      "Template.ts": `export {};`,
      "Required.cjs": `require('./FromCommon.js');`,
      "FromCommon.js": `export {};`,
      "Ghost.ts": `export {};`,
    },
    ["Index.ts"],
    [
      "Index.ts",
      "Static.ts",
      "Expression.ts",
      "Template.ts",
      "Required.cjs",
      "FromCommon.js",
    ],
  );
});

Deno.test("dependency graph remains within the provided file inventory and handles cycles", async () => {
  await project(
    {
      "Index.svelte":
        `<script>import './A.ts'; import 'https://example.com/a.ts'; import '../outside.ts';</script>`,
      "A.ts": `import './Index.svelte'; import './B.mjs';`,
      "B.mts": `import './A.ts';`,
      "Unused.ts": `export {};`,
    },
    ["Index.svelte"],
    ["Index.svelte", "A.ts", "B.mts"],
  );
});

Deno.test("dependency graph ignores JSX and TSX roots, imports and extensionless candidates", async () => {
  await project(
    {
      "Index.ts": [
        "import './Unsupported.tsx';",
        "import './Unsupported.jsx';",
        "import './Unsupported.mtsx';",
        "import './Unsupported.ctsx';",
        "import './Unsupported.mjsx';",
        "import './Unsupported.cjsx';",
        "import './choice.js';",
        "import './extensionless';",
        "import './directory';",
      ].join("\n"),
      "Unsupported.tsx": `import './Hidden.ts';`,
      "Unsupported.jsx": `import './Hidden.ts';`,
      "Unsupported.mtsx": `import './Hidden.ts';`,
      "Unsupported.ctsx": `import './Hidden.ts';`,
      "Unsupported.mjsx": `import './Hidden.ts';`,
      "Unsupported.cjsx": `import './Hidden.ts';`,
      "choice.tsx": `import './Hidden.ts';`,
      "choice.js": `export {};`,
      "extensionless.tsx": `import './Hidden.ts';`,
      "directory/index.jsx": `import '../Hidden.ts';`,
      "Hidden.ts": `export {};`,
    },
    ["Index.ts", "Unsupported.jsx", "Unsupported.mtsx"],
    ["Index.ts", "choice.js"],
    { expectedReachable: ["Index.ts", "choice.js"] },
  );
});

Deno.test("dependency graph rejects circular config inheritance", async () => {
  await assertRejects(
    () =>
      project(
        {
          "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
          "base.json": JSON.stringify({ extends: "./tsconfig.json" }),
          "Index.ts": `export {};`,
        },
        ["Index.ts"],
        [],
      ),
    Error,
    "Circular configuration extends",
  );
});

Deno.test("dependency graph prefers extensionless source files over directory indexes", async () => {
  await project(
    {
      "Index.ts": `import './value';`,
      "value.ts": `export {};`,
      "value/index.ts": `export {};`,
    },
    ["Index.ts"],
    ["Index.ts", "value.ts"],
  );
});

Deno.test("dependency graph normalizes relative import-map keys", async () => {
  await project(
    {
      "deno.json": JSON.stringify({
        imports: { "./src/alias.ts": "./src/Actual.ts" },
      }),
      "src/Index.ts": `import './alias.ts';`,
      "src/alias.ts": `export {};`,
      "src/Actual.ts": `export {};`,
    },
    ["src/Index.ts"],
    ["src/Index.ts", "src/Actual.ts"],
  );
});

Deno.test("dependency graph recognizes constant template imports and TypeScript generic arrows", async () => {
  await project(
    {
      "Index.ts": "import(`./View.ts`);",
      "View.ts":
        "const generic = <T extends unknown>(value:T) => value; import(`./Value.ts`);",
      "Value.ts": `export {};`,
    },
    ["Index.ts"],
    ["Index.ts", "View.ts", "Value.ts"],
  );
});

Deno.test("incomplete TypeScript keeps imports after angle assertions and generic expressions", async () => {
  await project(
    {
      "Index.ts": [
        "const value = <Thing>input; import './Assertion.ts';",
        "const generic = <T>(value:T) => value; import './Generic.ts';",
        "const typed = <import('./Types.ts').Thing>input;",
        "const pattern = <RegExp> /import('.\\/Ghost.ts')/;",
        "const divided = generic<number> / 2; import('./After.ts');",
        "const comparison = a < b > / divisor; import('./AfterComparison.ts');",
        "const call = generic<number>() / divisor; import('./AfterCall.ts');",
        "const incomplete = ;",
      ].join("\n"),
      "Assertion.ts": "export {};",
      "Generic.ts": "export {};",
      "Types.ts": "export type Thing = number;",
      "After.ts": "export {};",
      "AfterComparison.ts": "export {};",
      "AfterCall.ts": "export {};",
      "Ghost.ts": "export {};",
    },
    ["Index.ts"],
    [
      "Index.ts",
      "Assertion.ts",
      "Generic.ts",
      "Types.ts",
      "After.ts",
      "AfterComparison.ts",
      "AfterCall.ts",
    ],
  );
});

Deno.test("Kit 3 package #lib imports reach components outside the configured include", async () => {
  await project(
    {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#lib/*": { deno: "./src/lib/*", default: "./src/browser/*" },
        },
      }),
      "tsconfig.json": JSON.stringify({
        extends: "$app/tsconfig",
        include: ["src/routes"],
        exclude: ["src/lib"],
      }),
      // Kit 3 creates these config files directly, without a $app package.json.
      "node_modules/$app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: {},
          rootDirs: ["../..", "../../.svelte-kit/types"],
          types: ["$app/types"],
          lib: ["ESNext", "DOM", "DOM.Iterable"],
        },
      }),
      "src/routes/+page.svelte":
        `<script>import Child from '#lib/Child.svelte';</script><Child/>`,
      "src/lib/Child.svelte":
        `<script>import {value} from '#lib/value.ts';</script>{value}`,
      "src/lib/value.ts": `export const value = 1;`,
      "src/lib/Unused.svelte": `<p>Unused</p>`,
      "src/browser/Child.svelte": `<p>Browser variant</p>`,
    },
    undefined,
    ["src/routes/+page.svelte", "src/lib/Child.svelte", "src/lib/value.ts"],
  );
});

Deno.test("package imports select exact and most specific wildcard patterns", async () => {
  await project(
    {
      "package.json": JSON.stringify({
        imports: {
          "#lib/*": "./general/*",
          "#lib/*.svelte": "./components/*.svelte",
          "#lib/admin/*": "./admin/*",
          "#lib/Exact.svelte": "./Exact.svelte",
        },
      }),
      "Index.ts":
        `import '#lib/Child.svelte'; import '#lib/admin/Page.svelte'; import '#lib/Exact.svelte'; import '#lib/value.ts';`,
      "components/Child.svelte": "",
      "admin/Page.svelte": "",
      "Exact.svelte": "",
      "general/value.ts": "",
      "general/Child.svelte": "",
      "components/admin/Page.svelte": "",
      "components/Exact.svelte": "",
    },
    ["Index.ts"],
    [
      "Index.ts",
      "components/Child.svelte",
      "admin/Page.svelte",
      "Exact.svelte",
      "general/value.ts",
    ],
  );
});

Deno.test("package import conditions follow Deno type-check order and nested fallbacks", async () => {
  await project(
    {
      "package.json": JSON.stringify({
        type: "module",
        imports: {
          "#types": { types: "./Types.svelte", deno: "./Wrong.svelte" },
          "#deno": { deno: "./Deno.svelte", types: "./Wrong.svelte" },
          "#node": { node: "./Node.svelte", deno: "./Wrong.svelte" },
          "#default": { default: "./Default.svelte", deno: "./Wrong.svelte" },
          "#nested": {
            browser: "./Wrong.svelte",
            deno: { require: "./Wrong.svelte" },
            import: [null, { browser: "./Wrong.svelte" }, "./Import.svelte"],
          },
          "#blocked": { deno: null, default: "./Wrong.svelte" },
          "#missing": ["./Missing.svelte", "./Wrong.svelte"],
          "#external": "external-package",
        },
      }),
      "Index.ts": [
        "types",
        "deno",
        "node",
        "default",
        "nested",
        "blocked",
        "missing",
        "external",
      ].map((name) => `import '#${name}';`).join("\n"),
      "Types.svelte": "",
      "Deno.svelte": "",
      "Node.svelte": "",
      "Default.svelte": "",
      "Import.svelte": "",
      "Wrong.svelte": "",
      "node_modules/external-package/index.ts": `import '../../Wrong.svelte';`,
    },
    ["Index.ts"],
    [
      "Index.ts",
      "Types.svelte",
      "Deno.svelte",
      "Node.svelte",
      "Default.svelte",
      "Import.svelte",
    ],
  );
});

Deno.test("Deno import maps override package imports including blocked aliases", async () => {
  await project(
    {
      "deno.json": JSON.stringify({
        imports: { "#lib/": "./mapped/", "#blocked": null },
        scopes: { "./nested/": { "#lib/": "./scoped/" } },
      }),
      "package.json": JSON.stringify({
        imports: { "#lib/*": "./Wrong.svelte", "#blocked": "./Wrong.svelte" },
      }),
      "Index.ts":
        `import '#lib/Child.svelte'; import './nested/Index.ts'; import '#blocked';`,
      "nested/Index.ts": `import '#lib/Child.svelte';`,
      "mapped/Child.svelte": "",
      "scoped/Child.svelte": "",
      "Wrong.svelte": "",
    },
    ["Index.ts"],
    [
      "Index.ts",
      "nested/Index.ts",
      "mapped/Child.svelte",
      "scoped/Child.svelte",
    ],
  );
});

Deno.test("package imports use the nearest package scope and stop at an empty scope", async () => {
  await project(
    {
      "package.json": JSON.stringify({
        imports: { "#lib": "./Outer.svelte", "#empty": "./Wrong.svelte" },
      }),
      "Index.ts":
        `import '#lib'; import './nested/Index.ts'; import './empty/Index.ts';`,
      "nested/package.json": JSON.stringify({
        imports: { "#lib": "./Inner.svelte" },
      }),
      "nested/Index.ts": `import '#lib';`,
      "nested/Inner.svelte": "",
      "empty/package.json": "{}",
      "empty/Index.ts": `import '#empty';`,
      "Outer.svelte": "",
      "Wrong.svelte": "",
    },
    ["Index.ts"],
    [
      "Index.ts",
      "nested/Index.ts",
      "nested/Inner.svelte",
      "empty/Index.ts",
      "Outer.svelte",
    ],
  );
});

Deno.test("Kit 3 service-worker config paths resolve relative to the generated config", async () => {
  await project(
    {
      "tsconfig.worker.json": JSON.stringify({
        extends: "$app/tsconfig/service-worker",
        files: ["src/service-worker.ts"],
      }),
      "node_modules/$app/tsconfig/service-worker.json": JSON.stringify({
        compilerOptions: {
          paths: { "worker-tools/*": ["../../../src/worker-tools/*"] },
          lib: ["ESNext", "WebWorker"],
          types: ["$app/types"],
        },
      }),
      "src/service-worker.ts": `import 'worker-tools/cache.ts';`,
      "src/worker-tools/cache.ts": "export {};",
      "src/Unused.svelte": "",
    },
    undefined,
    ["src/service-worker.ts", "src/worker-tools/cache.ts"],
    { config: "tsconfig.worker.json" },
  );
});
