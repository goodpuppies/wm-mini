import { normalize, resolve } from "node:path";
import { analyzeFile } from "../compiler.ts";
import {
  classifyDiagnostic,
  errorMessage,
  type FrontendDiagnostic,
  FrontendDiagnosticError,
} from "../diagnostics.ts";
import type { InferResult } from "../infer.ts";
import { type LspRange, peggyLocationRange, spanRange, startRange } from "./range.ts";
import { fileUriToPath, pathToFileUri } from "./uri.ts";

export type ValidationResult = {
  uri: string;
  diagnostics: LspDiagnostic[];
};

export type LspDiagnostic = {
  range: LspRange;
  severity: 1 | 2 | 3 | 4;
  code: string;
  source: "wm-mini";
  message: string;
};

export async function validateUri(
  uri: string,
  sourceOverrides: Map<string, string>,
): Promise<ValidationResult[]> {
  const entryPath = normalize(resolve(fileUriToPath(uri)));
  try {
    const analysis = await analyzeFile(entryPath, { sourceOverrides });
    return analysis.graph.order.map((path) => ({
      uri: pathToFileUri(path),
      diagnostics: diagnosticsFor(
        analysis.results.get(path),
        analysis.graph.nodes.get(path)?.source ?? "",
      ),
    }));
  } catch (error) {
    const canonical = canonicalPath(entryPath, sourceOverrides);
    return [{
      uri: pathToFileUri(canonical),
      diagnostics: [errorDiagnostic(error, sourceOverrides.get(canonical) ?? "")],
    }];
  }
}

function diagnosticsFor(result: InferResult | undefined, source = ""): LspDiagnostic[] {
  return result?.diagnostics.map((diagnostic) => lspDiagnostic(diagnostic, source)) ?? [];
}

function errorDiagnostic(error: unknown, source = ""): LspDiagnostic {
  if (error instanceof FrontendDiagnosticError) {
    return lspDiagnostic(error.diagnostic, source);
  }
  const message = errorMessage(error);
  return {
    range: peggyLocationRange(errorLocation(error)),
    severity: 1,
    code: classifyDiagnostic(message),
    source: "wm-mini",
    message,
  };
}

function lspDiagnostic(diagnostic: FrontendDiagnostic, source = ""): LspDiagnostic {
  return {
    range: diagnostic.span && source ? spanRange(source, diagnostic.span) : startRange,
    severity: diagnostic.severity === "error" ? 1 : 2,
    code: diagnostic.code,
    source: "wm-mini",
    message: diagnostic.message,
  };
}

function errorLocation(error: unknown): PeggyLocation | undefined {
  if (!error || typeof error !== "object" || !("location" in error)) return undefined;
  const location = (error as { location?: unknown }).location;
  if (!location || typeof location !== "object") return undefined;
  return location as PeggyLocation;
}

function canonicalPath(path: string, sourceOverrides: Map<string, string>): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return sourceOverrides.has(path) ? path : path;
  }
}

type PeggyLocation = Parameters<typeof peggyLocationRange>[0];
