// Read-only subset of vscode-languageserver-textdocument 1.0.12, lib/esm/main.js.
// Copyright (c) Microsoft Corporation. All rights reserved.
// MIT license: ./licenses/vscode-languageserver-textdocument.txt.
// Removed document updates, edit application, sorting and event helpers.
import type { Position, Range } from "../transform/writer.ts";

export interface TextDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly lineCount: number;
  getText(range?: Range): string;
  positionAt(offset: number): Position;
  offsetAt(position: Position): number;
}

/** Immutable text with the upstream UTF-16 and CR/LF position semantics. */
export function createTextDocument(
  uri: string,
  languageId: string,
  version: number,
  content: string,
): TextDocument {
  let lineOffsets: number[] | undefined;
  const isEOL = (character: number) => character === 13 || character === 10;
  const offsets = (): number[] => {
    if (lineOffsets) return lineOffsets;
    lineOffsets = [0];
    for (let i = 0; i < content.length; i++) {
      const character = content.charCodeAt(i);
      if (isEOL(character)) {
        if (character === 13 && content.charCodeAt(i + 1) === 10) i++;
        lineOffsets.push(i + 1);
      }
    }
    return lineOffsets;
  };
  const beforeEOL = (offset: number, lineOffset: number): number => {
    while (offset > lineOffset && isEOL(content.charCodeAt(offset - 1))) {
      offset--;
    }
    return offset;
  };
  const offsetAt = (position: Position): number => {
    const lines = offsets();
    if (position.line >= lines.length) return content.length;
    if (position.line < 0) return 0;
    const lineOffset = lines[position.line];
    if (position.character <= 0) return lineOffset;
    const next = position.line + 1 < lines.length
      ? lines[position.line + 1]
      : content.length;
    return beforeEOL(
      Math.min(lineOffset + position.character, next),
      lineOffset,
    );
  };
  return {
    uri,
    languageId,
    version,
    get lineCount() {
      return offsets().length;
    },
    getText(range) {
      return range
        ? content.substring(offsetAt(range.start), offsetAt(range.end))
        : content;
    },
    positionAt(offset) {
      offset = Math.max(Math.min(offset, content.length), 0);
      const lines = offsets();
      let low = 0;
      let high = lines.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (lines[middle] > offset) high = middle;
        else low = middle + 1;
      }
      const line = low - 1;
      return {
        line,
        character: beforeEOL(offset, lines[line]) - lines[line],
      };
    },
    offsetAt,
  };
}
