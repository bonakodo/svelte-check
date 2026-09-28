import {
  basename,
  dirname,
  globToRegExp,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { parse } from "@std/jsonc";
import type { CheckOptions } from "./types.ts";
import { resolveConfigParent } from "./config_files.ts";

const sourceExtension = /\.(svelte|[cm]?[jt]s)$/;
const declarationExtension = /\.d\.[cm]?ts$/;
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  ".svelte-check",
  "coverage",
  "dist",
  "build",
  "bower_components",
  "jspm_packages",
]);

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Find a Deno config without treating a tsconfig as a Deno import map. */
export async function findConfig(root: string): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(root, name);
    if (await exists(path)) return path;
  }
}

type Config = Record<string, unknown>;
interface Pattern {
  base: string;
  text: string;
  negative: boolean;
  regex: RegExp;
  directory?: string;
}
interface Selection {
  include?: Pattern[];
  exclude?: Pattern[];
  files?: string[];
  outDir?: string;
}

function list(value: unknown, key: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${key} must be an array of strings in ${path}`);
  }
  return value;
}

function pattern(base: string, value: string): Pattern {
  const negative = value.startsWith("!");
  const raw = negative ? value.slice(1) : value;
  // Keep metacharacters in the workspace's own name out of the glob pattern.
  const text = (isAbsolute(raw) ? relative(base, raw) : raw)
    .replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  return {
    base,
    text,
    negative,
    regex: globToRegExp(text || ".", { globstar: true, extended: true }),
    directory: /[?*{[]/.test(text) ? undefined : text,
  };
}

function matches(rule: Pattern, file: string): boolean {
  const target = relative(rule.base, file).replaceAll("\\", "/");
  if (rule.regex.test(target)) return true;
  if (rule.directory === undefined) return false;
  if (rule.directory === "" || rule.directory === ".") {
    return !target.startsWith("../");
  }
  return target.startsWith(`${rule.directory}/`);
}

function selectedByRules(rules: Pattern[], file: string): boolean {
  let selected = false;
  for (const rule of rules) if (matches(rule, file)) selected = !rule.negative;
  return selected;
}

async function readSelection(
  path: string,
  consumingDirectory = dirname(path),
  ancestors = new Set<string>(),
): Promise<Selection> {
  const canonical = await Deno.realPath(path);
  if (ancestors.has(canonical)) {
    throw new Error(`Circular configuration extends: ${path}`);
  }
  const visited = new Set(ancestors).add(canonical);
  const value = parse(await Deno.readTextFile(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Configuration must be an object: ${path}`);
  }
  const config = value as Config;
  const base = dirname(path);
  const parents = typeof config.extends === "string"
    ? [config.extends]
    : list(config.extends, "extends", path) ?? [];
  let output: Selection = {};
  for (const parent of parents) {
    output = {
      ...output,
      ...await readSelection(
        await resolveConfigParent(base, parent),
        consumingDirectory,
        visited,
      ),
    };
  }
  const expand = (item: string) =>
    item.replaceAll("${configDir}", consumingDirectory);
  for (const key of ["include", "exclude"] as const) {
    const values = list(config[key], key, path);
    if (values !== undefined) {
      output[key] = values.map((item) => pattern(base, expand(item)));
    }
  }
  const files = list(config.files, "files", path);
  if (files !== undefined) {
    output.files = files.map((item) => resolve(base, expand(item)));
  }
  const compilerOptions = config.compilerOptions as Config | undefined;
  if (typeof compilerOptions?.outDir === "string") {
    output.outDir = resolve(base, expand(compilerOptions.outDir));
  }
  return output;
}

function includesFile(selection: Selection, file: string): boolean {
  // TypeScript files is a union with include and overrides exclude.
  if (selection.files?.includes(file)) return true;
  if (selection.exclude && selectedByRules(selection.exclude, file)) {
    return false;
  }
  if (
    !selection.exclude && selection.outDir &&
    matches(pattern(selection.outDir, "."), file)
  ) return false;
  if (selection.include !== undefined) {
    return selectedByRules(selection.include, file);
  }
  return selection.files === undefined;
}

export interface ProjectFiles {
  /** All workspace buffers, including components excluded from diagnostics. */
  all: string[];
  diagnose: Set<string>;
}

/**
 * Explicit files override config selection; ignore filters diagnostics only.
 * Never follow symlinks or scan outside root. Prune generated/package directory
 * entry names under root, without matching names in root's own ancestors.
 */
export async function discover(
  root: string,
  options: CheckOptions,
): Promise<ProjectFiles> {
  root = resolve(root);
  if (!(await Deno.stat(root)).isDirectory) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  const all: string[] = [];
  async function visit(directory: string): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isSymlink) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory) {
        if (!ignoredDirectories.has(entry.name)) await visit(path);
      } else if (
        entry.isFile && sourceExtension.test(entry.name) &&
        !declarationExtension.test(entry.name)
      ) {
        all.push(path);
      }
    }
  }
  await visit(root);
  all.sort();
  const ignore = (options.ignore ?? []).map((value) => pattern(root, value));
  let selected = all;
  if (options.files?.length) {
    const requested = options.files.map((value) => pattern(root, value));
    for (const rule of requested) {
      if (!rule.negative && !all.some((file) => matches(rule, file))) {
        throw new Error(`No source files match: ${rule.text}`);
      }
    }
    selected = all.filter((file) => selectedByRules(requested, file));
  } else {
    const configs: string[] = [];
    if (options.config) configs.push(resolve(root, options.config));
    else {
      const denoConfig = await findConfig(root);
      if (denoConfig) configs.push(denoConfig);
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const config = join(root, name);
        if (await exists(config)) {
          configs.push(config);
          break;
        }
      }
    }
    for (const config of configs) {
      const selection = await readSelection(config);
      for (const file of selection.files ?? []) {
        if (
          sourceExtension.test(file) && !declarationExtension.test(file) &&
          !all.includes(file)
        ) {
          throw new Error(
            `Configured source is missing or outside the scanned workspace: ${file} (${
              basename(config)
            })`,
          );
        }
      }
      selected = selected.filter((file) => includesFile(selection, file));
    }
  }
  return {
    all,
    diagnose: new Set(
      selected.filter((file) => !selectedByRules(ignore, file)),
    ),
  };
}
