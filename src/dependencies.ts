import { parse as parseSvelte } from "svelte/compiler";
import { parse as parseJson } from "@std/jsonc";
import { configFile, resolveConfigParent } from "./config_files.ts";
import {
  basename,
  dirname,
  fromFileUrl,
  globToRegExp,
  isAbsolute,
  join,
  relative,
  resolve,
  toFileUrl,
} from "@std/path";

interface Token {
  kind: "word" | "string" | "punctuation";
  value: string;
}

/** A fallback for incomplete JS/TS source; literals and comments are not code. */
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  let previous = "";
  const push = (kind: Token["kind"], value: string) => {
    result.push({ kind, value });
    previous = kind === "string" ? "literal" : value;
  };
  const expressionPrefix = /^(?:[=([{,:;!?]|=>|return|throw|case|yield|await)$/;
  const followsTypeAssertion = (): boolean => {
    let depth = 0;
    for (let index = result.length - 1; index >= 0; index--) {
      const token = result[index];
      if (token.kind !== "punctuation") continue;
      if (token.value === ">") depth++;
      else if (token.value === "<" && --depth === 0) {
        const before = result[index - 1];
        return !before ||
          (before.kind !== "string" && expressionPrefix.test(before.value));
      }
    }
    return false;
  };
  const quoted = (quote: string): string => {
    i++;
    let value = "";
    while (i < source.length) {
      const char = source[i++];
      if (char === quote) break;
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = source[i++];
      if (escaped === "\n") continue;
      if (escaped === "\r") {
        if (source[i] === "\n") i++;
        continue;
      }
      if (escaped === "x" && /^[\da-f]{2}$/i.test(source.slice(i, i + 2))) {
        value += String.fromCharCode(parseInt(source.slice(i, i + 2), 16));
        i += 2;
      } else if (escaped === "u") {
        const match = /^(?:\{([\da-f]+)\}|([\da-f]{4}))/i.exec(source.slice(i));
        if (match) {
          value += String.fromCodePoint(parseInt(match[1] ?? match[2], 16));
          i += match[0].length;
        } else value += escaped;
      } else {value += ({
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          v: "\v",
          "0": "\0",
        } as Record<string, string>)[escaped] ?? escaped;}
    }
    return value;
  };
  const code = (untilBrace = false): void => {
    let braces = 0;
    const controlParens: boolean[] = [];
    while (i < source.length) {
      const char = source[i];
      if (/\s/.test(char)) {
        i++;
        continue;
      }
      if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i + 2);
        i = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      if (char === "'" || char === '"') {
        push("string", quoted(char));
        continue;
      }
      if (char === "`") {
        const start = i;
        let substitutions = false;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "`") {
            i++;
            break;
          }
          if (source.startsWith("${", i)) {
            substitutions = true;
            i += 2;
            const save = previous;
            previous = "{";
            code(true);
            previous = save;
          } else i++;
        }
        if (substitutions) push("punctuation", "literal");
        else {
          const end = i;
          i = start;
          push("string", quoted("`"));
          i = end;
        }
        continue;
      }
      if (
        char === "/" &&
        (!previous || expressionPrefix.test(previous) ||
          (previous === ">" && followsTypeAssertion()))
      ) {
        i++;
        let characterClass = false;
        while (i < source.length) {
          const part = source[i++];
          if (part === "\\") i++;
          else if (part === "[") characterClass = true;
          else if (part === "]") characterClass = false;
          else if (part === "/" && !characterClass) break;
          else if (part === "\n") break;
        }
        while (/[a-z]/i.test(source[i] ?? "")) i++;
        push("punctuation", "literal");
        continue;
      }
      if (char === "}" && untilBrace && braces === 0) {
        i++;
        return;
      }
      if (char === "(") {
        controlParens.push(
          /^(?:if|for|while|switch|catch|with)$/.test(previous),
        );
      }
      const endedControl = char === ")" && controlParens.pop();
      if (char === "{") braces++;
      if (char === "}") braces--;
      if (/[\w$]/.test(char)) {
        const start = i++;
        while (/[\w$]/.test(source[i] ?? "")) i++;
        push("word", source.slice(start, i));
      } else if (source.startsWith("=>", i) || source.startsWith("?.", i)) {
        push("punctuation", source.slice(i, i + 2));
        i += 2;
      } else {
        push("punctuation", char);
        i++;
      }
      if (endedControl) previous = ";";
    }
  };
  code();
  return result;
}

