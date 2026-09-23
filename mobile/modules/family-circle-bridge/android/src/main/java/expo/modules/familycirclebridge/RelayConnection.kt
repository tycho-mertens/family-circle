package expo.modules.familycirclebridge

import com.microsoft.signalr.HubConnection
import com.microsoft.signalr.HubConnectionState
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Notifications only mark dirty. All MLS mutation remains in the JS journal. */
object RelayConnection {
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private var hub: HubConnection? = null
  private var desiredUrl = ""
  private var desiredToken = ""
  private var desiredMailboxes = emptyList<String>()
  private var subscribed = emptyList<String>()
  private val backoff = RetryBackoff(1_000, 300_000)
  private var connectedAt: Long? = null
  private var retryAt = 0L
  private var retry: ScheduledFuture<*>? = null
  private var networkAvailable = true
  private val dirty = AtomicBoolean(false)
  @Volatile private var ready = false
  @Volatile private var listener: ((Boolean) -> Unit)? = null

  fun setListener(value: ((Boolean) -> Unit)?) {
    listener = value
  }

  fun isConnected(): Boolean = ready

  private fun changed() {
    dirty.set(true)
    listener?.invoke(true)
  }

  /** Use network callbacks to retry an offline connection without idle polling. */
  fun networkAvailable() {
    executor.execute {
      if (networkAvailable) return@execute
      networkAvailable = true
      scheduleConnect(remainingRetryDelay())
    }
  }

  fun networkLost() {
    executor.execute {
      val wasConnecting = hub != null
      networkAvailable = false
      disconnect()
      if (wasConnecting) {
        retryAt = android.os.SystemClock.elapsedRealtime() + backoff.nextDelay()
      }
    }
  }

  fun configure(url: String, mailboxes: List<String>, token: String) {
    require(mailboxes.size <= 100)
    executor.execute {
      val mailboxesSorted = mailboxes.distinct().sorted()
      if (url == desiredUrl && token == desiredToken && mailboxesSorted == desiredMailboxes)
        return@execute

      if (url != desiredUrl || token != desiredToken) {
        disconnect()
        desiredUrl = url
        desiredToken = token
        subscribed = emptyList()
        backoff.reset()
        retryAt = 0L
      }
      desiredMailboxes = mailboxesSorted
      if (desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) {
        disconnect()
      } else if (retry == null || ready) {
        scheduleConnect(remainingRetryDelay())
      }
    }
  }

  fun status(): Map<String, Boolean> =
    mapOf("connected" to ready, "dirty" to dirty.getAndSet(false))

  private fun remainingRetryDelay(): Long =
    (retryAt - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(0)

  private fun scheduleConnect(delayMs: Long) {
    retry?.cancel(false)
    retry = null
    if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) return
    retryAt = android.os.SystemClock.elapsedRealtime() + delayMs
    retry = executor.schedule({
      retry = null
      connect()
    }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun disconnect() {
    retry?.cancel(false)
    retry = null
    recordConnectionDuration()
    val closing = hub
    hub = null
    subscribed = emptyList()
    ready = false
    if (closing != null) {
      try {
        closing.stop().timeout(2, TimeUnit.SECONDS).blockingAwait()
      } catch (_: Exception) {
        // The connection is already detached; a failed close must not prevent retries.
      }
    }
    listener?.invoke(false)
  }

  private fun connect() {
    try {
      if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) {
        disconnect()
        return
      }
      val connection = hub ?: createConnection().also { hub = it }
      if (connection.connectionState != HubConnectionState.CONNECTED) {
        ready = false
        connection.start().blockingAwait()
        subscribed = emptyList()
      }
      if (!ready || subscribed != desiredMailboxes) {
        subscribe(connection)
      }
    } catch (error: Exception) {
      android.util.Log.w("CircleSync", "Relay connection failed; backing off", error)
      disconnect()
      scheduleRetry()
    }
  }

  private fun createConnection(): HubConnection {
    val connection = RelayHubFactory.create(desiredUrl, desiredToken)
    // Space out keepalives to reduce idle network traffic and radio wakeups.
    connection.setKeepAliveInterval(3 * 60_000L)
    connection.setServerTimeout(10 * 60_000L)
    connection.on("Changed", { _: String -> changed() }, String::class.java)
    connection.onClosed {
      executor.execute {
        if (hub === connection) {
          recordConnectionDuration()
          hub = null
          subscribed = emptyList()
          ready = false
          listener?.invoke(false)
          scheduleRetry()
        }
      }
    }
    return connection
  }

  private fun subscribe(connection: HubConnection) {
    ready = false
    val accepted = connection.invoke(
      Boolean::class.javaObjectType,
      "Subscribe",
      desiredMailboxes.toTypedArray() as Any,
    ).timeout(10, TimeUnit.SECONDS).blockingGet()
    check(accepted)
    subscribed = desiredMailboxes
    // Wait for subscription approval before requesting catch-up from saved cursors.
    ready = true
    changed()
    android.util.Log.i("CircleSync", "Relay subscriptions acknowledged; durable catch-up requested")
    if (connectedAt == null) connectedAt = android.os.SystemClock.elapsedRealtime()
    retryAt = 0L
  }

  private fun scheduleRetry() {
    if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) return
    val base = backoff.nextDelay()
    // Jitter stays inside the five-minute total cap.
    val jitter = (Math.random() * minOf(1_000L, base / 4)).toLong()
    scheduleConnect(minOf(300_000L, base + jitter))
  }

  private fun recordConnectionDuration() {
    connectedAt?.let {
      if (android.os.SystemClock.elapsedRealtime() - it >= 60_000L) backoff.reset()
    }
    connectedAt = null
  }
}
