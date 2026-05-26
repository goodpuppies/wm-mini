import { offsetToLineCol, type SourceSpan } from "../source.ts";

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export const startRange: LspRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

export function spanRange(source: string, span: SourceSpan): LspRange {
  const start = offsetToLineCol(source, span.start);
  const end = offsetToLineCol(source, Math.max(span.start + 1, span.end));
  return {
    start: { line: start.line - 1, character: start.col },
    end: { line: end.line - 1, character: end.col },
  };
}

export function peggyLocationRange(location: PeggyLocation | undefined): LspRange {
  if (!location) return startRange;
  return {
    start: {
      line: Math.max(0, location.start.line - 1),
      character: Math.max(0, location.start.column - 1),
    },
    end: {
      line: Math.max(0, location.end.line - 1),
      character: Math.max(0, location.end.column - 1),
    },
  };
}

type PeggyLocation = {
  start: { line: number; column: number };
  end: { line: number; column: number };
};
