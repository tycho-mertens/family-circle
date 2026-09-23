package expo.modules.familycirclebridge

/** Wait for the current runtime to be ready, including after a cold start or
 * context replacement. The caller is responsible for timing out and cancelling. */
internal class RuntimeStartup<T : Any>(
  private val current: () -> T?,
  private val ready: (T) -> Boolean,
  private val listen: (() -> Unit) -> Unit,
  private val unlisten: () -> Unit,
  private val startRuntime: () -> Unit,
  private val startTask: (T) -> Unit,
) {
  private var finished = false
  fun begin() {
    // Listen first so initialization cannot finish between the check and registration.
    listen { tryStart() }
    tryStart()
    if (!finished) startRuntime()
  }
  private fun tryStart() {
    if (finished) return
    val context = current() ?: return
    if (!ready(context)) return
    finished = true
    unlisten()
    startTask(context)
  }
  fun cancel() {
    finished = true
    unlisten()
  }
}
