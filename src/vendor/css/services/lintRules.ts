/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ../LICENSE.md for license information.
 *--------------------------------------------------------------------------------------------*/
import { Level } from "../parser/cssNodes.ts";
export class Rule {
  constructor(
    readonly id: string,
    readonly message: string,
    readonly defaultValue: Level,
  ) {}
}
export const Rules = {
  IncludeStandardPropertyWhenUsingVendorPrefix: new Rule(
    "vendorPrefix",
    "When using a vendor-specific prefix also include the standard property",
    Level.Warning,
  ),
  EmptyRuleSet: new Rule(
    "emptyRules",
    "Do not use empty rulesets",
    Level.Warning,
  ),
  RequiredPropertiesForFontFace: new Rule(
    "fontFaceProperties",
    "@font-face rule must define 'src' and 'font-family' properties",
    Level.Warning,
  ),
  HexColorLength: new Rule(
    "hexColorLength",
    "Hex colors must consist of three, four, six or eight hex numbers",
    Level.Error,
  ),
  ArgsInColorFunction: new Rule(
    "argumentsInColorFunction",
    "Invalid number of parameters",
    Level.Error,
  ),
  UnknownProperty: new Rule(
    "unknownProperties",
    "Unknown property.",
    Level.Warning,
  ),
  UnknownAtRules: new Rule(
    "unknownAtRules",
    "Unknown at-rule.",
    Level.Warning,
  ),
  PropertyIgnoredDueToDisplay: new Rule(
    "propertyIgnoredDueToDisplay",
    "Property is ignored due to the display.",
    Level.Warning,
  ),
};
