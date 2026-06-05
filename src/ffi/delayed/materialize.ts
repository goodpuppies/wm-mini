import type { Expr, TypeExpr } from "../../ast.ts";
import type { InferResult } from "../../infer.ts";
import type { ResolveOptions } from "./types.ts";
import { rewriteExprCalls } from "../receiver/rewrite_expr.ts";
import {
  addVariants,
  type FfiBinding,
  type FfiElaboration,
  type FfiVariant,
  memberVariants,
  prependReceiver,
  refsForCallbackArg,
  selectVariant,
} from "../shared.ts";
import type { JsMemberType, JsTypeRef } from "../reflect/types.ts";

type ResolveExpr = (
  expr: Expr,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
) => Expr;

export function materializeReceiverProperty(
  receiver: Expr,
  path: string[],
  receiverType: TypeExpr,
  member: JsMemberType,
  surfaceName: string,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
): Expr {
  addVariants(
    bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    memberVariants(member).map((variant) => ({
      type: prependReceiver(variant.type, receiverType),
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs?.map((item) => ({
        argIndex: item.argIndex + 1,
        params: item.params,
      })),
    })),
    true,
  );
  const variant = selectVariant(bindings.get(surfaceName)?.variants ?? [], [receiver]);
  if (!variant) return { kind: "FfiGet", receiver, path };
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [receiver],
  };
}

export function materializeReceiverCall(
  receiver: Expr,
  path: string[],
  args: Expr[],
  receiverType: TypeExpr,
  member: JsMemberType,
  surfaceName: string,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
  resolveExpr: ResolveExpr,
): Expr {
  addVariants(
    ffi.bindings,
    surfaceName,
    path.at(-1)!,
    { kind: "JsReceiver", path },
    memberVariants(member).map((variant) => ({
      type: prependReceiver(variant.type, receiverType),
      resultRef: variant.resultRef,
      callbackParamRefs: variant.callbackParamRefs?.map((item) => ({
        argIndex: item.argIndex + 1,
        params: item.params,
      })),
    })),
    true,
  );
  const allArgs = [receiver, ...args];
  const variant = selectVariant(ffi.bindings.get(surfaceName)?.variants ?? [], allArgs);
  if (!variant) return { kind: "FfiCall", receiver, path, args };
  selected.add(variant.internalName);
  return {
    kind: "Call",
    callee: { kind: "Var", name: variant.internalName },
    args: [
      receiver,
      ...args.map((arg, index) =>
        resolveDelayedCallArg(
          arg,
          index + 1,
          variant,
          ffi,
          result,
          selected,
          options,
          valueRefs,
          resolveExpr,
        )
      ),
    ],
  };
}

function resolveDelayedCallArg(
  arg: Expr,
  argIndex: number,
  variant: FfiVariant,
  ffi: FfiElaboration,
  result: InferResult,
  selected: Set<string>,
  options: ResolveOptions,
  valueRefs: Map<string, JsTypeRef>,
  resolveExpr: ResolveExpr,
): Expr {
  const callbackRefs = variant.callbackParamRefs?.find((item) => item.argIndex === argIndex);
  const localValueRefs = refsForCallbackArg(new Map(valueRefs), arg, callbackRefs?.params);
  const rewritten = rewriteExprCalls(
    arg,
    ffi.bindings,
    selected,
    localValueRefs,
    new Map(),
    new Map(),
    ffi.foreignTypeRefs,
  );
  return resolveExpr(rewritten, ffi, result, selected, options, localValueRefs);
}