function lexicalImports(source: string): Set<string> {
  const list = tokens(source);
  const output = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (
      item.kind !== "word" ||
      !["import", "export", "require"].includes(item.value) ||
      [".", "?."].includes(list[i - 1]?.value)
    ) continue;
    if (item.value === "import" && list[i + 1]?.kind === "string") {
      output.add(list[i + 1].value);
    } else if (
      ["import", "require"].includes(item.value) &&
      list[i + 1]?.value === "(" && list[i + 2]?.kind === "string" &&
      [")", ","].includes(list[i + 3]?.value)
    ) output.add(list[i + 2].value);
    else if (["import", "export"].includes(item.value)) {
      for (let j = i + 1; j < list.length && j < i + 200; j++) {
        if (
          list[j].value === ";" ||
          ["import", "export", "const", "let", "function", "class"].includes(
            list[j].value,
          )
        ) break;
        if (list[j].value === "from" && list[j + 1]?.kind === "string") {
          output.add(list[j + 1].value);
          break;
        }
      }
    }
  }
  return output;
}

function astImports(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) astImports(child, output);
    return;
  }
  const node = value as Record<string, unknown>;
  const literal = (value: unknown) => {
    if (
      value && typeof value === "object" && "value" in value &&
      typeof value.value === "string"
    ) output.add(value.value);
    else if (
      value && typeof value === "object" && "type" in value &&
      value.type === "TemplateLiteral" && "expressions" in value &&
      Array.isArray(value.expressions) && value.expressions.length === 0 &&
      "quasis" in value && Array.isArray(value.quasis)
    ) {
      const text = value.quasis[0]?.value?.cooked;
      if (typeof text === "string") output.add(text);
    }
  };
  if (
    [
      "ImportDeclaration",
      "ExportNamedDeclaration",
      "ExportAllDeclaration",
      "ImportExpression",
    ].includes(String(node.type))
  ) literal(node.source);
  if (node.type === "TSImportType") literal(node.argument);
  if (node.type === "TSExternalModuleReference") literal(node.expression);
  if (node.type === "CallExpression") {
    const callee = node.callee as { type?: string; name?: string } | undefined;
    if (
      callee?.type === "Import" ||
      (callee?.type === "Identifier" && callee.name === "require")
    ) literal((node.arguments as unknown[])?.[0]);
  }
  for (const [key, child] of Object.entries(node)) {
    if (
      !["loc", "comments", "leadingComments", "trailingComments"].includes(key)
    ) astImports(child, output);
  }
}

