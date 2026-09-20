/** Filesystem path guards shared by sidebar APIs that access a session workspace. */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import { SidebarError } from './wire.ts'

/** Resolve a path and convert filesystem resolution failures to an API error. */
async function resolveRealPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot resolve ${label} "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
}

/** Reject a resolved path whose real filesystem target escapes the workspace. */
function assertWithinWorkspace(workspace: string, target: string): void {
  if (!isWithin(workspace, target)) {
    throw new SidebarError('forbidden', `path "${target}" is outside workspace`, 403)
  }
}

/**
 * Resolve an existing workspace path through symlinks and (unless disarmed)
 * enforce containment.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute path in the session's namespace.
 * @param fence - Whether containment is enforced (the settings-page
 * `workspaceFence` switch). Even when false the paths are still resolved
 * through symlinks so callers always receive the canonical target.
 * @returns The canonical absolute path used for the filesystem operation.
 */
export async function ensureWorkspacePath(cwd: string, target: string, fence = true): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const [realCwd, realTarget] = await Promise.all([
    resolveRealPath(cwd, 'workspace'),
    resolveRealPath(absolute, 'target'),
  ])
  if (fence) assertWithinWorkspace(realCwd, realTarget)
  return realTarget
}

/**
 * Resolve an existing workspace path like {@link ensureWorkspacePath}, but
 * report a MISSING target as `not-found` (404) instead of a generic fs
 * error — the exact-path lookup behind the sidebar search answers "does
 * this path exist", so a missing path is the expected negative answer,
 * not a resolution failure. Existence is answered before containment:
 * a missing path outside the workspace is `not-found`, not `forbidden`.
 *
 * @param cwd - Session workspace directory.
 * @param target - Absolute path in the session's namespace (callers join
 * relative spellings onto the cwd first).
 * @param fence - Whether containment is enforced (the settings-page
 * `workspaceFence` switch); an existing target outside the workspace is
 * `forbidden`.
 * @returns The canonical absolute paths of the target AND the workspace
 * root — the caller needs the canonical cwd to relativize the hit without
 * a second realpath round-trip (a logical-cwd base would misjudge targets
 * behind a symlinked cwd and degrade in-tree hits to absolute paths).
 */
export async function ensureExistingWorkspacePath(cwd: string, target: string, fence = true): Promise<{ realCwd: string; realTarget: string }> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  let realTarget: string
  try {
    realTarget = await realpath(absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new SidebarError('not-found', `path "${target}" does not exist`, 404)
    }
    throw new SidebarError('fs-error', `cannot resolve target "${target}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
  const realCwd = await resolveRealPath(cwd, 'workspace')
  if (fence) assertWithinWorkspace(realCwd, realTarget)
  return { realCwd, realTarget }
}

/**
 * Validate a write destination, including destinations that do not exist yet.
 * Existing targets are resolved to catch symlinks; missing targets are checked
 * against the nearest existing ancestor before the caller creates or renames.
 * The returned path is rebuilt from that canonical ancestor, so an existing
 * symlink is never left in the path passed to the write operation.
 *
 * @param cwd - Session workspace directory.
 * @param target - Client-supplied absolute destination path in the session's namespace.
 * @param fence - Whether containment is enforced (the settings-page
 * `workspaceFence` switch). Resolution/canonicalization is identical either way.
 * @returns A canonical path for an existing target or its nearest existing ancestor.
 */
export async function ensureWorkspaceWritePath(cwd: string, target: string, fence = true): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const realCwd = await resolveRealPath(cwd, 'workspace')
  let existingPath = absolute
  const missingSegments: string[] = []

  for (;;) {
    try {
      const realTarget = await realpath(existingPath)
      if (fence) assertWithinWorkspace(realCwd, realTarget)
      return missingSegments.reduce((path, segment) => join(path, segment), realTarget)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SidebarError) throw error
        throw new SidebarError('fs-error', `cannot resolve target "${existingPath}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      const parent = dirname(existingPath)
      if (parent === existingPath) {
        throw new SidebarError('fs-error', `cannot resolve target "${absolute}"`, 400)
      }
      missingSegments.unshift(basename(existingPath))
      existingPath = parent
    }
  }
}
