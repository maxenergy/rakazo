# RAK-31 Electron board acceptance

The pre-sign-in 401 is POST /rpc/bootstrap. The retained network trace from run 39227773142 identifies that procedure. Run 39230743383 logs the same pre-sign-in RPC 401 at 09:51:39.814Z.

Root cause: apps/web/src/lib/bootstrap.ts starts a speculative bootstrap request at module initialization. bootstrap-target.ts permits the desktop root path before authentication completes. The bootstrap procedure uses the authed middleware in apps/api/src/router.ts:819-821, which rejects a missing actor with UNAUTHORIZED. bootstrap.ts handles the speculative rejection and allows subsequent authenticated bootstrap. This is expected for a fresh disposable Electron profile; authentication remains enforced. No product change is required.

The board spec now checks for leftover Electron processes after teardown, prints the result in the step log, and saves it in main-process.log. Success requires pgrep status 1 and empty output.