function imports(source: string, file: string): Set<string> {
  const output = new Set<string>();
  try {
    const ast = file.endsWith(".svelte")
      ? parseSvelte(source, { modern: true, filename: file })
      : parseSvelte(
        `<script lang="ts">${
          source.replace(/<\/script/gi, "<\\/script")
        }</script>`,
        { modern: true },
      );
    astImports(ast, output);
    for (const comment of ast.comments) {
      if (comment.type === "Line") {
        const reference = /^\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/.exec(
          comment.value,
        );
        if (reference) output.add(reference[1]);
      } else if (comment.value.startsWith("*")) {
        const doc = comment.value;
        for (
          const tag of doc.matchAll(
            /@(?:type|param|returns?|typedef|extends|implements|satisfies)\b\s*\{/g,
          )
        ) {
          let end = tag.index + tag[0].length;
          const start = end;
          let depth = 1;
          while (end < doc.length && depth) {
            if (doc[end] === "{") depth++;
            if (doc[end] === "}") depth--;
            end++;
          }
          for (const dependency of lexicalImports(doc.slice(start, end - 1))) {
            output.add(dependency);
          }
        }
        for (const tag of doc.matchAll(/@import\s+[^\n]+/g)) {
          for (const dependency of lexicalImports(tag[0].slice(1))) {
            output.add(dependency);
          }
        }
      }
    }
    return output;
  } catch {
    if (!file.endsWith(".svelte")) return lexicalImports(source);
    // Preserve graph traversal for a component whose own syntax diagnostics fail.
    const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
    for (
      const match of withoutComments.matchAll(
        /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
      )
    ) for (const specifier of lexicalImports(match[1])) output.add(specifier);
    return output;
  }
}

type Json = Record<string, unknown>;
interface Mapping {
  base: string;
  imports: Record<string, string | null>;
  scopes: Record<string, Record<string, string | null>>;
}
interface Settings {
  mappings: Mapping[];
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsBase?: string;
}

async function readSettings(
  path: string,
  consumingDirectory = dirname(path),
  ancestors = new Set<string>(),
): Promise<Settings> {
  const canonical = await Deno.realPath(path);
  if (ancestors.has(canonical)) {
    throw new Error(`Circular configuration extends: ${path}`);
  }
  const visited = new Set(ancestors).add(canonical);
  const config = parseJson(await Deno.readTextFile(path)) as Json;
  const base = dirname(path);
  const expand = (value: string) =>
    value.replaceAll("${configDir}", consumingDirectory);
  const output: Settings = { mappings: [] };
  const parents = typeof config.extends === "string"
    ? [config.extends]
    : Array.isArray(config.extends)
    ? config.extends
    : [];
  for (const parent of parents) {
    if (typeof parent !== "string") continue;
    const inherited = await readSettings(
      await resolveConfigParent(base, expand(parent)),
      consumingDirectory,
      visited,
    );
    output.mappings.push(...inherited.mappings);
    if (inherited.baseUrl !== undefined) output.baseUrl = inherited.baseUrl;
    if (inherited.paths !== undefined) {
      output.paths = inherited.paths;
      output.pathsBase = inherited.pathsBase;
    }
  }
  if (
    typeof config.importMap === "string" && !/^[a-z]+:/i.test(config.importMap)
  ) {
    const mapFile = resolve(base, config.importMap);
    const map = parseJson(await Deno.readTextFile(mapFile)) as Json;
    output.mappings.push({
      base: mapFile,
      imports: (map.imports ?? {}) as Mapping["imports"],
      scopes: (map.scopes ?? {}) as Mapping["scopes"],
    });
  }
  if (config.imports || config.scopes) {
    output.mappings.push({
      base: path,
      imports: (config.imports ?? {}) as Mapping["imports"],
      scopes: (config.scopes ?? {}) as Mapping["scopes"],
    });
  }
  const compiler = config.compilerOptions as Json | undefined;
  if (typeof compiler?.baseUrl === "string") {
    output.baseUrl = resolve(base, expand(compiler.baseUrl));
  }
  if (compiler?.paths && typeof compiler.paths === "object") {
    output.paths = compiler.paths as Settings["paths"];
    output.pathsBase = base;
  }
  return output;
}

function mappedSpecifier(
  map: Record<string, string | null>,
  specifier: string,
): string | null | undefined {
  if (Object.hasOwn(map, specifier)) return map[specifier];
  const prefix =
    Object.keys(map).filter((key) =>
      key.endsWith("/") && specifier.startsWith(key)
    ).sort((a, b) => b.length - a.length)[0];
  if (!prefix) return undefined;
  const target = map[prefix];
  return target === null ? null : target + specifier.slice(prefix.length);
}

/** Package conditions follow key order, including `types` when checking. */
function packageTarget(
  value: unknown,
  conditions: Set<string>,
): string | null | undefined {
  if (typeof value === "string" || value === null) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = packageTarget(item, conditions);
      if (target !== undefined && target !== null) return target;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [condition, item] of Object.entries(value)) {
      if (!conditions.has(condition)) continue;
      const target = packageTarget(item, conditions);
      if (target !== undefined) return target;
    }
  }
}

function packageImport(
  imports: Json,
  specifier: string,
  conditions: Set<string>,
): string | null | undefined {
  if (Object.hasOwn(imports, specifier) && !specifier.includes("*")) {
    return packageTarget(imports[specifier], conditions) ?? null;
  }
  const patterns = Object.keys(imports).filter((key) =>
    key.split("*").length === 2
  )
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");
    if (
      !specifier.startsWith(prefix) || !specifier.endsWith(suffix) ||
      specifier.length < pattern.length
    ) continue;
    const target = packageTarget(imports[pattern], conditions);
    const wildcard = specifier.slice(
      prefix.length,
      -suffix.length || undefined,
    );
    return typeof target === "string"
      ? target.replaceAll("*", wildcard)
      : target ?? null;
  }
}

