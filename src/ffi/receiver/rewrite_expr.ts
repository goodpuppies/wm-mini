import type { Expr } from "../../ast.ts";
import { diagnosticError } from "../../diagnostics.ts";
import { jsRefCallMember, type JsTypeRef } from "../reflect/types.ts";
import {
  type ObjectAccess,
  objectReceiverCall,
  objectReceiverProperty,
  reflectedReceiverCallCandidate,
  reflectedReceiverProperty,
  rememberObjectParams,
  rememberUnannotatedParams,
} from "./receiver.ts";
import { rewriteBlock, rewriteMatchArms } from "./rewrite_blocks.ts";
import { rewriteDeclCalls } from "./rewrite_decl.ts";
import {
  type FfiBinding,
  ffiOverloadMessage,
  type FfiVariant,
  refsForCallbackArg,
  selectVariant,
} from "../shared.ts";

let activeRecordFields = new Set<string>();

export function setActiveRecordFields(fields: Set<string>): Set<string> {
  const previous = activeRecordFields;
  activeRecordFields = fields;
  return previous;
}

export function rewriteExprCalls(
  expr: Expr,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
  passThroughRefs: Set<string> = new Set(),
): Expr {
  switch (expr.kind) {
    case "FfiGet": {
      if (expr.receiver.kind === "Var") {
        const reflected = reflectedReceiverProperty(
          `${expr.receiver.name}.${expr.path.join(".")}`,
          bindings,
          selected,
          refs,
        );
        if (reflected) return reflected;
      }
      return {
        ...expr,
        receiver: rewriteExprCalls(
          expr.receiver,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    }
    case "FfiCall": {
      if (expr.receiver.kind === "Var") {
        const reflected = reflectedReceiverCallCandidate(
          `${expr.receiver.name}.${expr.path.join(".")}`,
          expr.args,
          bindings,
          selected,
          refs,
          jsRefCallMember,
        );
        if (reflected) {
          return {
            ...expr,
            kind: "Call",
            callee: reflected.callee,
            args: rewriteArgsWithVariant(
              reflected.args,
              reflected.variant,
              bindings,
              selected,
              refs,
              resultRefs,
              objectAccess,
              importedTypeRefs,
            ),
          };
        }
      }
      return {
        ...expr,
        receiver: rewriteExprCalls(
          expr.receiver,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        args: expr.args.map((arg) =>
          rewriteExprCalls(
            arg,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          )
        ),
      };
    }
    case "Var": {
      const property = reflectedReceiverProperty(expr.name, bindings, selected, refs);
      return property ??
        objectReceiverProperty(expr.name, bindings, selected, objectAccess, activeRecordFields) ??
        expr;
    }
    case "Call": {
      if (expr.callee.kind === "Var") {
        const variants = bindings.get(expr.callee.name)?.variants ?? [];
        const variant = variants.length > 1 || expr.callee.name.includes(".")
          ? selectVariant(variants, expr.args)
          : undefined;
        if (variant) {
          selected.add(variant.internalName);
          const args = rewriteArgsWithVariant(
            expr.args,
            variant,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          );
          return { ...expr, callee: { ...expr.callee, name: variant.internalName }, args };
        }
        if (variants.length > 0 && (variants.length > 1 || expr.callee.name.includes("."))) {
          throw diagnosticError(
            new Error(ffiOverloadMessage(expr.callee.name, variants, expr.args)),
            expr.node,
          );
        }
        const receiver = reflectedReceiverCallCandidate(
          expr.callee.name,
          expr.args,
          bindings,
          selected,
          refs,
          jsRefCallMember,
        );
        if (receiver) {
          return {
            ...expr,
            callee: receiver.callee,
            args: rewriteArgsWithVariant(
              receiver.args,
              receiver.variant,
              bindings,
              selected,
              refs,
              resultRefs,
              objectAccess,
              importedTypeRefs,
            ),
          };
        }
        const objectReceiver = objectReceiverCall(
          expr.callee.name,
          expr.args,
          bindings,
          selected,
          objectAccess,
          jsRefCallMember,
        );
        if (objectReceiver) {
          if ("variant" in objectReceiver) {
            return {
              ...expr,
              callee: objectReceiver.callee,
              args: rewriteArgsWithVariant(
                objectReceiver.args,
                objectReceiver.variant,
                bindings,
                selected,
                refs,
                resultRefs,
                objectAccess,
                importedTypeRefs,
              ),
            };
          }
          if (objectReceiver.kind === "FfiCall") {
            return {
              ...objectReceiver,
              args: objectReceiver.args.map((arg) =>
                rewriteExprCalls(
                  arg,
                  bindings,
                  selected,
                  refs,
                  resultRefs,
                  objectAccess,
                  importedTypeRefs,
                )
              ),
            };
          }
          return objectReceiver;
        }
      }
      const args = expr.args.map((arg) =>
        rewriteExprCalls(
          arg,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        )
      );
      const callee = rewriteExprCalls(
        expr.callee,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      );
      return { ...expr, callee, args };
    }
    case "Tuple":
      return {
        ...expr,
        items: expr.items.map((item) =>
          rewriteExprCalls(
            item,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          )
        ),
      };
    case "Record":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewriteExprCalls(
            field.value,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          ),
        })),
      };
    case "JsonObject":
      return {
        ...expr,
        fields: expr.fields.map((field) => ({
          ...field,
          value: rewriteExprCalls(
            field.value,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          ),
        })),
      };
    case "JsonArray":
      return {
        ...expr,
        items: expr.items.map((item) =>
          rewriteExprCalls(
            item,
            bindings,
            selected,
            refs,
            resultRefs,
            objectAccess,
            importedTypeRefs,
          )
        ),
      };
    case "Lambda": {
      const localObjectAccess = new Map(objectAccess);
      rememberObjectParams(expr.params, localObjectAccess, importedTypeRefs);
      rememberUnannotatedParams(expr.params, localObjectAccess);
      return {
        ...expr,
        body: rewriteExprCalls(
          expr.body,
          bindings,
          selected,
          refs,
          resultRefs,
          localObjectAccess,
          importedTypeRefs,
        ),
      };
    }
    case "If":
      return {
        ...expr,
        cond: rewriteExprCalls(
          expr.cond,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        thenExpr: rewriteExprCalls(
          expr.thenExpr,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        elseExpr: rewriteExprCalls(
          expr.elseExpr,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Match": {
      const value = rewriteExprCalls(
        expr.value,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
      );
      return {
        ...expr,
        value,
        arms: rewriteMatchArms(
          { ...expr, value },
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
          rewriteExprCalls,
        ),
      };
    }
    case "Panic":
      return {
        ...expr,
        message: rewriteExprCalls(
          expr.message,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Block":
      return rewriteBlock(
        expr,
        bindings,
        selected,
        refs,
        resultRefs,
        objectAccess,
        importedTypeRefs,
        passThroughRefs,
        rewriteDeclCalls,
        rewriteExprCalls,
      );
    case "Binary":
      return {
        ...expr,
        left: rewriteExprCalls(
          expr.left,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        right: rewriteExprCalls(
          expr.right,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Unary":
      return {
        ...expr,
        value: rewriteExprCalls(
          expr.value,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    case "Pipe":
      return {
        ...expr,
        left: rewriteExprCalls(
          expr.left,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
        right: rewriteExprCalls(
          expr.right,
          bindings,
          selected,
          refs,
          resultRefs,
          objectAccess,
          importedTypeRefs,
        ),
      };
    default:
      return expr;
  }
}

function rewriteArgsWithVariant(
  args: Expr[],
  variant: FfiVariant,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
  refs: Map<string, JsTypeRef>,
  resultRefs: Map<string, JsTypeRef>,
  objectAccess: Map<string, ObjectAccess>,
  importedTypeRefs: Map<string, JsTypeRef>,
): Expr[] {
  return args.map((arg, index) => {
    const callbackRefs = variant.callbackParamRefs?.find((item) => item.argIndex === index);
    return rewriteExprCalls(
      arg,
      bindings,
      selected,
      refsForCallbackArg(refs, arg, callbackRefs?.params),
      resultRefs,
      objectAccess,
      importedTypeRefs,
    );
  });
}
