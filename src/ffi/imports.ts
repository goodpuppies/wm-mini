import type { Decl, JsImportSpec, JsTarget, TypeExpr } from "../ast.ts";
import { diagnosticError } from "../diagnostics.ts";
import {
  jsConstructMember,
  jsGlobalMember,
  jsGlobalMembers,
  jsGlobalMemberTypeRef,
  jsGlobalTypeRef,
  jsGlobalValueRef,
  type JsMemberType,
  jsModuleMember,
  jsModuleMembers,
  jsModuleTypeRef,
  type JsTypeRef,
} from "./js_types.ts";
import { addVariants, type FfiBinding, memberVariants } from "./shared.ts";

export function collectFfiDecl(
  bindings: Map<string, FfiBinding>,
  importedRefs: Map<string, JsTypeRef>,
  importedTypeRefs: Map<string, JsTypeRef>,
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
) {
  if (decl.typeOnly) {
    collectFfiTypeDecl(importedTypeRefs, decl);
    return;
  }
  if (decl.clause.kind === "Namespace") {
    for (const member of jsTargetMembers(decl.target)) {
      addVariants(
        bindings,
        `${decl.clause.alias}.${member.name}`,
        member.name,
        decl.target,
        memberVariants(member),
        !decl.clause.unsafe,
        decl.node,
      );
    }
    return;
  }
  for (const spec of decl.clause.specs) {
    if (decl.target.kind === "JsGlobalRoot" && !spec.type) {
      const localName = spec.alias ?? spec.name;
      const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
      const ref = jsGlobalValueRef(spec.name);
      importedRefs.set(surfaceName, ref);
      const construct = jsConstructMember(ref);
      if (construct) {
        addVariants(
          bindings,
          `${surfaceName}.new`,
          "new",
          { kind: "JsConstructor", path: spec.name },
          specializeForeignResultVariants(memberVariants(construct), importedTypeRefs),
          !decl.clause.unsafe,
          spec.node,
        );
      }
      continue;
    }
    const reflected = !spec.type;
    const member = spec.type
      ? { name: spec.name, type: spec.type }
      : jsTargetMember(decl.target, spec.name);
    if (!member) continue;
    const localName = spec.alias ?? spec.name;
    const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
    addVariants(
      bindings,
      surfaceName,
      spec.name,
      decl.target,
      memberVariants(member),
      reflected && !decl.clause.unsafe,
      spec.node,
    );
  }
}

function specializeForeignResultVariants(
  variants: ReturnType<typeof memberVariants>,
  importedTypeRefs: Map<string, JsTypeRef>,
): ReturnType<typeof memberVariants> {
  return variants.map((variant) => {
    const resultType = variant.resultRef && foreignTypeForRef(variant.resultRef, importedTypeRefs);
    return resultType ? { ...variant, type: replaceResultType(variant.type, resultType) } : variant;
  });
}

function foreignTypeForRef(
  ref: JsTypeRef,
  importedTypeRefs: Map<string, JsTypeRef>,
): TypeExpr | undefined {
  for (const [name, imported] of importedTypeRefs) {
    if (imported.key === ref.key) return { kind: "TName", name, args: [] };
  }
  return undefined;
}

function replaceResultType(type: TypeExpr, result: TypeExpr): TypeExpr {
  return type.kind === "TFn" ? { ...type, result } : result;
}

function collectFfiTypeDecl(
  importedTypeRefs: Map<string, JsTypeRef>,
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
) {
  if (decl.clause.kind === "Namespace") {
    throw diagnosticError(new Error("JS type imports must name the imported types"), decl.node);
  }
  for (const spec of decl.clause.specs) {
    const localName = spec.alias ?? spec.name;
    const ref = jsTypeRefForTarget(decl.target, spec.name);
    if (ref) importedTypeRefs.set(localName, ref);
  }
}

function jsTypeRefForTarget(target: JsTarget, name: string): JsTypeRef | undefined {
  if (target.kind === "JsGlobalRoot") return jsGlobalTypeRef(name);
  if (target.kind === "JsGlobal") return jsGlobalMemberTypeRef(target.path, name);
  if (target.kind === "JsModule") return jsModuleTypeRef(target.specifier, name);
  return undefined;
}

export function generatedJsImports(
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
  bindings: Map<string, FfiBinding>,
  selected: Set<string>,
): Decl[] {
  if (decl.clause.kind === "Namespace") {
    const specs = [...bindings.values()]
      .filter((binding) => binding.surfaceName.startsWith(`${decl.clause.alias}.`))
      .flatMap((binding) =>
        binding.variants
          .filter((variant) => selected.has(variant.internalName))
          .map((variant) => ({
            name: variant.memberName,
            alias: variant.internalName,
            type: variant.type,
            fallible: variant.fallible,
            node: variant.node,
          }))
      );
    if (specs.length === 0) return [];
    return [{
      ...decl,
      clause: {
        kind: "Named",
        specs,
        node: decl.clause.node,
      },
    }];
  }
  const clauseNode = decl.clause.node;
  return decl.clause.specs.flatMap((spec) => {
    if (decl.target.kind === "JsGlobalRoot" && !spec.type) return [];
    const localName = spec.alias ?? spec.name;
    const surfaceName = decl.clause.alias ? `${decl.clause.alias}.${localName}` : localName;
    const binding = bindings.get(surfaceName);
    if (!binding) return [namedJsImportDecl(decl, [spec], clauseNode)];
    const variants = binding.variants;
    if (variants.length === 1 && !decl.clause.alias) {
      return [namedJsImportDecl(
        decl,
        [{ ...spec, type: variants[0].type, fallible: variants[0].fallible }],
        clauseNode,
      )];
    }
    const selectedVariants = variants.filter((variant) => selected.has(variant.internalName));
    if (selectedVariants.length === 0) return [];
    return [namedJsImportDecl(
      decl,
      selectedVariants.map((variant) => ({
        ...spec,
        name: variant.memberName,
        alias: variant.internalName,
        type: variant.type,
        fallible: variant.fallible,
      })),
      clauseNode,
    )];
  });
}

export function generatedTypeAliases(importedTypeRefs: Map<string, JsTypeRef>): Decl[] {
  return [...importedTypeRefs].map(([typeName, ref]) => ({
    kind: "ForeignTypeDecl" as const,
    name: typeName,
    foreignKey: ref.key,
  }));
}

function namedJsImportDecl(
  decl: Extract<Decl, { kind: "JsImportDecl" }>,
  specs: JsImportSpec[],
  node: Extract<Decl, { kind: "JsImportDecl" }>["clause"]["node"],
): Extract<Decl, { kind: "JsImportDecl" }> {
  return {
    ...decl,
    clause: { kind: "Named", specs, node },
  };
}

function jsTargetMembers(target: JsTarget) {
  if (target.kind === "JsGlobalRoot") return [];
  if (target.kind === "JsGlobal") return jsGlobalMembers(target.path);
  if (target.kind === "JsModule") return jsModuleMembers(target.specifier);
  return [];
}

function jsTargetMember(target: JsTarget, name: string): JsMemberType | undefined {
  if (target.kind === "JsGlobalRoot") return undefined;
  if (target.kind === "JsGlobal") return jsGlobalMember(target.path, name);
  if (target.kind === "JsModule") return jsModuleMember(target.specifier, name);
  return undefined;
}
