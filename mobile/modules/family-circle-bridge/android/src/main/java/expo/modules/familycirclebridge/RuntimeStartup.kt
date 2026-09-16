package expo.modules.familycirclebridge

/** One bounded request waits for a usable current runtime, including cold-start
 * initialization and context replacement. The owner supplies its timeout. */
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
    // Register before reading the context to close the initialization race.
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
