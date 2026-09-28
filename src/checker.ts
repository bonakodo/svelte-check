import { compile, parse, preprocess } from "svelte/compiler";
import {
  originalPositionFor,
  type SourceMapInput,
  TraceMap,
} from "@jridgewell/trace-mapping";
import { resolve, toFileUrl } from "@std/path";
import { DenoLsp } from "./lsp.ts";
import { cssDiagnostics } from "./css.ts";
import { discover } from "./project.ts";
import { loadSvelteConfig } from "./svelte_config.ts";
import { checkInProjectRuntime } from "./project_runtime.ts";
import { buildDependencyGraph } from "./dependencies.ts";
import { prepareLspConfig } from "./config.ts";
import { type KitModule, transformKitModule } from "./kit.ts";
import {
  mapRange,
  positionAt,
  transform,
  type TransformResult,
} from "./transform/mod.ts";
import type { Range } from "./transform/writer.ts";
import type {
  CheckOptions,
  CheckResult,
  Diagnostic,
  DiagnosticSource,
} from "./types.ts";

interface Component {
  original: string;
  source: string;
  transformed?: TransformResult;
  map?: TraceMap;
}

function errorDiagnostic(
  error: unknown,
  source: string,
  file: string,
): Diagnostic {
  const value = error as {
    message?: string;
    code?: string;
    start?: number | { character?: number };
    end?: number | { character?: number };
    position?: [number, number];
  };
  const start = value.position?.[0] ??
    (typeof value.start === "number" ? value.start : value.start?.character) ??
    0;
  const end = value.position?.[1] ??
    (typeof value.end === "number" ? value.end : value.end?.character) ??
    start + 1;
  return {
    file,
    range: { start: positionAt(source, start), end: positionAt(source, end) },
    severity: "error",
    source: "svelte",
    code: value.code ?? "transform",
    message: value.message ?? String(error),
  };
}

function originalRange(component: Component, range: Range): Range | undefined {
  if (!component.map) return range;
  const start = originalPositionFor(component.map, {
    line: range.start.line + 1,
    column: range.start.character,
  });
  const end = originalPositionFor(component.map, {
    line: range.end.line + 1,
    column: range.end.character,
  });
  if (start.line === null || start.column === null) return undefined;
  return {
    start: { line: start.line - 1, character: start.column },
    end: end.line === null || end.column === null
      ? { line: start.line - 1, character: start.column + 1 }
      : { line: end.line - 1, character: end.column },
  };
}

function language(file: string): "javascript" | "typescript" {
  return /\.[cm]?js$/.test(file) ? "javascript" : "typescript";
}

/** Check a project without installing or invoking a separate TypeScript compiler. */
export async function check(options: CheckOptions = {}): Promise<CheckResult> {
  const root = await Deno.realPath(resolve(options.workspace ?? Deno.cwd()));
  return await checkInProjectRuntime(root, { ...options, workspace: root }) ??
    await checkInContext({ ...options, workspace: root });
}

