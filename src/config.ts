import sveltePackage from "svelte/package.json" with { type: "json" };
import { parse } from "@std/jsonc";
import { dirname, fromFileUrl, join, resolve, toFileUrl } from "@std/path";
import { exists, findConfig } from "./project.ts";
import type { DenoLspOptions } from "./lsp.ts";
import { resolveConfigParent } from "./config_files.ts";

interface PreparedConfig {
  options: DenoLspOptions;
  cleanup(): Promise<void>;
}

type ImportMap = {
  imports?: Record<string, string | null>;
  scopes?: Record<string, Record<string, string | null>>;
  [key: string]: unknown;
};

function addFallbacks(
  map: ImportMap,
  fallback: Record<string, string>,
  expandsPackages: boolean,
): ImportMap {
  const imports = { ...map.imports };
  for (const [key, value] of Object.entries(fallback)) {
    const covered = Object.keys(imports).some((existing) =>
      key === existing ||
      (existing.endsWith("/") && key.startsWith(existing)) ||
      (expandsPackages && key.startsWith(`${existing}/`) &&
        /^(npm|jsr):/.test(imports[existing] ?? ""))
    );
    if (!covered) {
      // Keep an explicitly chosen Svelte npm package/version for its subpaths.
      const svelte = imports.svelte;
      imports[key] = key.startsWith("svelte/") &&
          typeof svelte === "string" && /^(npm|jsr):/.test(svelte)
        ? `${svelte.replace(/\/$/, "")}${key.slice("svelte".length)}`
        : value;
    }
  }
  return { ...map, imports };
}

function absoluteMap(map: ImportMap, base: URL): ImportMap {
  const absolute = (value: string): string =>
    /^(\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(value)
      ? new URL(value, base).href
      : value;
  const entries = (values: Record<string, string | null>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        absolute(key),
        value === null ? null : absolute(value),
      ]),
    );
  return {
    ...map,
    ...(map.imports ? { imports: entries(map.imports) } : {}),
    ...(map.scopes
      ? {
        scopes: Object.fromEntries(
          Object.entries(map.scopes).map(([scope, values]) => [
            new URL(scope, base).href,
            entries(values),
          ]),
        ),
      }
      : {}),
  };
}

async function installedSvelteVersion(
  root: string,
): Promise<string | undefined> {
  for (let directory = root;; directory = dirname(directory)) {
    const installed = join(directory, "node_modules/svelte/package.json");
    if (await exists(installed)) {
      const manifest = JSON.parse(await Deno.readTextFile(installed));
      if (typeof manifest.version === "string") return manifest.version;
    }
    if (dirname(directory) === directory) break;
  }
}

async function svelteVersion(root: string): Promise<string> {
  const packageJson = join(root, "package.json");
  if (await exists(packageJson)) {
    const manifest = JSON.parse(await Deno.readTextFile(packageJson));
    const version = manifest.dependencies?.svelte ??
      manifest.devDependencies?.svelte ?? manifest.peerDependencies?.svelte;
    // Local/workspace packages must be installed before Deno can resolve them.
    if (typeof version === "string" && /^[~^<>=*0-9v]/.test(version)) {
      return version;
    }
  }
  return sveltePackage.version;
}

type CompilerOptions = Record<string, unknown>;

interface CompilerSettings {
  options: CompilerOptions;
  pathsBase?: string;
}

function mergeCompilerSettings(
  base: CompilerSettings,
  override: CompilerSettings,
): CompilerSettings {
  return {
    options: { ...base.options, ...override.options },
    pathsBase: Object.hasOwn(override.options, "paths")
      ? override.pathsBase
      : base.pathsBase,
  };
}

