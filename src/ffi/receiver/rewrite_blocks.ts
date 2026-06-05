import type { Decl, Expr } from "../../ast.ts";
import type { JsTypeRef } from "../reflect/types.ts";
import {
  letBindingPassesThroughOkPayload,
  type ObjectAccess,
  okPayloadBinders,
  rememberLetRefs,
  resultRefForExpr,
} from "./receiver.ts";
import { type FfiBinding, isDecl } from "../shared.ts";

type RewriteDecl = (
  decl: Decl,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  passThroughRefs: Set<string>,
  rewriteExpr: RewriteExpr,
) => Decl;

type RewriteExpr = (
  expr: Expr,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  passThroughRefs?: Set<string>,
) => Expr;

export function rewriteBlock(
  expr: Extract<Expr, { kind: "Block" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  passThroughRefs: Set<string>,
  rewriteDecl: RewriteDecl,
  rewriteExpr: RewriteExpr,
): Expr {
  const localRefs = new Map(refs);
  const localResultRefs = new Map(resultRefs);
  const localObjectAccess = new Map(objectAccess);
  const localPassThroughRefs = new Set(passThroughRefs);
  const items = expr.items.map((item) => {
    const rewritten = isDecl(item)
      ? rewriteDecl(
        item,
        bindings,
        selected,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
        localPassThroughRefs,
        rewriteExpr,
      )
      : rewriteExpr(
        item,
        bindings,
        selected,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
        localPassThroughRefs,
      );
    if (isDecl(rewritten)) {
      for (const name of letBindingPassesThroughOkPayload(rewritten)) {
        localPassThroughRefs.add(name);
      }
      rememberLetRefs(
        rewritten,
        bindings,
        localRefs,
        localResultRefs,
        localObjectAccess,
        importedTypeRefs,
        localPassThroughRefs,
      );
    }
    return rewritten;
  });
  return {
    ...expr,
    items,
    result: rewriteExpr(
      expr.result,
      bindings,
      selected,
      localRefs,
      localResultRefs,
      localObjectAccess,
      importedTypeRefs,
      localPassThroughRefs,
    ),
  };
}

export function rewriteMatchArms(
  expr: Extract<Expr, { kind: "Match" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  rewriteExpr: RewriteExpr,
): Extract<Expr, { kind: "Match" }>["arms"] {
  const matchedRef = resultRefForExpr(expr.value, bindings, resultRefs);
  return expr.arms.map((arm) => {
    const localRefs = new Map(refs);
    const localObjectAccess = new Map(objectAccess);
    if (matchedRef) {
      for (const binder of okPayloadBinders(arm.pattern)) {
        localRefs.set(binder, matchedRef);
      }
    }
    return {
      ...arm,
      body: rewriteExpr(
        arm.body,
        bindings,
        selected,
        localRefs,
        resultRefs,
        localObjectAccess,
        importedTypeRefs,
      ),
    };
  });
}
