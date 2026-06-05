import type { Decl, Expr } from "../../ast.ts";
import type { JsTypeRef } from "../reflect/types.ts";
import { type ObjectAccess, rememberLetObjectAccess } from "./receiver.ts";
import { type FfiBinding, isDecl } from "../shared.ts";

type RewriteDecl = (
  decl: Decl,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  rewriteExpr: RewriteExpr,
) => Decl;

type RewriteExpr = (
  expr: Expr,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
) => Expr;

export function rewriteBlock(
  expr: Extract<Expr, { kind: "Block" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  rewriteDecl: RewriteDecl,
  rewriteExpr: RewriteExpr,
): Expr {
  const localRefs = new Map(refs);
  const localObjectAccess = new Map(objectAccess);
  const items = expr.items.map((item) => {
    const rewritten = isDecl(item)
      ? rewriteDecl(
        item,
        bindings,
        selected,
        localRefs,
        localObjectAccess,
        importedTypeRefs,
        rewriteExpr,
      )
      : rewriteExpr(
        item,
        bindings,
        selected,
        localRefs,
        localObjectAccess,
        importedTypeRefs,
      );
    if (isDecl(rewritten)) {
      rememberLetObjectAccess(rewritten, bindings, localObjectAccess, importedTypeRefs);
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
      localObjectAccess,
      importedTypeRefs,
    ),
  };
}

export function rewriteMatchArms(
  expr: Extract<Expr, { kind: "Match" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  rewriteExpr: RewriteExpr,
): Extract<Expr, { kind: "Match" }>["arms"] {
  return expr.arms.map((arm) => {
    const localRefs = new Map(refs);
    const localObjectAccess = new Map(objectAccess);
    return {
      ...arm,
      body: rewriteExpr(
        arm.body,
        bindings,
        selected,
        localRefs,
        localObjectAccess,
        importedTypeRefs,
      ),
    };
  });
}
