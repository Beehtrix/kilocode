/**
 * Counts snapshot git work per agent step and checks that no change is lost (issue #16147).
 *
 * A `git` shim first on PATH records every invocation that targets the snapshot
 * gitdir. Each full worktree scan (`add()`) runs exactly one `ls-files --others`.
 * The shim can also create a file right after the Nth `write-tree`, which lands
 * between the step-finish snapshot and whatever the processor does next.
 */
import { afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionPrompt } from "../../../src/session/prompt"
import { SessionRevert } from "../../../src/session/revert"
import { SessionSummary } from "../../../src/session/summary"
import { disposeAllInstances, provideTmpdirServer } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { TestLLMServer } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

const root = LayerNode.group([
  SessionPrompt.node,
  SessionRevert.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })]]),
)

afterEach(async () => {
  await disposeAllInstances()
})

// Installs a git shim that logs the arguments of every call, then restores PATH.
// When `<dir>/hook` exists it runs once, after the `write-tree` call number in `<dir>/after`.
const shim = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-shim-"))
    const log = path.join(dir, "calls.log")
    const real = Bun.which("git")
    if (!real) throw new Error("git not found")
    const body = [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `'${real}' "$@"`,
      "code=$?",
      `if [ -f '${dir}/hook' ] && [ ! -f '${dir}/fired' ]; then`,
      `  n=$(grep -c ' write-tree' '${log}')`,
      `  if [ "$n" -ge "$(cat '${dir}/after')" ]; then touch '${dir}/fired'; sh '${dir}/hook'; fi`,
      "fi",
      'exit "$code"',
      "",
    ].join("\n")
    await fs.writeFile(path.join(dir, "git"), body, { mode: 0o755 })
    const prev = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${prev}`
    return { dir, log, prev }
  }),
  (item) =>
    Effect.promise(async () => {
      process.env.PATH = item.prev
      await fs.rm(item.dir, { recursive: true, force: true })
    }),
)

const calls = (log: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(log, "utf8").catch(() => "")
    return text.split("\n").filter((line) => line.includes("--git-dir") && line.includes("/snapshot/"))
  })

const scans = (lines: string[]) => lines.filter((line) => line.includes("ls-files") && line.includes("--others")).length

const fwd = (file: string) => file.replaceAll("\\", "/")

type Case = {
  name: string
  // Tool steps run `echo made > made.txt` before the final answer.
  tool: boolean
  // Create gap.txt right after this write-tree call (1 = start of message, 2 = step-finish of the first step).
  gap?: number
  // Expected scans: one at message start, one per step end, one rescan at cleanup.
  scans: number
}

const cases: Case[] = [
  { name: "a single model step", tool: false, scans: 3 },
  { name: "a tool step followed by an answer", tool: true, scans: 6 },
  { name: "a change after the step-finish snapshot of a text step", tool: false, gap: 2, scans: 3 },
  { name: "a change after the step-finish snapshot of a tool step", tool: true, gap: 2, scans: 6 },
]

// Skipped on Windows: the shim is a POSIX shell script.
const live = process.platform === "win32" ? it.live.skip : it.live

for (const item of cases) {
  live(`${item.name} keeps every change in a patch and counts scans (#16147)`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const spy = yield* shim
        const made = path.join(dir, "made.txt")
        const gap = path.join(dir, "gap.txt")
        const exists = (file: string) =>
          Effect.promise(() =>
            fs.access(file).then(
              () => true,
              () => false,
            ),
          )
        const ask = (text: string) =>
          prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text }],
          })

        const session = yield* sessions.create({
          title: "snapshot per step",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("warm up"), "hi")
        yield* ask("warm up")
        // Settle repository initialization so only the measured message is counted.
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "seed.txt"), "seed"))
        yield* prompt.loop({ sessionID: session.id })
        yield* Effect.promise(() => fs.rm(spy.log, { force: true }))

        if (item.tool) {
          yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("make it"), "bash", {
            command: `echo made > ${made}`,
          })
          yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")
        } else {
          yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("make it"), "ok")
        }
        if (item.gap) {
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(spy.dir, "after"), String(item.gap))
            await fs.writeFile(path.join(spy.dir, "hook"), `echo gap > '${gap}'\n`)
          })
        }
        const user = yield* ask("make it")
        yield* prompt.loop({ sessionID: session.id })

        const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((msg) => msg.parts)
        const finishes = parts.filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
        const patched = parts
          .filter((part): part is SessionV1.PatchPart => part.type === "patch")
          .flatMap((part) => [...part.files])
        const lines = yield* calls(spy.log)
        console.log(`${item.name}: git calls=${lines.length} scans=${scans(lines)} steps=${finishes.length}`)

        expect(patched.includes(fwd(made))).toBe(item.tool)
        expect(patched.includes(fwd(gap))).toBe(!!item.gap)
        if (item.gap) expect(yield* exists(gap)).toBe(true)

        // Reverting the turn must undo everything it changed, including the gap change.
        yield* revert.revert({ sessionID: session.id, messageID: user.info.id })
        expect(yield* exists(made)).toBe(false)
        expect(yield* exists(gap)).toBe(false)
        expect(scans(lines)).toBe(item.scans)
      }),
      { git: true, config: testProviderConfig },
    ),
  )
}
