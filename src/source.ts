export type SourceSpan = {
  line: number;
  col: number;
  start: number;
  end: number;
};

export type AstNode = {
  id: number;
  span: SourceSpan;
};

export function makeSpan(line: number, col: number, start: number, end: number): SourceSpan {
  return { line, col, start, end };
}

export function offsetToLineCol(source: string, offset: number): { line: number; col: number } {
  const limit = Math.max(0, offset);
  let line = 1;
  let col = 0;
  for (let i = 0; i < source.length && i < limit; i++) {
    if (source[i] === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function sliceSource(source: string, span: SourceSpan): string {
  return source.slice(span.start, span.end);
}
