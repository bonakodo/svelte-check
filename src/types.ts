import type { Range } from "./transform/writer.ts";

/** The checker that produced a diagnostic; `js` includes TypeScript. */
export type DiagnosticSource = "js" | "svelte" | "css";

/** An error or warning mapped to the original source file. */
export interface Diagnostic {
  /** Absolute source file path. */
  file: string;
  /** Zero-based UTF-16 line and column positions. */
  range: Range;
  /** Whether the diagnostic is an error or a warning. */
  severity: "error" | "warning";
  /** Diagnostic provider. */
  source: DiagnosticSource;
  /** Provider-specific diagnostic code. */
  code: string | number;
  /** Human-readable diagnostic message. */
  message: string;
}

/** Project selection and diagnostic settings for {@link check}. */
export interface CheckOptions {
  /** Project directory; defaults to the current working directory. */
  workspace?: string;
  /** File paths or globs whose diagnostics to report, relative to workspace. */
  files?: string[];
  /** Paths or globs to exclude from diagnostics. */
  ignore?: string[];
  /** Deno, TypeScript or JavaScript config path, relative to workspace. */
  config?: string;
  /** Custom SvelteKit 3 Vite config path, relative to workspace. */
  viteConfig?: string;
  /** Providers to run; defaults to all three. */
  diagnosticSources?: DiagnosticSource[];
  /** Ignore or promote Svelte compiler warnings by diagnostic code. */
  compilerWarnings?: Record<string, "ignore" | "error">;
  /** Treat warnings as check failures; defaults to false. */
  failOnWarnings?: boolean;
  /** Timeout in milliseconds for each Deno LSP request. */
  timeoutMs?: number;
}

/** Diagnostics and counts from a completed check. */
export interface CheckResult {
  /** Source-mapped diagnostics for selected files. */
  diagnostics: Diagnostic[];
  /** Number of files selected for diagnostics. */
  fileCount: number;
  /** Number of errors. */
  errorCount: number;
  /** Number of warnings. */
  warningCount: number;
  /** True when there are no errors, or warnings configured as failures. */
  success: boolean;
}
