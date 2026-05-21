import { assertEquals } from "@std/assert";
import { makeSpan, offsetToLineCol, sliceSource } from "../src/source.ts";

Deno.test("source spans use workmangr line column and offset conventions", () => {
  const source = "one\ntwo\nthree";

  assertEquals(offsetToLineCol(source, 0), { line: 1, col: 0 });
  assertEquals(offsetToLineCol(source, 4), { line: 2, col: 0 });
  assertEquals(offsetToLineCol(source, 7), { line: 2, col: 3 });

  const span = makeSpan(2, 0, 4, 7);
  assertEquals(sliceSource(source, span), "two");
});
