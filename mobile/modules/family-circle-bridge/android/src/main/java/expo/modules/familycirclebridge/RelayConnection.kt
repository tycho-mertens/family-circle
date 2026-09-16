package expo.modules.familycirclebridge

import com.microsoft.signalr.HubConnection
import com.microsoft.signalr.HubConnectionBuilder
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
  fun setListener(value: ((Boolean) -> Unit)?) { listener = value }
  fun isConnected(): Boolean = ready
  private fun changed() { dirty.set(true); listener?.invoke(true) }
  /** Use network callbacks to retry an offline connection without idle polling. */
  fun networkAvailable() { executor.execute {
    if (networkAvailable) return@execute
    networkAvailable = true
    scheduleConnect((retryAt - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(0))
  } }
  fun networkLost() { executor.execute {
    val wasConnecting = hub != null
    networkAvailable = false
    disconnect()
    if (wasConnecting) retryAt = android.os.SystemClock.elapsedRealtime() + backoff.nextDelay()
  } }

  fun configure(url: String, mailboxes: List<String>, token: String) {
    require(mailboxes.size <= 100)
    executor.execute {
      val mailboxesSorted = mailboxes.distinct().sorted()
      if (url == desiredUrl && token == desiredToken && mailboxesSorted == desiredMailboxes) return@execute
      if (url != desiredUrl || token != desiredToken) {
        disconnect()
        desiredUrl = url
        desiredToken = token
        subscribed = emptyList()
        backoff.reset()
        retryAt = 0L
      }
      desiredMailboxes = mailboxesSorted
      if (desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) disconnect()
      else if (retry == null || ready) scheduleConnect((retryAt - android.os.SystemClock.elapsedRealtime()).coerceAtLeast(0))
    }
  }
  fun status(): Map<String, Boolean> = mapOf("connected" to ready, "dirty" to dirty.getAndSet(false))

  private fun scheduleConnect(delayMs: Long) {
    retry?.cancel(false); retry = null
    if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) return
    retryAt = android.os.SystemClock.elapsedRealtime() + delayMs
    retry = executor.schedule({ retry = null; connect() }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun disconnect() {
    retry?.cancel(false); retry = null
    recordConnectionDuration()
    val closing = hub
    hub = null
    subscribed = emptyList()
    ready = false
    if (closing != null) try { closing.stop().timeout(2, TimeUnit.SECONDS).blockingAwait() } catch (_: Exception) { }
    listener?.invoke(false)
  }

  private fun connect() {
    try {
      if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) { disconnect(); return }
      val connection = hub ?: RelayHubFactory.create(desiredUrl, desiredToken).also { next ->
        // SignalR defaults to 15 seconds. That prevents Wi-Fi and cellular
        // radios from sleeping and was the dominant idle traffic source.
        next.setKeepAliveInterval(3 * 60_000L)
        next.setServerTimeout(10 * 60_000L)
        next.on("Changed", { _: String -> changed() }, String::class.java)
        next.onClosed {
          executor.execute {
            if (hub === next) {
              recordConnectionDuration()
              hub = null; subscribed = emptyList(); ready = false
              listener?.invoke(false)
              scheduleRetry()
            }
          }
        }
        hub = next
      }
      if (connection.connectionState != HubConnectionState.CONNECTED) {
        ready = false
        connection.start().blockingAwait()
        subscribed = emptyList()
      }
      if (!ready || subscribed != desiredMailboxes) {
        ready = false
        val accepted = connection.invoke(Boolean::class.javaObjectType, "Subscribe", desiredMailboxes.toTypedArray() as Any)
          .timeout(10, TimeUnit.SECONDS).blockingGet()
        check(accepted)
        subscribed = desiredMailboxes
        // ACK precedes catch-up. Reconnect always reconciles durable cursors.
        ready = true
        changed()
        android.util.Log.i("CircleSync", "Relay subscriptions acknowledged; durable catch-up requested")
        if (connectedAt == null) connectedAt = android.os.SystemClock.elapsedRealtime()
        retryAt = 0L
      }
    } catch (error: Exception) {
      android.util.Log.w("CircleSync", "Relay connection failed; backing off", error)
      disconnect()
      scheduleRetry()
    }
  }
  private fun scheduleRetry() {
    if (!networkAvailable || desiredUrl.isEmpty() || desiredMailboxes.isEmpty()) return
    val base = backoff.nextDelay()
    // Jitter stays inside the five-minute total cap.
    scheduleConnect(minOf(300_000L, base + (Math.random() * minOf(1_000L, base / 4)).toLong()))
  }
  private fun recordConnectionDuration() {
    connectedAt?.let {
      if (android.os.SystemClock.elapsedRealtime() - it >= 60_000L) backoff.reset()
    }
    connectedAt = null
  }
}
