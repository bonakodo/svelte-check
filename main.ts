/**
 * Svelte 5 diagnostics using Deno's bundled TypeScript checker.
 *
 * @example
 * ```ts
 * import { check } from "@bonakodo/svelte-check";
 * const result = await check({ workspace: "/path/to/project" });
 * console.log(result.errorCount, result.warningCount);
 * ```
 *
 * @module
 */
export * from "./mod.ts";
