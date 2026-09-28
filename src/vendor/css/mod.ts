// Default validation subset of vscode-css-languageservice 6.3.10.
// Copyright (c) Microsoft Corporation. MIT license: ./LICENSE.md.
import { Parser } from "./parser/cssParser.ts";
import { Level, ParseErrorCollector } from "./parser/cssNodes.ts";
import { type CssData, LintVisitor } from "./services/lint.ts";
import {
  atDirectiveNames,
  nonstandardProperties,
  propertyNames,
} from "./languageFacts/data.ts";
import type { TextDocument } from "../text_document.ts";
import type { Range } from "../../transform/writer.ts";

const known = new Set(propertyNames);
const nonstandard = new Set(nonstandardProperties);
const atRules = new Set(atDirectiveNames);
const data: CssData = {
  isKnownProperty: (name: string) => known.has(name.toLowerCase()),
  isStandardProperty: (name: string) =>
    known.has(name.toLowerCase()) && !nonstandard.has(name.toLowerCase()),
  getAtDirective: (name: string) => atRules.has(name),
};
const parser = new Parser();

export interface CssDiagnostic {
  code: string;
  source: string;
  message: string;
  severity: 1 | 2;
  range: Range;
}

/** Preserve upstream parse-error ordering, then the default lint visitor order. */
export function validateCss(document: TextDocument): CssDiagnostic[] {
  const stylesheet = parser.parseStylesheet(document);
  const entries = [
    ...ParseErrorCollector.entries(stylesheet),
    ...LintVisitor.entries(stylesheet, data),
  ];
  return entries.filter((entry) => entry.getLevel() !== Level.Ignore).map((
    entry,
  ) => ({
    code: entry.getRule().id,
    source: document.languageId,
    message: entry.getMessage(),
    severity: entry.getLevel() === Level.Warning ? 2 : 1,
    range: {
      start: document.positionAt(entry.getOffset()),
      end: document.positionAt(entry.getOffset() + entry.getLength()),
    },
  }));
}
