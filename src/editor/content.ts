/** Convert external text into CodeMirror's predictable internal LF representation. */
export function normalizeEditorContent(content: string) {
  const withoutBom =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  return withoutBom.replace(/\r\n?/g, "\n")
}
