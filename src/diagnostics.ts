import type { AstNode, SourceSpan } from "./source.ts";

export type FrontendDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  node?: AstNode;
  span?: SourceSpan;
};

export class FrontendDiagnosticError extends Error {
  diagnostic: FrontendDiagnostic;

  constructor(diagnostic: FrontendDiagnostic) {
    super(diagnostic.message);
    this.name = "FrontendDiagnosticError";
    this.diagnostic = diagnostic;
  }
}

export function diagnosticError(
  error: unknown,
  node: AstNode | undefined,
  code = classifyDiagnostic(errorMessage(error)),
): FrontendDiagnosticError {
  if (error instanceof FrontendDiagnosticError) return error;
  return new FrontendDiagnosticError({
    severity: "error",
    code,
    message: errorMessage(error),
    node,
    span: node?.span,
  });
}

export function warningDiagnostic(
  message: string,
  node: AstNode | undefined,
  code: string,
): FrontendDiagnostic {
  return {
    severity: "warning",
    code,
    message,
    node,
    span: node?.span,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyDiagnostic(message: string): string {
  if (message.includes("type mismatch")) return "type.mismatch";
  if (message.includes("unknown import")) return "module.unknown-import";
  if (message.includes("duplicate value import") || message.includes("duplicate type import")) {
    return "module.duplicate-import";
  }
  if (message.includes("cannot resolve import")) return "module.resolve-import";
  if (message.includes("import cycle")) return "module.import-cycle";
  if (message.includes("Expected") || message.includes("expected")) return "parse.syntax-error";
  return "error";
}