/** Deno does not follow package tsconfig extends such as $app/tsconfig. */
async function compilerSettings(
  file: string,
  consumer = dirname(file),
  ancestors = new Set<string>(),
): Promise<CompilerSettings> {
  const canonical = await Deno.realPath(file);
  if (ancestors.has(canonical)) {
    throw new Error(`Circular configuration extends: ${file}`);
  }
  const visited = new Set(ancestors).add(canonical);
  const config = parse(await Deno.readTextFile(file)) as Record<
    string,
    unknown
  >;
  const base = dirname(file);
  const expand = (value: string) => value.replaceAll("${configDir}", consumer);
  const parents = typeof config.extends === "string"
    ? [config.extends]
    : Array.isArray(config.extends)
    ? config.extends
    : [];
  let settings: CompilerSettings = { options: {} };
  for (const parent of parents) {
    settings = mergeCompilerSettings(
      settings,
      await compilerSettings(
        await resolveConfigParent(base, expand(parent)),
        consumer,
        visited,
      ),
    );
  }
  const own = { ...config.compilerOptions as CompilerOptions | undefined };
  for (const key of ["baseUrl", "rootDir", "outDir", "declarationDir"]) {
    if (typeof own[key] === "string") {
      own[key] = resolve(base, expand(own[key]));
    }
  }
  for (const key of ["rootDirs", "typeRoots"]) {
    if (Array.isArray(own[key])) {
      own[key] = own[key].map((value: string) => resolve(base, expand(value)));
    }
  }
  if (own.paths && typeof own.paths === "object") {
    own.paths = Object.fromEntries(
      Object.entries(own.paths).map(([key, values]) => [
        key,
        (values as string[]).map(expand),
      ]),
    );
  }
  if (Array.isArray(own.types)) {
    own.types = await Promise.all(own.types.map(async (value: string) => {
      value = expand(value);
      if (value.startsWith(".")) return resolve(base, value);
      // Kit's generated ambient package has no package.json or exports map.
      if (value === "$app/types") {
        for (let directory = base;; directory = dirname(directory)) {
          const entry = join(directory, "node_modules/$app/types/index.d.ts");
          if (await exists(entry)) return entry;
          if (dirname(directory) === directory) break;
        }
      }
      return value;
    }));
  }
  return mergeCompilerSettings(settings, { options: own, pathsBase: base });
}

function resolveCompilerPaths(settings: CompilerSettings): CompilerOptions {
  const { options, pathsBase } = settings;
  if (!options.paths || typeof options.paths !== "object") return options;
  // A later config can change baseUrl without redeclaring inherited paths.
  // Without baseUrl, paths keep the directory of their declaring config.
  const base = String(options.baseUrl ?? pathsBase);
  return {
    ...options,
    paths: Object.fromEntries(
      Object.entries(options.paths).map(([key, values]) => [
        key,
        (values as string[]).map((value) => resolve(base, value)),
      ]),
    ),
  };
}

/**
 * Combine Kit's compiler settings with Deno's imports. Resolve inherited paths
 * before writing a temporary sibling config; user mappings always win.
 */
