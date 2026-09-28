export interface Segment {
  generatedStart: number;
  generatedEnd: number;
  originalStart: number;
  originalEnd: number;
}

/** Tracks the exact source slices retained in generated TypeScript. */
export class CodeWriter {
  readonly segments: Segment[] = [];
  #parts: string[] = [];
  #length = 0;

  constructor(readonly original: string) {}

  append(text: string, originalStart?: number): void {
    if (originalStart !== undefined && text.length) {
      this.segments.push({
        generatedStart: this.#length,
        generatedEnd: this.#length + text.length,
        originalStart,
        originalEnd: originalStart + text.length,
      });
    }
    this.#parts.push(text);
    this.#length += text.length;
  }

  source(start: number, end: number): void {
    this.append(this.original.slice(start, end), start);
  }

  get code(): string {
    return this.#parts.join("");
  }
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export function positionAt(source: string, offset: number): Position {
  offset = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, character: offset - start };
}

export function offsetAt(source: string, position: Position): number {
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const next = source.indexOf("\n", start);
    if (next < 0) return source.length;
    start = next + 1;
  }
  const end = source.indexOf("\n", start);
  return Math.min(start + position.character, end < 0 ? source.length : end);
}

/** Generated helper spans have no mapping and must not become user diagnostics. */
export function mapRange(
  generated: string,
  original: string,
  segments: readonly Segment[],
  range: Range,
): Range | undefined {
  const start = offsetAt(generated, range.start);
  const end = offsetAt(generated, range.end);
  const segment = segments.find((part) =>
    start >= part.generatedStart && start < part.generatedEnd
  );
  if (!segment) return undefined;
  const originalStart = segment.originalStart + start - segment.generatedStart;
  const originalEnd = Math.min(
    segment.originalEnd,
    segment.originalStart + Math.max(start + 1, end) - segment.generatedStart,
  );
  return {
    start: positionAt(original, originalStart),
    end: positionAt(original, originalEnd),
  };
}
