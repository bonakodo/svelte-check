import { assertEquals } from "@std/assert";
import {
  CodeWriter,
  mapRange,
  offsetAt,
  positionAt,
} from "../src/transform/writer.ts";

Deno.test("diagnostic positions use UTF-16 columns and support CRLF", () => {
  const source = "🎉\r\nlet value = 1;\n";
  assertEquals(positionAt(source, 4), { line: 1, character: 0 });
  assertEquals(positionAt(source, 2), { line: 0, character: 2 });
  assertEquals(offsetAt(source, { line: 1, character: 4 }), 8);
});

Deno.test("moved source spans map independently of generated code", () => {
  const source = "one\ntwo\nthree";
  const writer = new CodeWriter(source);
  writer.append("// helper\n");
  writer.source(8, 13);
  writer.append("\n");
  writer.source(0, 3);
  assertEquals(
    mapRange(writer.code, source, writer.segments, {
      start: { line: 1, character: 1 },
      end: { line: 1, character: 4 },
    }),
    { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
  );
  assertEquals(
    mapRange(writer.code, source, writer.segments, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 2 },
    }),
    undefined,
  );
});
