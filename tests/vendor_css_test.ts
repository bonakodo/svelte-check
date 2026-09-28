import { assertEquals } from "@std/assert";
import { validateCss } from "../src/vendor/css/mod.ts";
import { createTextDocument } from "../src/vendor/text_document.ts";
import cases from "./fixtures/vendor-css/default-diagnostics.json" with {
  type: "json",
};

// Exact outputs captured from vscode-css-languageservice 6.3.10. The tests use
// only local code; installing the original language service is not necessary.
for (const fixture of cases) {
  Deno.test(`vendored CSS: ${fixture.name}`, () => {
    const document = createTextDocument(
      "file:///component.css",
      "css",
      1,
      fixture.source,
    );
    assertEquals(validateCss(document), fixture.diagnostics);
  });
}

Deno.test("CSS property names cannot collide with object prototype keys", () => {
  const document = createTextDocument(
    "file:///component.css",
    "css",
    1,
    ".x { constructor:1; }",
  );
  assertEquals(validateCss(document), [{
    code: "unknownProperties",
    source: "css",
    message: "Unknown property: 'constructor'",
    severity: 2,
    range: {
      start: { line: 0, character: 5 },
      end: { line: 0, character: 16 },
    },
  }]);
  // Error recovery must still report syntax errors before property warnings.
  assertEquals(
    validateCss(createTextDocument(
      document.uri,
      "css",
      1,
      ".x { constructor:1;😀",
    )),
    [{
      code: "css-colonexpected",
      source: "css",
      message: "colon expected",
      severity: 1,
      range: {
        start: { line: 0, character: 21 },
        end: { line: 0, character: 21 },
      },
    }, ...validateCss(document)],
  );
});

Deno.test("keyframe names cannot collide with object prototype keys", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    const prefixed = `@-webkit-keyframes ${name} { from { opacity: 0; } }`;
    const document = createTextDocument(
      "file:///component.css",
      "css",
      1,
      prefixed,
    );
    assertEquals(validateCss(document), [{
      code: "vendorPrefix",
      source: "css",
      message:
        "Always define standard rule '@keyframes' when defining keyframes.",
      severity: 2,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 18 },
      },
    }]);
    assertEquals(
      validateCss(createTextDocument(
        document.uri,
        "css",
        1,
        `${prefixed} @keyframes ${name} { from { opacity: 0; } }`,
      )),
      [],
    );
  }
});