export async function prepareLspConfig(
  root: string,
  specified?: string,
  timeoutMs?: number,
): Promise<PreparedConfig> {
  const denoConfig = await findConfig(root);
  let config = specified ? resolve(root, specified) : denoConfig;
  let tsconfig: string | undefined;
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    if (await exists(join(root, name))) {
      tsconfig = join(root, name);
      break;
    }
  }
  config ??= tsconfig;
  const temporary = await Deno.makeTempDir({ prefix: "deno-svelte-check-" });
  let snapshot: string | undefined;
  const cleanup = async () => {
    try {
      if (snapshot) await Deno.remove(snapshot);
    } finally {
      await Deno.remove(temporary, { recursive: true });
    }
  };
  try {
    const installedVersion = await installedSvelteVersion(root);
    const version = installedVersion ?? await svelteVersion(root);
    const imports = Object.fromEntries(
      Object.keys(sveltePackage.exports).map((key) => [
        key === "." ? "svelte" : `svelte${key.slice(1)}`,
        key === "."
          ? `npm:svelte@${version}`
          : `npm:svelte@${version}${key.slice(1)}`,
      ]),
    );
    let importMap: string | undefined;
    if (config) {
      let original = parse(await Deno.readTextFile(config)) as Record<
        string,
        unknown
      >;
      const mergeDenoMap = denoConfig && config !== denoConfig;
      if (mergeDenoMap) {
        const deno = parse(await Deno.readTextFile(denoConfig)) as ImportMap;
        if (typeof deno.importMap === "string") {
          deno.importMap = new URL(deno.importMap, toFileUrl(denoConfig)).href;
        }
        original = { ...absoluteMap(deno, toFileUrl(denoConfig)), ...original };
      }
      // A Deno app's imports and its Kit tsconfig both apply. Explicit config
      // selection chooses the compiler settings; Deno settings win otherwise.
      const mergeTsconfig = !specified && tsconfig && tsconfig !== config;
      const flatten = original.extends !== undefined || mergeTsconfig ||
        mergeDenoMap;
      if (flatten) {
        let settings = await compilerSettings(config);
        if (mergeTsconfig) {
          settings = mergeCompilerSettings(
            await compilerSettings(tsconfig!),
            settings,
          );
        }
        original = {
          ...original,
          compilerOptions: resolveCompilerPaths(settings),
        };
        delete original.extends;
      }
      // Deno 2.9 LSP resolves package.json #imports only in manual mode.
      // Kit projects already have their build packages and generated $app files.
      const installedProject = installedVersion !== undefined;
      if (installedProject) original.nodeModulesDir = "manual";
      let effective: Record<string, unknown> | undefined = flatten
        ? original
        : undefined;
      if (installedProject) effective = original;
      const inline = original.imports !== undefined ||
        original.scopes !== undefined;
      if (inline || typeof original.importMap === "string") {
        if (inline) {
          const map = addFallbacks(original as ImportMap, imports, true);
          if (
            Object.keys(map.imports!).length !==
              Object.keys((original as ImportMap).imports ?? {}).length
          ) effective = map;
        } else {
          const url = new URL(original.importMap as string, toFileUrl(config));
          const text = url.protocol === "file:"
            ? await Deno.readTextFile(fromFileUrl(url))
            : await (async () => {
              const response = await fetch(url, {
                signal: AbortSignal.timeout(timeoutMs ?? 30_000),
              });
              if (!response.ok) {
                throw new Error(
                  `Cannot read import map ${url}: ${response.status}`,
                );
              }
              return await response.text();
            })();
          const originalMap = parse(text) as ImportMap;
          const map = addFallbacks(
            absoluteMap(originalMap, url),
            imports,
            false,
          );
          if (
            Object.keys(map.imports!).length !==
              Object.keys(originalMap.imports ?? {}).length
          ) {
            const path = join(temporary, "import-map.json");
            await Deno.writeTextFile(path, JSON.stringify(map));
            effective = { ...original, importMap: path };
          }
        }
      } else {
        // Import-map files don't apply Deno's automatic npm subpath expansion.
        importMap = join(temporary, "import-map.json");
        await Deno.writeTextFile(importMap, JSON.stringify({ imports }));
      }
      if (effective) {
        snapshot = await Deno.makeTempFile({
          dir: dirname(config),
          prefix: ".deno-svelte-check-",
          suffix: ".json",
        });
        await Deno.writeTextFile(snapshot, JSON.stringify(effective));
        config = snapshot;
      }
    } else {
      config = join(temporary, "deno.json");
      await Deno.writeTextFile(
        config,
        JSON.stringify({
          nodeModulesDir: installedVersion ? "manual" : "none",
          imports,
          compilerOptions: {
            strict: true,
            lib: ["esnext", "dom", "dom.iterable"],
            allowImportingTsExtensions: true,
            checkJs: true,
          },
        }),
      );
    }
    return {
      options: {
        root,
        config,
        importMap,
        unstable: ["sloppy-imports"],
        timeoutMs,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
