export function splitPath(filePath: string | null, displayName: string) {
  if (!filePath) {
    return { directory: "", filename: displayName || "Untitled" }
  }
  const match = /^(.*[\\/])([^\\/]*)$/.exec(filePath)
  return {
    directory: match?.[1] ?? "",
    filename: displayName || match?.[2] || "Untitled",
  }
}
