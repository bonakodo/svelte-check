import { parse } from "@std/jsonc";
import { dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import type { CheckOptions, CheckResult } from "./types.ts";

type Imports = Record<string, string | null>;
interface ImportMap {
  imports?: Imports;
  scopes?: Record<string, Imports>;
  [key: string]: unknown;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function dependencyDirectories(root: string): Promise<string[]> {
  const directories = new Set<string>();
  let current = root;
  while (true) {
    try {
      const path = await Deno.realPath(join(current, "node_modules"));
      if ((await Deno.stat(path)).isDirectory) directories.add(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return [...directories];
    current = parent;
  }
}

async function readJson(url: URL): Promise<Record<string, unknown>> {
  const source = url.protocol === "file:"
    ? await Deno.readTextFile(fromFileUrl(url))
    : await (async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Cannot read ${url}: ${response.status}`);
      }
      return await response.text();
    })();
  return parse(source) as Record<string, unknown>;
}

function normalizeMap(
  map: ImportMap,
  base: URL,
  expandPackages: boolean,
): ImportMap {
  const absolute = (value: string): string =>
    /^(\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(value)
      ? new URL(value, base).href
      : value;
  const entries = (values: Imports): Imports => {
    const result: Imports = {};
    for (const [name, value] of Object.entries(values)) {
      result[absolute(name)] = value === null ? null : absolute(value);
    }
    if (expandPackages) {
      // Deno's inline imports expand package aliases. External import-map files
      // need hierarchical npm:/ and jsr:/ URLs for equivalent subpath matching.
      for (const [name, value] of Object.entries(result)) {
        if (
          value && /^(npm|jsr):/.test(value) && !name.endsWith("/") &&
          !(`${name}/` in result)
        ) {
          result[`${name}/`] = `${
            value.replace(/^(npm|jsr):\/?/, "$1:/").replace(/\/$/, "")
          }/`;
        }
      }
    }
    return result;
  };
  return {
    ...map,
    imports: entries(map.imports ?? {}),
    scopes: Object.fromEntries(
      Object.entries(map.scopes ?? {}).map(([scope, values]) => [
        new URL(scope, base).href,
        entries(values),
      ]),
    ),
  };
}

async function runtimeMap(
  root: string,
): Promise<{ config?: string; map: ImportMap }> {
  let config: string | undefined;
  let map: ImportMap = {};
  for (const name of ["deno.json", "deno.jsonc"]) {
    const candidate = join(root, name);
    if (await fileExists(candidate)) {
      config = candidate;
      break;
    }
  }
  if (config) {
    const url = toFileUrl(config);
    const content = await readJson(url);
    if (content.imports !== undefined || content.scopes !== undefined) {
      map = normalizeMap(
        {
          imports: content.imports as Imports | undefined,
          scopes: content.scopes as Record<string, Imports> | undefined,
        },
        url,
        true,
      );
    } else if (typeof content.importMap === "string") {
      const mapUrl = new URL(content.importMap, url);
      map = normalizeMap(await readJson(mapUrl) as ImportMap, mapUrl, false);
    }
  }
  const toolConfigUrl = new URL("../deno.json", import.meta.url);
  const tool = await readJson(toolConfigUrl);
  const lock = await readJson(new URL("../deno.lock", import.meta.url));
  const versions = lock.specifiers as Record<string, string>;
  const pinned = Object.fromEntries(
    Object.entries(tool.imports as Imports).map(([name, value]) => {
      const version = value && versions[value];
      return [
        name,
        version && value && /^(jsr|npm):/.test(value)
          ? `${value.slice(0, value.lastIndexOf("@"))}@${version}`
          : value,
      ];
    }),
  );
  const own = normalizeMap({ imports: pinned }, toolConfigUrl, true).imports!;
  const scope = new URL("./", import.meta.url).href;
  map.scopes = { ...map.scopes, [scope]: { ...map.scopes?.[scope], ...own } };
  return { config, map };
}

/**
 * Vite and preprocessors must run in the target project's Deno/npm context.
 * Keep them in the child with the checker; functions never cross JSON boundaries.
 */
export async function checkInProjectRuntime(
  root: string,
  options: CheckOptions,
): Promise<CheckResult | undefined> {
  root = await Deno.realPath(resolve(root));
  let hasViteConfig = !!options.viteConfig;
  for (const extension of ["js", "mjs", "ts", "cjs", "mts", "cts"]) {
    if (await fileExists(join(root, `vite.config.${extension}`))) {
      hasViteConfig = true;
    }
  }
  if (!hasViteConfig) return undefined;
  const temporary = await Deno.makeTempDir({ prefix: "deno-svelte-runtime-" });
  try {
    const { config, map } = await runtimeMap(root);
    const mapFile = join(temporary, "import-map.json");
    const requestFile = join(temporary, "request.json");
    const resultFile = join(temporary, "result.json");
    await Deno.writeTextFile(mapFile, JSON.stringify(map));
    await Deno.writeTextFile(
      requestFile,
      JSON.stringify({ ...options, workspace: root }),
    );
    const nativeDependencies = await dependencyDirectories(root);
    const args = [
      "run",
      "--quiet",
      "--no-lock",
      ...(config ? ["--config", config] : ["--no-config"]),
      "--import-map",
      mapFile,
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-net",
      // Vite 8 imports Rolldown's native binding even with configLoader:native.
      // Limit native access to installed project/monorepo dependency directories.
      ...(nativeDependencies.length
        ? [`--allow-ffi=${nativeDependencies.join(",")}`]
        : []),
      new URL("./check_worker.ts", import.meta.url).href,
      requestFile,
      resultFile,
    ];
    const child = new Deno.Command(Deno.execPath(), {
      args,
      cwd: root,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // A complete project can contain many individually bounded LSP requests.
    const timeoutMs = Math.max(600_000, options.timeoutMs ?? 0);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, timeoutMs);
    let output: Deno.CommandOutput;
    try {
      output = await child.output();
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
      await child.status;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // User config logs must never corrupt the CLI's JSON output on stdout.
    if (output.stdout.length) await Deno.stderr.write(output.stdout);
    if (output.stderr.length) await Deno.stderr.write(output.stderr);
    if (timedOut) {
      throw new Error(`Project check timed out after ${timeoutMs}ms`);
    }
    if (!output.success) {
      throw new Error(
        `Project check failed (Deno exit ${output.code}): ${
          new TextDecoder().decode(output.stderr).trim()
        }`,
      );
    }
    const reply = JSON.parse(await Deno.readTextFile(resultFile)) as {
      result?: CheckResult;
      error?: string;
    };
    if (reply.error) throw new Error(reply.error);
    if (!reply.result) throw new Error("Project check returned no result");
    return reply.result;
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}