/** Internal entry for the child running in the target project's Deno context. */
export async function checkInContext(
  options: CheckOptions,
): Promise<CheckResult> {
  const root = await Deno.realPath(resolve(options.workspace ?? Deno.cwd()));
  const config = await loadSvelteConfig(root, options.viteConfig);
  const files = await discover(root, options);
  const graph = await buildDependencyGraph({
    root,
    files: files.all,
    roots: files.diagnose,
    config: options.config,
    ignore: options.ignore,
  });
  files.all = files.all.filter((file) => graph.reachable.has(file));
  if (!options.files?.length) files.diagnose = graph.diagnose;
  const sources = new Set<DiagnosticSource>(
    options.diagnosticSources ?? ["js", "svelte", "css"],
  );
  const diagnostics: Diagnostic[] = [];
  const components = new Map<string, Component>();
  const ordinary = new Map<
    string,
    { source: string; transformed?: KitModule }
  >();
  const add = (diagnostic: Diagnostic, component?: Component) => {
    if (!files.diagnose.has(diagnostic.file)) return;
    if (component) {
      const range = originalRange(component, diagnostic.range);
      if (range) diagnostic.range = range;
      else {diagnostic.message +=
          " (The preprocessor did not map this location to the original component.)";}
    }
    diagnostics.push(diagnostic);
  };

  for (const file of files.all) {
    const original = await Deno.readTextFile(file);
    if (!file.endsWith(".svelte")) {
      ordinary.set(file, {
        source: original,
        transformed: sources.has("js")
          ? transformKitModule(original, file)
          : undefined,
      });
      continue;
    }
    const component: Component = { original, source: original };
    components.set(file, component);
    try {
      if (config.preprocess) {
        const processed = await preprocess(original, config.preprocess, {
          filename: file,
        });
        component.source = processed.code;
        if (processed.map) {
          component.map = new TraceMap(processed.map as SourceMapInput);
        } else if (processed.code !== original) {
          throw new Error(
            "The preprocessor changed this component without a source map; diagnostics cannot be mapped reliably.",
          );
        }
      }
      if (sources.has("svelte")) {
        const result = compile(component.source, {
          ...config.compilerOptions,
          filename: file,
          generate: false,
        });
        for (const warning of result.warnings) {
          const severity = options.compilerWarnings?.[warning.code];
          if (severity === "ignore") continue;
          add({
            file,
            range: {
              start: positionAt(
                component.source,
                warning.start?.character ?? 0,
              ),
              end: positionAt(component.source, warning.end?.character ?? 1),
            },
            severity: severity === "error" ? "error" : "warning",
            source: "svelte",
            code: warning.code,
            message: warning.message,
          }, component);
        }
      }
      if (sources.has("js")) {
        const kind = /[/\\]\+(page|layout|error)(?:@[^/\\.]+)?\.svelte$/.exec(
          file,
        )?.[1] as
          | "page"
          | "layout"
          | "error"
          | undefined;
        component.transformed = transform(component.source, file, {
          kit: kind,
        });
      }
      if (sources.has("css")) {
        const ast = component.transformed?.ast ??
          parse(component.source, { modern: true, filename: file });
        for (const diagnostic of cssDiagnostics(component.source, ast, file)) {
          add(diagnostic, component);
        }
      }
    } catch (error) {
      add(errorDiagnostic(error, component.source, file), component);
    }
  }

  let lsp: DenoLsp | undefined;
  let lspConfig: Awaited<ReturnType<typeof prepareLspConfig>> | undefined;
  try {
    if (sources.has("js") && files.diagnose.size > 0) {
      lspConfig = await prepareLspConfig(
        root,
        options.config,
        options.timeoutMs,
      );
      lsp = await DenoLsp.start(lspConfig.options);
      for (const [file, component] of components) {
        // Keep an invalid dependency unknown, so selected importers cannot
        // silently pass through an excluded component that failed to transform.
        await lsp.open(
          toFileUrl(file).href,
          component.transformed?.code ??
            "declare const component: unknown; export default component;",
          "typescript",
        );
      }
      for (const [file, module] of ordinary) {
        await lsp.open(
          toFileUrl(file).href,
          module.transformed?.code ?? module.source,
          module.transformed?.languageId ?? language(file),
        );
      }
      for (const file of files.diagnose) {
        const component = components.get(file);
        const module = ordinary.get(file);
        if (component && !component.transformed) continue;
        const uri = toFileUrl(file).href;
        let result = await lsp.diagnostics(uri);
        // A fresh cache may have the compiler but lack packages referenced by
        // generated type-only imports. Cache the open graph and retry once;
        // unresolved dependencies must still produce diagnostics.
        if (
          result.some((diagnostic) =>
            ["no-cache", "not-installed-npm", "not-installed-jsr"].includes(
              String(diagnostic.code),
            )
          )
        ) {
          await lsp.cache(uri);
          result = await lsp.diagnostics(uri);
        }
        for (const diagnostic of result) {
          if (diagnostic.severity !== 1 && diagnostic.severity !== 2) continue;
          let range = diagnostic.range;
          let message = diagnostic.message;
          const transformed = component?.transformed ?? module?.transformed;
          if (transformed) {
            const mapped = mapRange(
              transformed.code,
              component?.source ?? module!.source,
              transformed.segments,
              range,
            );
            if (!mapped) {
              if ([6133, 6192, 6196].includes(Number(diagnostic.code))) {
                continue;
              }
              range = {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              };
              message = `Cannot check generated ${
                component ? "component" : "route"
              }: ${message}`;
            } else range = mapped;
          }
          add({
            file,
            range,
            severity: diagnostic.severity === 1 ? "error" : "warning",
            source: "js",
            code: diagnostic.code ?? "deno",
            message,
          }, component);
        }
      }
    }
  } finally {
    try {
      await lsp?.close();
    } finally {
      await lspConfig?.cleanup();
    }
  }
  const unique = [
    ...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values(),
  ];
  unique.sort((a, b) =>
    a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character ||
    String(a.code).localeCompare(String(b.code))
  );
  const errorCount = unique.filter((d) => d.severity === "error").length;
  const warningCount = unique.length - errorCount;
  return {
    diagnostics: unique,
    fileCount: files.diagnose.size,
    errorCount,
    warningCount,
    success: errorCount === 0 &&
      (!options.failOnWarnings || warningCount === 0),
  };
}
