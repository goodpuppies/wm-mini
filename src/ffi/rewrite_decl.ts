import type { Decl, Expr } from "../ast.ts";
import type { JsTypeRef } from "./js_types.ts";
import type { ObjectAccess } from "./receiver.ts";
import type { FfiBinding } from "./shared.ts";

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

export function rewriteDeclCalls(
  decl: Decl,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  passThroughRefs: Set<string>,
  rewriteExpr: RewriteExpr,
): Decl {
  if (decl.kind !== "LetDecl") return decl;
  return {
    ...decl,
    bindings: decl.bindings.map((binding) => ({
      ...binding,
      value: rewriteExpr(
        binding.value,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
        passThroughRefs,
      ),
    })),
  };
}
