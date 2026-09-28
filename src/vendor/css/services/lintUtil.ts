/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ../LICENSE.md for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Declaration } from "../parser/cssNodes.ts";

export class Element {
  readonly fullPropertyName: string;
  constructor(readonly node: Declaration) {
    this.fullPropertyName = node.getFullPropertyName().toLowerCase();
  }
}
