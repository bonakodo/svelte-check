import { assertEquals } from "@std/assert";
import { parse } from "svelte/compiler";
import { cssDiagnostics } from "../src/css.ts";
import { createTextDocument } from "../src/vendor/text_document.ts";

Deno.test("vendored CSS diagnostics map style ranges to the original Svelte source", () => {
  const source =
    "<p>🙂</p>\r\n<style>\r\n.x {\r\n  colr: red;\r\n}\r\n</style>";
  const ast = parse(source, { modern: true });
  const result = cssDiagnostics(source, ast, "Test.svelte");
  const document = createTextDocument(
    "file:///Test.svelte",
    "svelte",
    1,
    source,
  );
  const start = source.indexOf("colr");
  assertEquals(result, [{
    file: "Test.svelte",
    range: {
      start: document.positionAt(start),
      end: document.positionAt(start + 4),
    },
    severity: "warning",
    source: "css",
    code: "unknownProperties",
    message: "Unknown property: 'colr'",
  }]);
});

Deno.test("components without styles produce no CSS diagnostics", () => {
  const source = "<p>Hello</p>";
  assertEquals(
    cssDiagnostics(source, parse(source, { modern: true }), "Test.svelte"),
    [],
  );
});
