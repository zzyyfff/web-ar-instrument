import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * Short git SHA, injected as `__BUILD_ID__` so the running page can report
 * exactly which build it is (surfaced in the calibrator's build badge). Falls
 * back to "dev" outside a git checkout. Not app-specific — any project wants this.
 *
 * Uses execFileSync with an argument array (no shell) rather than execSync with
 * a command string: even though the argument is a hardcoded constant here, the
 * shell-free form is the pattern worth copying — it can't be turned into a
 * command-injection bug by a later edit that interpolates input.
 */
function gitBuildId(): string {
  try {
    return (
      execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || 'dev'
    )
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(gitBuildId()),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      // Multi-page: a minimal landing + the calibrator tool. No backend bundles
      // ride along — the recording/diag backend is a separate, Access-gated
      // deploy (see docs/web-ar-instrument-build-plan.md, P3).
      input: {
        main: 'index.html',
        calibrator: 'calibrator.html',
      },
    },
  },
})
