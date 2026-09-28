import { assertEquals } from "@std/assert";
import { createTextDocument } from "../src/vendor/text_document.ts";

Deno.test("vendored document retains UTF-16 positions and CR/LF boundaries", () => {
  const doc = createTextDocument("file:///test.css", "css", 1, "a\r\n😀\rb\nc");
  assertEquals(doc.lineCount, 4);
  assertEquals(Array.from({ length: 10 }, (_, i) => doc.positionAt(i)), [
    { line: 0, character: 0 },
    { line: 0, character: 1 },
    { line: 0, character: 1 },
    { line: 1, character: 0 },
    { line: 1, character: 1 },
    { line: 1, character: 2 },
    { line: 2, character: 0 },
    { line: 2, character: 1 },
    { line: 3, character: 0 },
    { line: 3, character: 1 },
  ]);
  assertEquals(
    [0, 1, 2, 3].map((line) => doc.offsetAt({ line, character: 100 })),
    [1, 5, 7, 9],
  );
  assertEquals(doc.offsetAt({ line: 1, character: 1 }), 4);
});

Deno.test("vendored document clamps outside offsets and lines", () => {
  const doc = createTextDocument("file:///test.css", "css", 2, "a\r\nb\n");
  assertEquals(doc.lineCount, 3);
  assertEquals(doc.positionAt(-1), { line: 0, character: 0 });
  assertEquals(doc.positionAt(100), { line: 2, character: 0 });
  assertEquals(doc.offsetAt({ line: -1, character: 100 }), 0);
  assertEquals(doc.offsetAt({ line: 100, character: -1 }), 5);
  assertEquals(doc.offsetAt({ line: 1, character: -1 }), 3);
  const empty = createTextDocument("file:///empty", "css", 0, "");
  assertEquals(empty.lineCount, 1);
  assertEquals(empty.positionAt(10), { line: 0, character: 0 });
  assertEquals(empty.offsetAt({ line: 0, character: 10 }), 0);
});

Deno.test("vendored document reads whole text and bounded ranges", () => {
  const doc = createTextDocument("file:///test.css", "css", 7, "alpha\r\nbeta");
  assertEquals([doc.uri, doc.languageId, doc.version], [
    "file:///test.css",
    "css",
    7,
  ]);
  assertEquals(doc.getText(), "alpha\r\nbeta");
  const range = {
    start: { line: 0, character: 3 },
    end: { line: 1, character: 2 },
  };
  assertEquals(doc.getText(range), "ha\r\nbe");
  assertEquals(doc.getText({ start: range.end, end: range.start }), "ha\r\nbe");
});