export interface DependencyOptions {
  root: string;
  files: string[];
  roots: Set<string>;
  config?: string;
  /** Explicit ignores filter diagnostics, while graph traversal continues. */
  ignore?: string[];
}

export interface DependencyGraph {
  /** Buffers needed for checking, including explicitly ignored dependencies. */
  reachable: Set<string>;
  /** Reachable files after the explicit ignore rules. */
  diagnose: Set<string>;
}

/** Visit only reachable local sources from the provided file inventory. */
export async function buildDependencyGraph(
  options: DependencyOptions,
): Promise<DependencyGraph> {
  const root = resolve(options.root);
  const known = new Set(
    options.files.filter((file) => /\.(?:svelte|[cm]?[jt]s)$/.test(file))
      .map((file) => resolve(root, file)),
  );
  const settings: Settings = { mappings: [] };
  const configs = new Set<string>();
  for (const name of ["deno.json", "deno.jsonc"]) {
    const found = await configFile(join(root, name));
    if (found) {
      configs.add(found);
      break;
    }
  }
  if (options.config) configs.add(resolve(root, options.config));
  else {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const found = await configFile(join(root, name));
      if (found) {
        configs.add(found);
        break;
      }
    }
  }
  for (const config of configs) {
    const read = await readSettings(config);
    settings.mappings.push(...read.mappings);
    if (read.baseUrl !== undefined) settings.baseUrl = read.baseUrl;
    if (read.paths !== undefined) {
      settings.paths = read.paths;
      settings.pathsBase = read.pathsBase;
    }
  }
  const sourceAt = (path: string): string | undefined => {
    const candidates: string[] = [];
    const extension = /\.(js|mjs|cjs)$/.exec(path)?.[1];
    if (extension) {
      const base = path.slice(0, -extension.length);
      for (
        const suffix of extension === "mjs"
          ? ["mts", "mjs"]
          : extension === "cjs"
          ? ["cts", "cjs"]
          : ["ts", "js"]
      ) candidates.push(base + suffix);
    } else candidates.push(path);
    if (!/\.[^/]+$/.test(path)) {
      const extensions = [
        ".ts",
        ".mts",
        ".cts",
        ".js",
        ".mjs",
        ".cjs",
        ".svelte",
      ];
      for (const suffix of extensions) candidates.push(path + suffix);
      for (const suffix of extensions) {
        candidates.push(join(path, "index" + suffix));
      }
    }
    return candidates.find((candidate) => known.has(candidate));
  };
  const fileTarget = (specifier: string, base: string): string | undefined => {
    try {
      const url = new URL(specifier, toFileUrl(base));
      return url.protocol === "file:" ? sourceAt(fromFileUrl(url)) : undefined;
    } catch {
      return undefined;
    }
  };
  type Package = { path: string; imports?: Json };
  const packages = new Map<string, Promise<Package | undefined>>();
  const nearestPackage = (directory: string): Promise<Package | undefined> => {
    let result = packages.get(directory);
    if (!result) {
      result = (async () => {
        const path = join(directory, "package.json");
        try {
          const value = JSON.parse(await Deno.readTextFile(path));
          return { path, imports: value.imports };
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        const parent = dirname(directory);
        return parent !== directory && basename(directory) !== "node_modules"
          ? await nearestPackage(parent)
          : undefined;
      })();
      packages.set(directory, result);
    }
    return result;
  };
  const dependency = async (
    specifier: string,
    importer: string,
  ): Promise<string | undefined> => {
    for (const mapping of settings.mappings.toReversed()) {
      const importerUrl = toFileUrl(importer).href;
      const normalizeKey = (value: string, base: string) =>
        /^(?:\.?\.?\/|[a-z][a-z\d+.-]*:)/i.test(value)
          ? new URL(value, toFileUrl(base)).href
          : value;
      const mappedFrom = (map: Mapping["imports"]) =>
        mappedSpecifier(
          Object.fromEntries(
            Object.entries(map).map((
              [key, target],
            ) => [normalizeKey(key, mapping.base), target]),
          ),
          normalizeKey(specifier, importer),
        );
      const scopes = Object.keys(mapping.scopes).filter((scope) =>
        importerUrl.startsWith(new URL(scope, toFileUrl(mapping.base)).href)
      ).sort((a, b) => b.length - a.length);
      for (const scope of scopes) {
        const mapped = mappedFrom(mapping.scopes[scope]);
        if (mapped !== undefined) {
          return mapped === null ? undefined : fileTarget(mapped, mapping.base);
        }
      }
      const mapped = mappedFrom(mapping.imports);
      if (mapped !== undefined) {
        return mapped === null ? undefined : fileTarget(mapped, mapping.base);
      }
    }
    if (
      specifier.startsWith(".") || specifier.startsWith("/") ||
      specifier.startsWith("file:")
    ) return fileTarget(specifier, importer);
    if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) return undefined;
    if (specifier.startsWith("#")) {
      const scope = await nearestPackage(dirname(importer));
      if (scope?.imports && typeof scope.imports === "object") {
        const conditions = new Set(
          /\.c[jt]s$/.test(importer)
            ? ["types", "require", "node", "module-sync", "default"]
            : ["types", "deno", "node", "import", "module-sync", "default"],
        );
        const target = packageImport(scope.imports, specifier, conditions);
        if (target !== undefined) {
          // External packages remain Deno's job. Never inspect their sources.
          return target?.startsWith("./")
            ? fileTarget(target, scope.path)
            : undefined;
        }
      }
    }
    for (
      const pattern of Object.keys(settings.paths ?? {}).sort((a, b) =>
        b.split("*")[0].length - a.split("*")[0].length || b.length - a.length
      )
    ) {
      const [prefix, suffix = ""] = pattern.split("*");
      if (
        pattern.includes("*")
          ? !(specifier.startsWith(prefix) && specifier.endsWith(suffix))
          : specifier !== pattern
      ) continue;
      const wildcard = specifier.slice(
        prefix.length,
        suffix ? -suffix.length : undefined,
      );
      for (const target of settings.paths![pattern]) {
        const expanded = target.replaceAll(
          "${configDir}",
          dirname([...configs].at(-1) ?? join(root, "tsconfig.json")),
        ).replace("*", wildcard);
        const found = sourceAt(
          resolve(settings.baseUrl ?? settings.pathsBase ?? root, expanded),
        );
        if (found) return found;
      }
    }
    return settings.baseUrl
      ? sourceAt(resolve(settings.baseUrl, specifier))
      : undefined;
  };
  const seen = new Set<string>();
  const pending = [...options.roots].map((file) => resolve(root, file));
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file) || !known.has(file)) continue;
    seen.add(file);
    for (const specifier of imports(await Deno.readTextFile(file), file)) {
      const target = await dependency(specifier, file);
      if (target && !seen.has(target)) pending.push(target);
    }
  }
  const ignored = (options.ignore ?? []).map((pattern) => {
    const negative = pattern.startsWith("!");
    const raw = negative ? pattern.slice(1) : pattern;
    const value = (isAbsolute(raw) ? relative(root, raw) : raw).replaceAll(
      "\\",
      "/",
    ).replace(/^\.\//, "").replace(/\/$/, "");
    return {
      negative,
      value,
      regex: globToRegExp(value, { globstar: true, extended: true }),
      directory: !/[?*{[]/.test(value),
    };
  });
  const diagnose = new Set([...seen].filter((file) => {
    const value = relative(root, file).replaceAll("\\", "/");
    let excluded = false;
    for (const rule of ignored) {
      if (
        rule.regex.test(value) ||
        (rule.directory &&
          (value.startsWith(rule.value + "/") || rule.value === "." ||
            rule.value === ""))
      ) excluded = !rule.negative;
    }
    return !excluded;
  }));
  return { reachable: seen, diagnose };
}

/** Expand configured diagnostic roots through local imports, never scanning packages. */
export async function expandDependencies(
  options: DependencyOptions,
): Promise<Set<string>> {
  return (await buildDependencyGraph(options)).diagnose;
}
