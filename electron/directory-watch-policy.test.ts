import { describe, expect, it } from "vitest"

import {
  DIRECTORY_WATCH_RETRY_LIMIT,
  directoryWatchRetryDelay,
} from "./directory-watch-policy"

describe("directory watch retry policy", () => {
  it("uses bounded exponential delays", () => {
    expect(
      Array.from({ length: DIRECTORY_WATCH_RETRY_LIMIT }, (_value, index) =>
        directoryWatchRetryDelay(index + 1)
      )
    ).toEqual([350, 700, 1_400, 2_800, 5_600])
    expect(directoryWatchRetryDelay(DIRECTORY_WATCH_RETRY_LIMIT + 1)).toBeNull()
  })

  it("rejects invalid failure counts", () => {
    expect(() => directoryWatchRetryDelay(0)).toThrow(RangeError)
    expect(() => directoryWatchRetryDelay(1.5)).toThrow(RangeError)
  })
})
