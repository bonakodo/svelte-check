/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See ../LICENSE.md for license information.
 *--------------------------------------------------------------------------------------------*/
export class CSSIssueType {
  constructor(readonly id: string, readonly message: string) {}
}
export const ParseError = {
  NumberExpected: new CSSIssueType(
    "css-numberexpected",
    "number expected",
  ),
  ConditionExpected: new CSSIssueType(
    "css-conditionexpected",
    "condition expected",
  ),
  RuleOrSelectorExpected: new CSSIssueType(
    "css-ruleorselectorexpected",
    "at-rule or selector expected",
  ),
  ColonExpected: new CSSIssueType(
    "css-colonexpected",
    "colon expected",
  ),
  SemiColonExpected: new CSSIssueType(
    "css-semicolonexpected",
    "semi-colon expected",
  ),
  TermExpected: new CSSIssueType("css-termexpected", "term expected"),
  ExpressionExpected: new CSSIssueType(
    "css-expressionexpected",
    "expression expected",
  ),
  OperatorExpected: new CSSIssueType(
    "css-operatorexpected",
    "operator expected",
  ),
  IdentifierExpected: new CSSIssueType(
    "css-identifierexpected",
    "identifier expected",
  ),
  PercentageExpected: new CSSIssueType(
    "css-percentageexpected",
    "percentage expected",
  ),
  URIOrStringExpected: new CSSIssueType(
    "css-uriorstringexpected",
    "uri or string expected",
  ),
  URIExpected: new CSSIssueType("css-uriexpected", "URI expected"),
  PropertyValueExpected: new CSSIssueType(
    "css-propertyvalueexpected",
    "property value expected",
  ),
  LeftCurlyExpected: new CSSIssueType(
    "css-lcurlyexpected",
    "{ expected",
  ),
  RightCurlyExpected: new CSSIssueType(
    "css-rcurlyexpected",
    "} expected",
  ),
  LeftSquareBracketExpected: new CSSIssueType(
    "css-rbracketexpected",
    "[ expected",
  ),
  RightSquareBracketExpected: new CSSIssueType(
    "css-lbracketexpected",
    "] expected",
  ),
  LeftParenthesisExpected: new CSSIssueType(
    "css-lparentexpected",
    "( expected",
  ),
  RightParenthesisExpected: new CSSIssueType(
    "css-rparentexpected",
    ") expected",
  ),
  UnknownAtRule: new CSSIssueType(
    "css-unknownatrule",
    "at-rule unknown",
  ),
  UnknownKeyword: new CSSIssueType(
    "css-unknownkeyword",
    "unknown keyword",
  ),
  SelectorExpected: new CSSIssueType(
    "css-selectorexpected",
    "selector expected",
  ),
  MediaQueryExpected: new CSSIssueType(
    "css-mediaqueryexpected",
    "media query expected",
  ),
  IfConditionExpected: new CSSIssueType(
    "css-ifconditionexpected",
    "if condition expected",
  ),
};
