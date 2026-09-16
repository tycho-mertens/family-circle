package expo.modules.familycirclebridge

/** Bounded retries without overflow, shared by transport and GPS failure paths. */
internal class RetryBackoff(private val initialMs: Long, private val maximumMs: Long) {
  private var delayMs = initialMs
  init { require(initialMs > 0 && maximumMs >= initialMs) }
  fun nextDelay(): Long {
    val result = delayMs
    delayMs = if (delayMs >= maximumMs / 2) maximumMs else delayMs * 2
    return result
  }
  fun reset() { delayMs = initialMs }
}
