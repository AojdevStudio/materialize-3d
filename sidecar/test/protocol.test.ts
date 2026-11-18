import { expect, test } from 'bun:test'
import type { Static, Validator } from '@earendil-works/pi-schema'
import { agentTools } from '../src/agent'
import { Host } from '../src/host'
import type { handlers } from '../src/methods'
import { type Method, type Methods, STEP_LINES, type ToolArgs, type ToolName } from '../src/protocol'

// The checks below are types, so tsc runs them when it compiles this file: a schema and its type that take different
// values fail the compile.

/** Keys an object type names, or none for a record such as `Record<string, never>`. */
type Keys<T> = string extends keyof T ? never : keyof T

/** Whether `A` and `B` take the same values: each fits the other, with the same keys at every depth. */
type Same<A, B> = undefined extends A
  ? undefined extends B
    ? SameDefined<Exclude<A, undefined>, Exclude<B, undefined>>
    : false
  : undefined extends B
    ? false
    : SameDefined<A, B>

type SameDefined<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [A, B] extends [readonly unknown[], readonly unknown[]]
      ? Same<A[number & keyof A], B[number & keyof B]>
      : [A, B] extends [object, object]
        ? [Keys<A>] extends [Keys<B>]
          ? [Keys<B>] extends [Keys<A>]
            ? false extends { [K in Keys<A>]: Same<A[K], B[K & keyof B]> }[Keys<A>]
              ? false
              : true
            : false
          : false
        : true
    : false
  : false

/** The methods whose params schema and `Methods` type take different values. Never, when none do. */
type Drifted = {
  [M in Method]: ReturnType<typeof handlers>[M]['params'] extends Validator<infer P> ? (Same<P, Methods[M]['params']> extends true ? never : M) : M
}[Method]

/** The tools, by place, whose params schema and `ToolArgs` take different values. Never, when none do. */
type Tools = ReturnType<typeof agentTools>
const ORDER = ['read', 'write', 'edit', 'run', 'slice', 'astra'] as const
type DriftedOf<O extends readonly ToolName[]> = {
  [I in keyof O]: Tools[I & keyof Tools] extends { parameters: infer P } ? (Same<Static<P>, ToolArgs[O[I] & ToolName]> extends true ? never : O[I]) : O[I]
}[number]
type ToolDrifted = DriftedOf<typeof ORDER>

// Each params schema takes exactly what its type names.
const methodsMatch: [Drifted] extends [never] ? true : Drifted = true
const toolsMatch: [ToolDrifted] extends [never] ? true : ToolDrifted = true

// The drift check tells a schema from a type that takes one more value.
const narrower: Same<{ plate: 'Cool Plate' }, { plate: 'Cool Plate' | 'Supertack Plate' }> = false
const extraKey: Same<{ model: { provider: string } }, { model: { provider: string; modelId?: string } }> = false
const noParams: Same<Record<never, never>, Record<string, never>> = true

test('the agent offers its tools by the names and in the order the protocol lists them', () => {
  const unused = () => Promise.reject(new Error('not used here'))
  const tools = agentTools({ host: new Host(() => {}), projectOf: unused, signedIn: unused, loginSaves: unused, printer: unused })
  expect(tools.map((tool) => tool.name)).toEqual([...ORDER])
  expect(Object.keys(STEP_LINES)).toEqual([...ORDER])
})
