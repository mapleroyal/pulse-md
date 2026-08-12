declare module "@mixmark-io/domino" {
  export function createDocument(html?: string, force?: boolean): Document

  const domino: {
    createDocument: typeof createDocument
  }
  export default domino
}
