import { relative, resolve } from "@std/path";
import { check } from "./src/checker.ts";
import { VERSION } from "./src/version.ts";
import type {
  CheckOptions,
  CheckResult,
  DiagnosticSource,
} from "./src/types.ts";

const HELP =
  `@bonakodo/svelte-check — Svelte diagnostics using Deno's bundled checker

Usage: deno task svelte-check [options] [files or globs...]

  --workspace <path>             Project directory (default: current directory)
  --config <path>                Deno or TypeScript project configuration
  --tsconfig <path>              Alias for --config
  --vite-config <path>           SvelteKit 3 Vite configuration
  --ignore <patterns>            Comma-separated paths or globs to ignore
  --diagnostic-sources <list>    js,svelte,css (default: all)
  --compiler-warnings <rules>    code:ignore or code:error, comma-separated
  --output <human|json>          Output format (default: human)
  --fail-on-warnings             Exit 1 for warnings as well as errors
  --watch                       Check again when project source changes
  --help                        Print this help
  --version                     Print the version

No separate TypeScript compiler package is used. Requires Deno 2.9.6+.
`;

export interface CliOptions {
  check: CheckOptions;
  output: "human" | "json";
  watch: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    check: {},
    output: "human",
    watch: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equal = arg.indexOf("=");
    const flag = equal > 0 ? arg.slice(0, equal) : arg;
    const value = () => {
      const value = equal > 0 ? arg.slice(equal + 1) : args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    };
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
        options.version = true;
        break;
      case "--watch":
        options.watch = true;
        break;
      case "--fail-on-warnings":
        options.check.failOnWarnings = true;
        break;
      case "--workspace":
        options.check.workspace = value();
        break;
      case "--config":
      case "--tsconfig":
        options.check.config = value();
        break;
      case "--vite-config":
        options.check.viteConfig = value();
        break;
      case "--ignore":
        options.check.ignore = value().split(",").filter(Boolean);
        break;
      case "--output": {
        const output = value();
        if (output !== "human" && output !== "json") {
          throw new Error(`Unknown output format: ${output}`);
        }
        options.output = output;
        break;
      }
      case "--diagnostic-sources": {
        const sources = value().split(",");
        if (!sources.every((s) => ["js", "svelte", "css"].includes(s))) {
          throw new Error("Diagnostic sources must be js,svelte,css");
        }
        options.check.diagnosticSources = sources as DiagnosticSource[];
        break;
      }
      case "--compiler-warnings": {
        options.check.compilerWarnings = {};
        for (const rule of value().split(",")) {
          const [code, level, extra] = rule.split(":");
          if (!code || extra || (level !== "error" && level !== "ignore")) {
            throw new Error(`Invalid compiler warning rule: ${rule}`);
          }
          options.check.compilerWarnings[code] = level;
        }
        break;
      }
      case "--":
        (options.check.files ??= []).push(...args.slice(i + 1));
        i = args.length;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        (options.check.files ??= []).push(arg);
    }
  }
  return options;
}

export function formatResult(
  result: CheckResult,
  root: string,
  output: "human" | "json",
): string {
  if (output === "json") return JSON.stringify(result, null, 2);
  return [
    ...result.diagnostics.map((d) =>
      `${relative(root, d.file)}:${d.range.start.line + 1}:${
        d.range.start.character + 1
      } ${d.severity} [${d.source}/${d.code}] ${d.message}`
    ),
    `Checked ${result.fileCount} files: ${result.errorCount} errors, ${result.warningCount} warnings.`,
  ].join("\n");
}

/** A serialized rerun preserves a coherent project view across edits. */
async function watch(options: CliOptions): Promise<void> {
  const root = resolve(options.check.workspace ?? Deno.cwd());
  const watcher = Deno.watchFs(root, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let running: Promise<void> | undefined;
  const run = () => {
    pending = true;
    if (running) return;
    running = (async () => {
      while (pending) {
        pending = false;
        try {
          console.log(
            formatResult(await check(options.check), root, options.output),
          );
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    })().finally(() => {
      running = undefined;
    });
  };
  const stop = () => watcher.close();
  Deno.addSignalListener("SIGINT", stop);
  try {
    run();
    for await (const event of watcher) {
      if (
        !event.paths.some((path) =>
          !/[/\\]\.deno-svelte-check-/.test(path) &&
          !/[/\\](?:node_modules|\.git|\.svelte-kit|\.svelte-check)[/\\]/.test(
            path,
          ) && /\.(?:svelte|[cm]?[jt]s|jsonc?)$/.test(path)
        )
      ) continue;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 100);
    }
  } finally {
    if (timer) clearTimeout(timer);
    Deno.removeSignalListener("SIGINT", stop);
    await running;
    watcher.close();
  }
}

export async function main(args: string[]): Promise<number> {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log(HELP);
      return 0;
    }
    if (options.version) {
      console.log(`@bonakodo/svelte-check ${VERSION}`);
      return 0;
    }
    if (options.watch) {
      await watch(options);
      return 0;
    }
    const result = await check(options.check);
    console.log(
      formatResult(
        result,
        resolve(options.check.workspace ?? Deno.cwd()),
        options.output,
      ),
    );
    return result.success ? 0 : 1;
  } catch (error) {
    console.error(
      `deno-svelte-check: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 2;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
