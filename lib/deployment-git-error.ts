export function gitInspectionError(output: string) {
  // Return recognised causes, never raw Git output (which may contain credentials).
  if (/dubious ownership/i.test(output)) return 'Git refused this checkout because its Windows owner differs from the deployment service account. Verify repository ownership and add an exact safe.directory exception for the deployment account. No source files were changed.'
  if (/not a git repository/i.test(output)) return 'The application folder is not a readable Git checkout. Verify its configured root and .git directory. No source files were changed.'
  if (/index\.lock|another git process/i.test(output)) return 'Git is locked by another operation. Check for an active Git command before removing a stale lock. No source files were changed.'
  if (/permission denied|access is denied/i.test(output)) return 'The deployment account cannot read the Git checkout. Check permissions on the application and .git folders. No source files were changed.'
  if (/not recognized|ENOENT|not found/i.test(output)) return 'Git could not be started. Verify Git is installed and available to the deployment service account. No source files were changed.'
  return 'Could not check local source changes; deployment stopped without changing the checkout. Check Git availability, repository permissions and filesystem health.'
}
