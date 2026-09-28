import { validateCss } from "./vendor/css/mod.ts";
import { createTextDocument } from "./vendor/text_document.ts";
import type { AST } from "svelte/compiler";
import type { Diagnostic } from "./types.ts";
import { positionAt } from "./transform/writer.ts";

export function cssDiagnostics(
  source: string,
  ast: AST.Root,
  file: string,
): Diagnostic[] {
  if (!ast.css) return [];
  const style = ast.css.content;
  const document = createTextDocument(
    "file:///component.css",
    "css",
    1,
    style.styles,
  );
  return validateCss(document).filter((d) =>
    d.severity === 1 || d.severity === 2
  ).map((d) => ({
    file,
    range: {
      start: positionAt(
        source,
        style.start + document.offsetAt(d.range.start),
      ),
      end: positionAt(
        source,
        style.start + document.offsetAt(d.range.end),
      ),
    },
    severity: d.severity === 1 ? "error" : "warning",
    source: "css",
    code: d.code ?? "css",
    message: d.message,
  }));
}
