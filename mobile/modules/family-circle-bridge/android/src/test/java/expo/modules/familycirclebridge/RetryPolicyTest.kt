package expo.modules.familycirclebridge

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Delayed
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class RetryPolicyTest {
  @Test fun relayFailuresReachAndStayAtFiveMinutes() {
    val retry = RetryBackoff(1_000, 300_000)
    assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 64_000L, 128_000L, 256_000L, 300_000L), List(10) { retry.nextDelay() })
    repeat(100) { assertEquals(300_000L, retry.nextDelay()) }
    retry.reset()
    assertEquals(1_000L, retry.nextDelay())
  }

  @Test fun gpsFailureBudgetAndSuccessfulFixRecovery() {
    val retry = RetryBackoff(30_000, 300_000)
    assertEquals(listOf(30_000L, 60_000L, 120_000L, 240_000L, 300_000L, 300_000L), List(6) { retry.nextDelay() })
    retry.reset()
    assertEquals(30_000L, retry.nextDelay())
  }

  private fun field(name: String) = RelayConnection::class.java.getDeclaredField(name).apply { isAccessible = true }
  private fun set(name: String, value: Any?) = field(name).set(null, value)
  private fun get(name: String): Any? = field(name).get(null)
  private val executor get() = get("executor") as ScheduledExecutorService
  private fun drain() { executor.submit {}.get(5, TimeUnit.SECONDS) }
  private fun reset() {
    RelayConnection.configure("", emptyList(), "")
    drain()
    set("networkAvailable", true)
    set("desiredUrl", "https://relay.invalid/sync")
    set("desiredToken", "test")
    set("desiredMailboxes", listOf("a", "b"))
    set("ready", false)
    set("connectedAt", null)
    set("retryAt", 123_000L)
    (get("backoff") as RetryBackoff).reset()
  }
  private class Pending : ScheduledFuture<Unit> {
    var cancelled = false
    override fun cancel(interrupt: Boolean): Boolean { cancelled = true; return true }
    override fun isCancelled() = cancelled
    override fun isDone() = false
    override fun get() = Unit
    override fun get(timeout: Long, unit: TimeUnit) = Unit
    override fun getDelay(unit: TimeUnit) = unit.convert(123_000, TimeUnit.MILLISECONDS)
    override fun compareTo(other: Delayed) = 0
  }

  @Test fun frequentConfigurationAndAvailabilityDoNotCancelOutageRetry() {
    reset()
    val pending = Pending()
    set("retry", pending)
    try {
      repeat(50) {
        RelayConnection.configure("https://relay.invalid/sync", listOf("b", "a", "a"), "test")
        RelayConnection.networkAvailable()
      }
      drain()
      assertSame(pending, get("retry"))
      assertFalse(pending.cancelled)
      assertEquals(123_000L, get("retryAt"))
      // A membership change during the outage uses the existing deadline too.
      RelayConnection.configure("https://relay.invalid/sync", listOf("c"), "test")
      drain()
      assertSame(pending, get("retry"))
      assertEquals(listOf("c"), get("desiredMailboxes"))
    } finally { RelayConnection.configure("", emptyList(), ""); drain() }
  }

  @Test fun networkLossKeepsPendingDeadlineAndFailureHistory() {
    reset()
    val backoff = get("backoff") as RetryBackoff
    backoff.nextDelay()
    set("retry", Pending())
    try {
      RelayConnection.networkLost()
      drain()
      assertEquals(123_000L, get("retryAt"))
      assertEquals(2_000L, backoff.nextDelay())
      assertNull(get("retry"))
    } finally { RelayConnection.configure("", emptyList(), ""); drain() }
  }

  @Test fun onlyStableConnectionsResetFailureHistory() {
    reset()
    val backoff = get("backoff") as RetryBackoff
    val record = RelayConnection::class.java.getDeclaredMethod("recordConnectionDuration").apply { isAccessible = true }
    // Android's local-unit-test clock is zero; negative starts model elapsed duration.
    executor.submit {
      backoff.nextDelay()
      set("connectedAt", -59_999L)
      record.invoke(RelayConnection)
      assertEquals(2_000L, backoff.nextDelay())
      set("connectedAt", -60_000L)
      record.invoke(RelayConnection)
      assertEquals(1_000L, backoff.nextDelay())
    }.get(5, TimeUnit.SECONDS)
    RelayConnection.configure("", emptyList(), "")
    drain()
  }
}
