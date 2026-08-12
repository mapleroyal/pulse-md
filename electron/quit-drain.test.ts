import { describe, expect, it } from "vitest"

import {
  closeIngressAndDrainOperations,
  runQuiescedOperation,
} from "./quit-drain"

describe("quit persistence draining", () => {
  it("drains work dispatched while accepted ingress is closing", async () => {
    const events: string[] = []
    const operations: Promise<void>[] = []
    const closeIngress = async () => {
      events.push("close-start")
      await Promise.resolve()
      operations.push(
        Promise.resolve().then(() => {
          events.push("late-operation")
        })
      )
      events.push("close-finished")
    }
    const drain = async () => {
      events.push(`drain-${operations.length}`)
      await Promise.allSettled(operations.splice(0))
    }

    await closeIngressAndDrainOperations(closeIngress, drain)

    expect(events).toEqual([
      "close-start",
      "drain-0",
      "close-finished",
      "late-operation",
      "drain-1",
    ])
  })

  it("restores ingress when a quiesced close or drain rejects", async () => {
    const states: boolean[] = []

    await expect(
      runQuiescedOperation(
        (quiescing) => states.push(quiescing),
        async () => {
          throw new Error("drain failed")
        },
        () => true
      )
    ).rejects.toThrow("drain failed")
    expect(states).toEqual([true, false])
  })
})
