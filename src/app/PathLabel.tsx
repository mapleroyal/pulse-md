import * as React from "react"

import { splitPath } from "@/app/path-label"
import type { FilePathDisplayMode } from "@/shared/contracts"

export function PathLabel({
  className,
  display,
  displayName,
  filePath,
}: {
  className?: string
  display: FilePathDisplayMode
  displayName: string
  filePath: string | null
}) {
  const label = splitPath(filePath, displayName)
  const contentRef = React.useRef<HTMLSpanElement>(null)

  React.useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return

    const measureOverflow = () => {
      const intrinsicWidth = [
        ...content.querySelectorAll<HTMLElement>(
          ".path-directory-text, .path-filename-text"
        ),
      ].reduce((width, part) => width + part.getBoundingClientRect().width, 0)
      content.toggleAttribute(
        "data-overflow",
        intrinsicWidth > content.getBoundingClientRect().width + 0.5
      )
    }

    measureOverflow()
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(content)
    for (const part of content.querySelectorAll<HTMLElement>(
      ".path-directory-text, .path-filename-text"
    )) {
      observer.observe(part)
    }
    return () => observer.disconnect()
  }, [display, label.directory, label.filename])

  return (
    <span ref={contentRef} className={className}>
      {display === "path" && label.directory ? (
        <span className="path-directory">
          <span className="path-directory-text">{label.directory}</span>
        </span>
      ) : null}
      <span className="path-filename">
        <span className="path-filename-text">{label.filename}</span>
      </span>
    </span>
  )
}
