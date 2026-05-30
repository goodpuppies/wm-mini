import { checkSource } from "../src/compiler.ts";

Deno.test("basic pipe to function", async () => {
  await checkSource(`
    let double = (x) => { x * 2 };
    let result = 42 :> double;
  `);
});

Deno.test("chained pipe operators", async () => {
  await checkSource(`
    let double = (x) => { x * 2 };
    let add = (x, y) => { x + y };
    let print = (x) => { x };
    let result = 42 :> double :> add(10) :> print;
  `);
});

Deno.test("pipe with multi-argument function", async () => {
  await checkSource(`
    let add = (x, y) => { x + y };
    let result = 10 :> add(5);
  `);
});

Deno.test("pipe with tuple for multiple arguments", async () => {
  await checkSource(`
    let add = (x, y) => { x + y };
    let result = (10, 5) :> add;
  `);
});
