import { assertEquals } from "@std/assert";

Deno.test("locked dependencies contain no separate TypeScript compiler or svelte2tsx", async () => {
  const lock = JSON.parse(
    await Deno.readTextFile(new URL("../deno.lock", import.meta.url)),
  );
  const forbidden = Object.keys(lock.npm ?? {}).filter((name) =>
    /^(?:typescript@|@typescript\/|svelte2tsx@|svelte-check@|svelte-language-server@)/
      .test(name)
  );
  assertEquals(forbidden, []);
});

Deno.test("CSS helpers use local code and trace-mapping shares Svelte's resolved package", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  const lock = JSON.parse(
    await Deno.readTextFile(new URL("../deno.lock", import.meta.url)),
  );
  const externalHelpers =
    /^(?:npm:)?(?:vscode-css-languageservice|vscode-languageserver-textdocument)(?:@|$)/;
  assertEquals(
    Object.values(config.imports).filter((value) =>
      externalHelpers.test(String(value))
    ),
    [],
  );
  assertEquals(
    Object.keys(lock.specifiers).filter((value) => externalHelpers.test(value)),
    [],
  );
  // Svelte itself still depends on trace-mapping through its remapping package.
  const cssDependencies =
    /^(?:vscode-css-languageservice|vscode-languageserver-textdocument|vscode-languageserver-types|vscode-uri|@vscode\/l10n)@/;
  assertEquals(
    Object.keys(lock.npm).filter((value) => cssDependencies.test(value)),
    [],
  );
  const shared = Object.keys(lock.npm).filter((value) =>
    value.startsWith("@jridgewell/trace-mapping@")
  );
  assertEquals(
    shared.length,
    1,
    "Use the version already required by Svelte, without installing another copy",
  );
  const direct = config.imports["@jridgewell/trace-mapping"];
  assertEquals(
    shared[0],
    `@jridgewell/trace-mapping@${lock.specifiers[direct]}`,
  );
  const remapping = Object.entries(lock.npm).find(([name]) =>
    name.startsWith("@jridgewell/remapping@")
  )?.[1] as { dependencies: string[] };
  assertEquals(
    remapping.dependencies.includes("@jridgewell/trace-mapping"),
    true,
  );
});
