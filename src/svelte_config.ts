import type { CompileOptions, PreprocessorGroup } from "svelte/compiler";
import { dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { parse } from "@std/jsonc";

export interface SvelteConfig {
  compilerOptions?: CompileOptions;
  preprocess?: PreprocessorGroup | PreprocessorGroup[];
  routes?: string;
  configFile?: string;
}

interface Package {
  directory: string;
  manifest: {
    version?: string;
    exports?: unknown;
    module?: string;
    main?: string;
  };
}

const extensions = ["js", "mjs", "ts", "cjs", "mts", "cts"];

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function findPackage(
  root: string,
  name: string,
): Promise<Package | undefined> {
  let current = root;
  while (true) {
    const directory = join(current, "node_modules", name);
    const file = join(directory, "package.json");
    if (await isFile(file)) {
      return { directory, manifest: JSON.parse(await Deno.readTextFile(file)) };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function requireMajor(
  pkg: Package | undefined,
  name: string,
  major: number,
): void {
  if (pkg && Number(pkg.manifest.version?.split(".")[0]) !== major) {
    throw new Error(
      `This checker supports ${name} ${major}; found ${name} ${
        pkg.manifest.version ?? "with no version"
      }.`,
    );
  }
}

function requireDeclaredVersion(
  name: string,
  version: unknown,
  file: string,
): void {
  if (typeof version !== "string") return;
  // Exact versions and simple ^/~ ranges fix the major. Tags, workspace links,
  // unions and comparison ranges need the installed package to settle them.
  const match =
    /^[~^=]?\s*v?(\d+)(?:\.(?:\d+|[x*])){0,2}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/i
      .exec(version.trim());
  if (!match) return;
  const major = name === "svelte" ? 5 : 3;
  if (Number(match[1]) !== major) {
    throw new Error(
      `This checker supports ${
        name === "svelte" ? "Svelte" : "SvelteKit"
      } ${major}; ${file} selects ${name}@${version}.`,
    );
  }
}

async function checkDeclaredVersions(root: string): Promise<void> {
  const packageFile = join(root, "package.json");
  if (await isFile(packageFile)) {
    const manifest = JSON.parse(await Deno.readTextFile(packageFile));
    for (const name of ["svelte", "@sveltejs/kit"]) {
      requireDeclaredVersion(
        name,
        manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ??
          manifest.peerDependencies?.[name],
        packageFile,
      );
    }
  }
  for (const name of ["deno.json", "deno.jsonc"]) {
    const file = join(root, name);
    if (!await isFile(file)) continue;
    let map = parse(await Deno.readTextFile(file)) as Record<string, unknown>;
    let location = file;
    if (typeof map.importMap === "string") {
      const url = new URL(map.importMap, toFileUrl(file));
      const content = url.protocol === "file:"
        ? await Deno.readTextFile(fromFileUrl(url))
        : await (async () => {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new Error(
              `Cannot read import map ${url}: ${response.status}`,
            );
          }
          return await response.text();
        })();
      map = parse(content) as Record<string, unknown>;
      location = url.href;
    }
    const maps = [map.imports, ...Object.values(map.scopes ?? {})];
    for (const entries of maps) {
      for (const value of Object.values(entries ?? {})) {
        if (typeof value !== "string") continue;
        const match = /^npm:(svelte|@sveltejs\/kit)@([^/]+)(?:\/|$)/.exec(
          value,
        );
        if (match) requireDeclaredVersion(match[1], match[2], location);
      }
    }
    break;
  }
}

function importEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value.map(importEntry).find((entry) => entry !== undefined);
  }
  // Select runtime ESM conditions, never the package's TypeScript declaration.
  const entry = value as Record<string, unknown>;
  for (const key of ["deno", "import", "node", "default"]) {
    const result = importEntry(entry[key]);
    if (result) return result;
  }
}

/** Read Kit 3's public plugin options through the project's own Vite instance. */
export async function loadSvelteConfig(
  root: string,
  viteConfig?: string,
): Promise<SvelteConfig> {
  root = resolve(root);
  await checkDeclaredVersions(root);
  for (const extension of extensions) {
    const legacy = join(root, `svelte.config.${extension}`);
    if (await isFile(legacy)) {
      throw new Error(
        `${legacy} is not supported. SvelteKit 3 requires Svelte options in sveltekit(...) inside vite.config.*; move the configuration and remove this file.`,
      );
    }
  }
  let configFile = viteConfig ? resolve(root, viteConfig) : undefined;
  if (configFile && !await isFile(configFile)) {
    throw new Error(`Vite configuration not found: ${configFile}`);
  }
  if (!configFile) {
    for (const extension of extensions) {
      const candidate = join(root, `vite.config.${extension}`);
      if (await isFile(candidate)) {
        configFile = candidate;
        break;
      }
    }
  }
  const packageRoot = configFile ? dirname(configFile) : root;
  const [kit, svelte] = await Promise.all([
    findPackage(packageRoot, "@sveltejs/kit"),
    findPackage(packageRoot, "svelte"),
  ]);
  requireMajor(kit, "SvelteKit", 3);
  requireMajor(svelte, "Svelte", 5);
  if (!configFile) return {};

  const vite = await findPackage(packageRoot, "vite");
  if (!vite) {
    throw new Error(
      `Cannot load ${configFile}: install the project's Vite and SvelteKit 3 dependencies first.`,
    );
  }
  const exports = vite.manifest.exports;
  const entry = importEntry(
    exports && typeof exports === "object" && !Array.isArray(exports)
      ? (exports as Record<string, unknown>)["."] ?? exports
      : exports,
  ) ?? vite.manifest.module ?? vite.manifest.main;
  if (!entry) {
    throw new Error(
      `The project's Vite package has no runtime entry: ${vite.directory}`,
    );
  }
  try {
    // An absolute file URL from the target project's installed Vite package.
    // It does not depend on this package's import map after JSR rewrites imports.
    const module = await import(toFileUrl(resolve(vite.directory, entry)).href);
    if (typeof module.resolveConfig !== "function") {
      throw new Error("The project's Vite does not export resolveConfig");
    }
    const resolved = await module.resolveConfig({
      root,
      configFile,
      logLevel: "error",
      // Deno loads TypeScript itself, without a config bundler or native binding.
      configLoader: "native",
    }, "serve");
    const plugin = resolved.plugins?.find((plugin: { name?: string }) =>
      plugin?.name === "vite-plugin-sveltekit-setup"
    );
    const options = plugin?.api?.options;
    if (!options || typeof options !== "object") {
      throw new Error(
        "No SvelteKit 3 configuration found. Add sveltekit(...) from @sveltejs/kit/vite to the Vite plugins.",
      );
    }
    return {
      compilerOptions: options.compilerOptions,
      preprocess: options.preprocess,
      routes: options.files?.routes,
      configFile,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const context = message.includes("not a dependency and not in import map")
      ? " Run the checker with the target project's Deno config so Deno can resolve its dependencies."
      : "";
    throw new Error(`Cannot load ${configFile}: ${message}${context}`, {
      cause: error,
    });
  }
}
