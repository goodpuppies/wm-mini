import type { Env } from "../types.ts";
import { show } from "../types.ts";

export type TypeSnapshot = { type: string; vars: number };

export function describeEnv(env: Env): string {
  return [...env.entries()].map(([name, scheme]) => `${name}: ${show(scheme.type)}`).join("\n");
}

export function snapshotEnv(env: Env): Map<string, TypeSnapshot> {
  return new Map(
    [...env.entries()].map(([name, scheme]) => [
      name,
      { type: show(scheme.type), vars: scheme.vars.length },
    ]),
  );
}
