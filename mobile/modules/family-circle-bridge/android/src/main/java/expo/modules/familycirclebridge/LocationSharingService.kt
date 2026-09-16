package expo.modules.familycirclebridge

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import android.app.Service
import android.app.AlarmManager
import android.os.IBinder
import android.os.PowerManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import org.json.JSONObject

/** One bounded GPS acquisition window serves all enabled Circles. Publishing
 * checks consent and MLS epoch again in Rust, including in-flight callbacks. */
class LocationSharingService : Service(), LocationListener {
  companion object {
    @Volatile private var current: LocationSharingService? = null
    fun isRunning() = current != null
    fun runtimeReady() { current?.let { service -> service.handler.post {
      if (current === service && !service.sampling) {
        android.util.Log.i("CircleLocation", "Location runtime is ready; scheduling sampling")
        LocationRuntime.statusMessage = null
        service.sampling = true
        service.handler.removeCallbacks(service.startupTimeout)
        service.scheduleTick(0)
      }
    } } }
  }
  private var sampling = false
  private var stopping = false
  private val acquisitionBackoff = RetryBackoff(30_000, 300_000)
  private val providerChanges = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != LocationManager.PROVIDERS_CHANGED_ACTION || !sampling || stopping) return
      // The listener is removed between windows, so provider broadcasts also
      // restore sampling after location services were completely disabled.
      if (!listening) { nextFixAt = 0L; scheduleTick(0) }
    }
  }
  private val startupTimeout = Runnable { LocationRuntime.statusMessage = "Reopen Family Circle to resume sharing."; stopSelf() }
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var manager: LocationManager
  private lateinit var tasks: LocationTasks
  private lateinit var alarms: AlarmManager
  private var acquisitionLock: PowerManager.WakeLock? = null
  private var nextSyncAt = 0L
  private val wakeTick = AlarmManager.OnAlarmListener { tick.run() }
  private var started = false
  private var listening = false
  private var nextFixAt = 0L
  private var wallAnchor = System.currentTimeMillis()
  private var monoAnchor = SystemClock.elapsedRealtime()
  private val lastSample = mutableMapOf<String, Long>()
  // The native location callback can arrive during a short MLS/checkpoint
  // transaction. Keep one fresh fix instead of dropping it and waiting for
  // the next scheduled acquisition window.
  private var deferredFix: Location? = null
  private val tick = object : Runnable {
    override fun run() {
      if (stopping) return
      try {
        val deferred = synchronized(ChatRuntime.lock) {
          if (ChatRuntime.active) null else deferredFix.also { deferredFix = null }
        }
        if (deferred != null) { onLocationChanged(deferred); return }
        val now = System.currentTimeMillis()
        // A backwards wall-clock adjustment must not extend timed consent.
        if (now < wallAnchor + SystemClock.elapsedRealtime() - monoAnchor - 60_000) {
          LocationRuntime.stopAll(); LocationRuntime.statusMessage = "Sharing stopped because the phone's clock changed."
        }
        val shares = LocationRuntime.status().getJSONArray("shares")
        var active = false
        for (i in 0 until shares.length()) if (shares.getJSONObject(i).getBoolean("active")) active = true
        if (!active) { stopping = true; releaseLocation(); tasks.request(); return }
        if (SystemClock.elapsedRealtime() >= nextSyncAt) {
          nextSyncAt = SystemClock.elapsedRealtime() + 15 * 60_000
          tasks.request()
        }
        if (SystemClock.elapsedRealtime() >= nextFixAt && !listening) acquire()
      } catch (error: Exception) {
        if (error.message?.contains("Circle sync is busy") == true) { android.util.Log.i("CircleLocation", "Sampling deferred while Circle sync commits"); scheduleTick(1_000); return }
        android.util.Log.w("CircleLocation", "Location sampling stopped", error)
        LocationRuntime.statusMessage = "Location sharing is paused. Reopen the app."; stopSelf(); return
      }
      // GPS callbacks and the acquisition timeout drive the active window.
      // Between windows, wake only often enough to observe a durable remote
      // stop/expiry control rather than spinning every two seconds all day.
      val delay = if (listening) 10_000L else minOf(60_000L, maxOf(2_000L, nextFixAt - SystemClock.elapsedRealtime()))
      scheduleTick(delay)
    }
  }
  private val endWindow = Runnable {
    if (listening) {
      // This is a retry deadline, not a publication deadline. A missed
      // location must not silently move the next successful update by the
      // entire sharing interval.
      val retryDelay = acquisitionBackoff.nextDelay()
      nextFixAt = SystemClock.elapsedRealtime() + retryDelay
      android.util.Log.i("CircleLocation", "Location acquisition timed out; retrying in ${retryDelay / 1000} seconds")
      releaseLocation()
      LocationRuntime.statusMessage = "Waiting for a location fix. Your previous pin is still available."
      scheduleTick(minOf(60_000L, retryDelay))
    }
  }
  override fun onCreate() {
    super.onCreate()
    current = this
    handler.postDelayed(startupTimeout, 30_000)
    manager = getSystemService(LocationManager::class.java)
    alarms = getSystemService(AlarmManager::class.java)
    tasks = LocationTasks(this, handler) { if (stopping) stopSelf() }
    ContextCompat.registerReceiver(this, providerChanges, IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION), ContextCompat.RECEIVER_EXPORTED)
    val notifications = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(NotificationChannel("family-circle-location", "Location sharing", NotificationManager.IMPORTANCE_LOW))
    val stop = PendingIntent.getService(this, 401, Intent(this, LocationSharingService::class.java).setAction("STOP_ALL"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 402, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val notification = NotificationCompat.Builder(this, "family-circle-location")
      .setSmallIcon(applicationInfo.icon).setContentTitle("Location sharing is on")
      .setContentText("Sharing with your selected Circles").setOngoing(true)
      .setContentIntent(open).addAction(0, "Stop all sharing", stop).build()
    startForeground(1002, notification)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP_ALL") {
      stopping = true
      handler.removeCallbacks(tick)
      alarms.cancel(wakeTick)
      releaseLocation()
      fun stopWhenReady() {
        try { LocationRuntime.stopAll(); tasks.request() }
        catch (error: Exception) {
          if (error.message?.contains("Circle sync is busy") == true) handler.postDelayed({ stopWhenReady() }, 100)
          else { LocationRuntime.statusMessage = "The stop could not be saved. Reopen the app to stop sharing."; stopSelf() }
        }
      }
      stopWhenReady(); return START_NOT_STICKY
    }
    if (!started) { started = true; nextSyncAt = SystemClock.elapsedRealtime() + 15 * 60_000; tasks.request() }
    return START_STICKY
  }
  override fun onBind(intent: Intent?): IBinder? = null
  @Suppress("MissingPermission") private fun acquire() {
    val precise = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!precise && !coarse) { android.util.Log.w("CircleLocation", "No location permission; sampling paused"); LocationRuntime.statusMessage = "Location permission is off. Sharing is paused."; nextFixAt = SystemClock.elapsedRealtime() + 60_000; return }
    val providers = mutableListOf<String>()
    if (precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER)
    if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER)
    if (providers.isEmpty()) { android.util.Log.w("CircleLocation", "No enabled location providers; sampling paused"); LocationRuntime.statusMessage = "Location services are off. Your previous pin is still available."; nextFixAt = SystemClock.elapsedRealtime() + 60_000; return }
    try {
      android.util.Log.i("CircleLocation", "Requesting location from ${providers.joinToString()}")
      acquisitionLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilyCircle:location-fix").apply { acquire(45_000) }
      listening = true
      providers.forEach { manager.requestLocationUpdates(it, 0L, 0f, this, Looper.getMainLooper()) }
      handler.postDelayed(endWindow, 40_000)
    } catch (_: SecurityException) { nextFixAt = SystemClock.elapsedRealtime() + 60_000; releaseLocation(); LocationRuntime.statusMessage = "Location permission changed. Sharing is paused." }
  }
  override fun onLocationChanged(location: Location): Unit = synchronized(ChatRuntime.lock) {
    if (stopping || !listening || location.elapsedRealtimeNanos / 1_000_000 < SystemClock.elapsedRealtime() - 45_000) return
    if (ChatRuntime.active) {
      val alreadyDeferred = deferredFix != null
      deferredFix = Location(location)
      if (!alreadyDeferred) {
        android.util.Log.i("CircleLocation", "Deferring fresh fix until Circle sync commits")
        scheduleTick(1_000)
      }
      return@synchronized
    }
    acquisitionBackoff.reset()
    val shares = LocationRuntime.status().getJSONArray("shares")
    val now=System.currentTimeMillis()
    var published = false
    for (i in 0 until shares.length()) {
      val share=shares.getJSONObject(i); val circle=share.getString("circleId")
      if (!share.getBoolean("active") || SystemClock.elapsedRealtime() - (lastSample[share.getString("sessionId")] ?: -1_800_000L) < share.getLong("interval")) continue
      val fix=JSONObject().put("latitude",location.latitude).put("longitude",location.longitude).put("accuracy",location.accuracy.toDouble()).put("observedAt",location.time)
      if (share.optBoolean("reportBattery", false)) {
        val battery = registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
        if (scale > 0 && level in 0..scale) fix.put("batteryPercent", Math.round(level * 100.0 / scale).toInt())
      }
      try {
        LocationRuntime.command(JSONObject().put("op","publish").put("circleId",circle).put("fix",fix).put("now",now))
        lastSample[share.getString("sessionId")]=SystemClock.elapsedRealtime(); LocationRuntime.statusMessage=null
        published = true
      } catch (_: Exception) { LocationRuntime.statusMessage="Waiting for Circle membership to synchronize." }
    }
    // Anchor the cadence to the last accepted publication, never to merely
    // opening an acquisition window. Repeated start commands and early
    // provider callbacks can therefore no longer defer a due update.
    nextFixAt = nextPublicationDue(shares)
    if (published) {
      // The notification subscriber can be paused or denied permission.
      // This already-running location service owns delivery of its fixes.
      android.util.Log.i("CircleLocation", "Location fix queued; requesting location upload")
      tasks.request()
    }
    if (!published) android.util.Log.i("CircleLocation", "Location fix not yet due; next update window in ${(nextFixAt - SystemClock.elapsedRealtime()).coerceAtLeast(0) / 1000}s")
    releaseLocation()
    scheduleTick(minOf(60_000L, maxOf(2_000L, nextFixAt - SystemClock.elapsedRealtime())))
  }
  private fun scheduleTick(delayMs: Long) {
    handler.removeCallbacks(tick)
    alarms.cancel(wakeTick)
    if (stopping) return
    if (delayMs < 2_000 || listening) handler.postDelayed(tick, delayMs)
    else {
      // A listener alarm needs no exact-alarm special access and belongs to
      // this running foreground service. ELAPSED_REALTIME wakes a sleeping
      // CPU; Handler delays alone cannot schedule the next sampling window.
      alarms.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,
        SystemClock.elapsedRealtime() + delayMs, "FamilyCircle:location-deadline", wakeTick, handler)
    }
  }
  private fun nextPublicationDue(shares: org.json.JSONArray): Long {
    val now = SystemClock.elapsedRealtime()
    var due: Long? = null
    for (i in 0 until shares.length()) {
      val share = shares.getJSONObject(i)
      if (!share.getBoolean("active")) continue
      val last = lastSample[share.getString("sessionId")]
      val candidate = if (last == null) now else last + share.getLong("interval")
      due = if (due == null) candidate else minOf(due, candidate)
    }
    return due ?: now + 60_000
  }
  private fun releaseLocation() { acquisitionLock?.let { if (it.isHeld) it.release() }; acquisitionLock = null; deferredFix = null; handler.removeCallbacks(endWindow); if (::manager.isInitialized) manager.removeUpdates(this); listening=false }
  override fun onTaskRemoved(rootIntent: Intent?) {
    // Removing the Activity does not revoke persisted sharing consent.
    android.util.Log.i("CircleLocation", "Task removed; active sharing remains service-owned")
  }
  override fun onDestroy() { stopping = true; alarms.cancel(wakeTick); tasks.close(); unregisterReceiver(providerChanges); if (current === this) current = null; handler.removeCallbacksAndMessages(null); releaseLocation(); super.onDestroy() }
  override fun onProviderDisabled(provider: String) { }
  override fun onProviderEnabled(provider: String) { }
}
