import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import path from "path"
import { WriteTool } from "../../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { Format } from "../../../src/format"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { SessionID, MessageID } from "../../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { Permission } from "../../../src/permission"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
    ]),
  ),
)

const rules = Permission.fromConfig({
  edit: { "*": "deny", ".local/test/*.md": "allow" },
})

describe("kilocode write permission pattern (#15209)", () => {
  describe.each([{ git: false }, { git: true }])("git=$git", ({ git }) => {
    it.instance(
      "asks edit permission with a project-relative pattern",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const patterns: string[] = []
          const info = yield* WriteTool
          const tool = yield* info.init()
          yield* tool.execute(
            { filePath: path.join(test.directory, ".local", "test", "test.md"), content: "hi" },
            {
              sessionID: SessionID.make("ses_test-15209"),
              messageID: MessageID.make("msg_test"),
              callID: "",
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => Effect.void,
              ask: (req) =>
                Effect.sync(() => {
                  patterns.push(...req.patterns)
                }),
            },
          )
          expect(patterns).toEqual([".local/test/test.md"])
          expect(Permission.evaluate("edit", patterns[0]!, rules).action).toBe("allow")
          expect(Permission.evaluate("edit", ".local/other/x.txt", rules).action).toBe("deny")
        }),
      { git },
    )
  })
})
