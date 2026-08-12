export function windowsSessionEndRequiresQuitTransaction(
  applicationQuitAuthorized: boolean,
  windowCloseAuthorized: boolean
): boolean {
  return !applicationQuitAuthorized && !windowCloseAuthorized
}
