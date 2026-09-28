import { type AST, parse } from "svelte/compiler";
import { emitScriptEnd, emitScriptStart } from "./script.ts";
import type { ScriptOptions } from "./script.ts";
import { emitTemplate } from "./template.ts";
import { HELPERS } from "./helpers.ts";
import { CodeWriter, type Segment } from "./writer.ts";

/** Generated checking code, its source mappings, and the parsed Svelte tree. */
export interface TransformResult {
  /** TypeScript for type checking only, not application execution. */
  code: string;
  /** Source slices retained in the generated TypeScript. */
  segments: Segment[];
  /** Svelte's modern abstract syntax tree. */
  ast: AST.Root;
}

/** Generates a type-checking module, never executable application code. */
export function transform(
  source: string,
  filename = "Component.svelte",
  options: ScriptOptions = {},
): TransformResult {
  const ast = parse(source, { modern: true, filename });
  const writer = new CodeWriter(source);
  writer.append(HELPERS + "\n");
  const script = emitScriptStart(ast, source, writer, options);
  emitTemplate(ast, source, writer);
  script.slotsExpression = "__sv_slots";
  emitScriptEnd(script, writer);
  return { code: writer.code, segments: writer.segments, ast };
}

export { CodeWriter, mapRange, offsetAt, positionAt } from "./writer.ts";
