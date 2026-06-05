import type { Expr } from "../../ast.ts";
import type { Ty } from "../../types.ts";
import type { JsTypeRef } from "../reflect/types.ts";

export type ResolveOptions = {
  receiverTypes?: Map<Expr, Ty>;
  foreignTypeRefs?: Map<string, JsTypeRef>;
};
