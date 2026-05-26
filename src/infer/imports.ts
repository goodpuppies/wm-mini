import type { ImportClause } from "../ast.ts";
import type { Env, TypeDeclInfo, TypeEnv } from "../types.ts";
import type { InferResult } from "../infer.ts";

export function addImport(
  env: Env,
  typeEnv: TypeEnv,
  clause: ImportClause,
  imported: InferResult,
) {
  if (clause.kind === "Namespace") {
    addQualifiedImport(env, clause.alias, imported.exportedStructure.values);
    addQualifiedTypes(typeEnv, clause.alias, imported.exportedStructure.types);
    return;
  }
  const values = new Set<string>();
  const types = new Set<string>();
  for (const spec of clause.specs) {
    const local = spec.alias ?? spec.name;
    const value = imported.exportedStructure.values.get(spec.name);
    const type = imported.exportedStructure.types.get(spec.name);
    if (!value && !type) throw new Error(`unknown import ${spec.name}`);
    if (value) {
      if (values.has(local) || env.has(local)) throw new Error(`duplicate value import ${local}`);
      values.add(local);
      env.set(local, value);
    }
    if (type) {
      if (types.has(local) || typeEnv.has(local)) throw new Error(`duplicate type import ${local}`);
      types.add(local);
      typeEnv.set(local, type);
    }
  }
}

export function addAdts(adts: Map<number, TypeDeclInfo>, imported: Map<number, TypeDeclInfo>) {
  for (const [id, info] of imported) adts.set(id, info);
}

function addQualifiedImport(env: Env, alias: string, imported: Env) {
  for (const [name, scheme] of imported) {
    const local = `${alias}.${name}`;
    if (env.has(local)) throw new Error(`duplicate value import ${local}`);
    env.set(local, scheme);
  }
}

function addQualifiedTypes(typeEnv: TypeEnv, alias: string, imported: TypeEnv) {
  for (const [name, info] of imported) {
    const local = `${alias}.${name}`;
    if (typeEnv.has(local)) throw new Error(`duplicate type import ${local}`);
    typeEnv.set(local, info);
  }
}
