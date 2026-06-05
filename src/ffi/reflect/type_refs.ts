import type { TypeExpr } from "../../ast.ts";

export type JsMemberType = {
  name: string;
  type: TypeExpr;
  overloads?: TypeExpr[];
  variants?: JsCallableVariant[];
};

export type JsCallableVariant = {
  type: TypeExpr;
  resultRef?: JsTypeRef;
  callbackParamRefs?: JsCallbackParamRefs[];
};

export type JsTypeRef = {
  key: string;
  source: string;
  expr: string;
  type?: TypeExpr;
};

export type JsCallbackParamRefs = {
  argIndex: number;
  params: JsTypeRef[];
};

export type JsCallArgHint =
  | { kind: "string"; value: string }
  | { kind: "function"; arity: number }
  | { kind: "unknown" };
