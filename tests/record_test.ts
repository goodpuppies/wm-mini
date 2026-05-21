import { assertRejects } from "@std/assert";
import { checkFile, checkSource, checkSourceSteps } from "../src/compiler.ts";
import { expectBinding, expectStepBinding, expectStepMissing } from "./type_helpers.ts";

Deno.test("nominal records infer construction and field access", async () => {
  const result = await checkSource(`
    record Point = { x: Number, y: Number };
    let p = .{ x = 10, y = 20 };
    let xVal = p.x;
  `);

  expectBinding(result.env, "p", { type: "Point", vars: 0 });
  expectBinding(result.env, "xVal", { type: "Number", vars: 0 });
});

Deno.test("polymorphic record fields preserve type parameters", async () => {
  const result = await checkSource(`
    record Pair<A, B> = { first: A, second: B };
    let pair = .{ first = 1, second = true };
    let first = pair.first;
    let second = pair.second;
  `);

  expectBinding(result.env, "pair", { type: "Pair<Number, Bool>", vars: 0 });
  expectBinding(result.env, "first", { type: "Number", vars: 0 });
  expectBinding(result.env, "second", { type: "Bool", vars: 0 });
});

Deno.test("record patterns bind fields through nominal record types", async () => {
  const result = await checkSource(`
    record Point = { x: Number, y: Number };
    let p = .{ x = 10, y = 20 };
    let .{ x, y } = p;
    let sum = x + y;
  `);

  expectBinding(result.env, "x", { type: "Number", vars: 0 });
  expectBinding(result.env, "y", { type: "Number", vars: 0 });
  expectBinding(result.env, "sum", { type: "Number", vars: 0 });
});

Deno.test("record elaboration snapshots expose record values after declaration order", async () => {
  const steps = await checkSourceSteps(`
    record Point = { x: Number, y: Number };
    let p = .{ x = 10, y = 20 };
    let getX = (point: Point) => { point.x };
  `);

  expectStepMissing(steps, 0, "p");
  expectStepBinding(steps, 1, "p", { type: "Point", vars: 0 });
  expectStepBinding(steps, 2, "getX", { type: "(Point) => Number", vars: 0 });
});

Deno.test("records are nominal and reject shape-only ambiguity", async () => {
  await assertRejects(
    () =>
      checkSource(`
        record Point = { x: Number, y: Number };
        record Vector = { x: Number, y: Number };
        let p = .{ x = 10, y = 20 };
      `),
    Error,
    "ambiguous record type",
  );
});

Deno.test("record annotations disambiguate same-shaped nominal records", async () => {
  const result = await checkSource(`
    record Point = { x: Number, y: Number };
    record Vector = { x: Number, y: Number };
    let p: Point = .{ x = 10, y = 20 };
    let v: Vector = .{ x = 1, y = 2 };
  `);

  expectBinding(result.env, "p", { type: "Point", vars: 0 });
  expectBinding(result.env, "v", { type: "Vector", vars: 0 });
});

Deno.test("imported records remain nominal across file boundaries", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/a.wm`,
    "export record Point = { x: Number, y: Number }; export let make = () => { .{ x = 1, y = 2 } };",
  );
  await Deno.writeTextFile(
    `${dir}/b.wm`,
    "export record Point = { x: Number, y: Number }; export let make = () => { .{ x = 1, y = 2 } };",
  );
  await Deno.writeTextFile(
    `${dir}/main.wm`,
    `
      from "./a.wm" import * as A;
      from "./b.wm" import * as B;
      let good: A.Point = A.make();
      let bad: A.Point = B.make();
    `,
  );

  await assertRejects(() => checkFile(`${dir}/main.wm`), Error, "type mismatch");
});

Deno.test("imported record annotations guide record literals", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/point.wm`,
    "export record Point = { x: Number, y: Number };",
  );
  await Deno.writeTextFile(
    `${dir}/main.wm`,
    `
      from "./point.wm" import * as Geometry;
      let p: Geometry.Point = .{ x = 1, y = 2 };
      let x = p.x;
    `,
  );

  await checkFile(`${dir}/main.wm`);
});

Deno.test("named imports expose exported record types", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/point.wm`,
    "export record Point = { x: Number, y: Number };",
  );
  await Deno.writeTextFile(
    `${dir}/main.wm`,
    `
      from "./point.wm" import { Point };
      let p: Point = .{ x = 1, y = 2 };
      let x = p.x;
    `,
  );

  await checkFile(`${dir}/main.wm`);
});

Deno.test("block-local record names do not escape", async () => {
  await assertRejects(
    () =>
      checkSource(`
        let p = {
          record Point = { x: Number, y: Number };
          .{ x = 1, y = 2 }
        };
      `),
    Error,
    "local type escapes scope",
  );
});

Deno.test("record declarations reject duplicate fields", async () => {
  await assertRejects(
    () => checkSource("record Bad = { x: Number, x: Bool };"),
    Error,
    "duplicate record field x",
  );
});

Deno.test("record patterns reject duplicate fields", async () => {
  await assertRejects(
    () =>
      checkSource(`
        record Point = { x: Number };
        let p = .{ x = 1 };
        let .{ x = a, x = b } = p;
      `),
    Error,
    "duplicate record field x",
  );
});
