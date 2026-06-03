import type { TypeExpr } from "../ast.ts";

export function name(name: string): TypeExpr {
  return { kind: "TName", name, args: [] };
}

export function option(inner: TypeExpr): TypeExpr {
  return { kind: "TName", name: "Option", args: [inner] };
}

export function varType(name: string): TypeExpr {
  return { kind: "TVar", name };
}

export function fn(params: TypeExpr[], result: TypeExpr): TypeExpr {
  return { kind: "TFn", params, result };
}
