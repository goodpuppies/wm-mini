import type { Decl, Param } from "../../ast.ts";
import { prune } from "../../types.ts";
import type { ResolveOptions } from "./types.ts";
import { type FfiElaboration, paramBinder } from "../shared.ts";
import { resultRefForExpr } from "../receiver/receiver.ts";
import type { JsTypeRef } from "../reflect/types.ts";

export function generatedImportInsertionIndex(decls: Decl[]): number {
  let lastTypeDecl = -1;
  for (let index = 0; index < decls.length; index++) {
    const kind = decls[index].kind;
    if (kind === "ForeignTypeDecl" || kind === "RecordDecl" || kind === "TypeDecl") {
      lastTypeDecl = index;
    }
  }
  if (lastTypeDecl !== -1) return lastTypeDecl + 1;
  const firstLet = decls.findIndex((decl) => decl.kind === "LetDecl");
  return firstLet === -1 ? decls.length : firstLet;
}

export function generatedForeignDeclsForOverrides(
  decls: Decl[],
  receiverTypes: ResolveOptions["receiverTypes"],
): Decl[] {
  if (!receiverTypes) return [];
  const existing = new Set(
    decls
      .filter((decl) => decl.kind === "ForeignTypeDecl")
      .map((decl) => `${decl.name}:${decl.foreignKey ?? ""}`),
  );
  const generated: Decl[] = [];
  for (const type of receiverTypes.values()) {
    const target = prune(type);
    if (target.tag !== "named" || !target.foreign) continue;
    const key = `${target.name}:${target.foreignKey ?? ""}`;
    if (existing.has(key)) continue;
    existing.add(key);
    generated.push({
      kind: "ForeignTypeDecl",
      name: target.name,
      foreignKey: target.foreignKey,
    });
  }
  return generated;
}

export function rememberDelayedLetRefs(
  decl: Decl,
  ffi: FfiElaboration,
  valueRefs: Map<string, JsTypeRef>,
) {
  if (decl.kind !== "LetDecl") return;
  for (const binding of decl.bindings) {
    if (binding.pattern.kind !== "PVar") continue;
    if (binding.annotation?.kind === "TName" && binding.annotation.name === "Js.Object") continue;
    const ref = resultRefForExpr(binding.value, ffi.bindings, valueRefs, ffi.passThroughRefs);
    if (ref) valueRefs.set(binding.pattern.name, ref);
  }
}

export function delayedValueRefsForBinding(
  binding: Extract<Decl, { kind: "LetDecl" }>["bindings"][number],
  ffi: FfiElaboration,
  valueRefs: Map<string, JsTypeRef>,
): Map<string, JsTypeRef> {
  if (binding.pattern.kind !== "PVar" || binding.value.kind !== "Lambda") return valueRefs;
  const callbackRefs = ffi.namedCallbackRefs.get(binding.pattern.name);
  if (!callbackRefs?.length) return valueRefs;
  const localValueRefs = new Map(valueRefs);
  rememberLambdaParamRefs(binding.value.params, callbackRefs, localValueRefs);
  return localValueRefs;
}

function rememberLambdaParamRefs(
  params: Param[],
  refs: JsTypeRef[],
  valueRefs: Map<string, JsTypeRef>,
) {
  for (let index = 0; index < params.length; index++) {
    const binder = paramBinder(params[index]);
    const ref = refs[index];
    if (binder && ref) valueRefs.set(binder, ref);
  }
}
