import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { VERSION } from "./src/version.ts";

const root = fromFileUrl(new URL("./", import.meta.url));

async function copy(source: string, target: string): Promise<void> {
  if ((await Deno.stat(source)).isDirectory) {
    await Deno.mkdir(target, { recursive: true });
    for await (const entry of Deno.readDir(source)) {
      await copy(join(source, entry.name), join(target, entry.name));
    }
  } else {
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.copyFile(source, target);
  }
}

Deno.test("published files run API, CLI and project worker with a fresh Deno cache", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "svelte-release-test-" });
  try {
    const config = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
    assertEquals(config.version, VERSION);
    const pkg = join(temporary, "package");
    for (const file of config.publish.include) {
      await copy(join(root, file), join(pkg, file));
    }
    const project = join(temporary, "consumer");
    await Deno.mkdir(project);
    await Deno.writeTextFile(join(project, "App.svelte"), "<h1>Hello</h1>");
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--config",
          join(pkg, "deno.json"),
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "--allow-env",
          ...args,
        ],
        env: { DENO_DIR: join(temporary, "cache") },
        cwd: project,
        stdout: "piped",
        stderr: "piped",
      }).output();
    const cli = join(pkg, config.exports["./cli"]);
    const decode = (value: Uint8Array) => new TextDecoder().decode(value);
    const version = await run([cli, "--version"]);
    assertEquals(version.code, 0, decode(version.stderr));
    assertEquals(decode(version.stdout).trim(), `${config.name} ${VERSION}`);
    const clean = await run([cli, "--output=json"]);
    assertEquals(clean.code, 0, decode(clean.stderr));
    assertEquals(JSON.parse(decode(clean.stdout)).success, true);

    // The worker loads the target project's Vite. A tiny fixture isolates the
    // package transport from Vite's own native modules and release schedule.
    await Deno.mkdir(join(project, "node_modules/vite"), { recursive: true });
    await Deno.writeTextFile(
      join(project, "node_modules/vite/package.json"),
      JSON.stringify({
        name: "vite",
        version: "8.3.0",
        type: "module",
        exports: { ".": "./index.js" },
      }),
    );
    await Deno.writeTextFile(
      join(project, "node_modules/vite/index.js"),
      `export function resolveConfig() {
        return {plugins:[{name:'vite-plugin-sveltekit-setup',api:{options:{}}}]};
      }`,
    );
    await Deno.writeTextFile(
      join(project, "vite.config.ts"),
      "export default {};",
    );
    await Deno.writeTextFile(
      join(project, "App.svelte"),
      '<script lang="ts">let count: number = "wrong";</script><p>{count}</p>',
    );
    const bad = await run([cli, "--output=json"]);
    assertEquals(bad.code, 1, decode(bad.stderr));
    const result = JSON.parse(decode(bad.stdout));
    assertEquals(result.errorCount, 1, JSON.stringify(result));
    assertEquals(result.diagnostics[0].code, 2322);

    const script = join(project, "consumer.ts");
    await Deno.writeTextFile(
      script,
      `import { check, transform } from ${
        JSON.stringify(toFileUrl(join(pkg, config.exports["."])).href)
      };
      const result = await check({files:['App.svelte']});
      if (result.success || result.diagnostics[0]?.code !== 2322) {
        throw new Error(JSON.stringify(result));
      }
      console.log(transform('<h1>Hello</h1>').code);`,
    );
    const api = await run([script]);
    assertEquals(api.code, 0, decode(api.stderr));
    assertStringIncludes(decode(api.stdout), "__sv");
    const invalid = await run([cli, "--not-an-option"]);
    assertEquals(invalid.code, 2);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
