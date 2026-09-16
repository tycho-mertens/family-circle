package expo.modules.familycirclebridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID

/** Persistent direct subscriber. JS and its wake lock run only for bounded catch-up. */
class SyncForegroundService : Service() {
  companion object {
    const val CHANNEL_ID = "circle-connection"
    private const val NOTIFICATION_ID = 1001
    private const val PAUSE = "familycircle.notifications.PAUSE"
    @Volatile var instance: SyncForegroundService? = null
      private set
  }
  private val handler = Handler(Looper.getMainLooper())
  private var currentRequest: String? = null
  private var taskId: Int? = null
  private var taskContext: HeadlessJsTaskContext? = null
  private var reactListener: ReactInstanceEventListener? = null
  private var startup: RuntimeStartup<ReactContext>? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var syncPending = true
  private var lastSync = 0L
  private var lastStatus = ""
  private var registeredNetwork = false
  private var destroyed = false
  private val host get() = (application as ReactApplication).reactHost!!
  private val connectivity get() = getSystemService(ConnectivityManager::class.java)
  private val networkListener = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) { RelayConnection.networkAvailable(); handler.post { syncPending=true; refreshStatus(); requestSync() } }
    override fun onLost(network: Network) { RelayConnection.networkLost(); handler.post { refreshStatus() } }
  }
  private val timeout = Runnable { finishSync(currentRequest, false, true) }
  private val check = object : Runnable {
    override fun run() {
      if (destroyed) return
      if (!BackgroundNotifications.shouldRun(this@SyncForegroundService)) { stopSelf(); return }
      refreshStatus()
      // Hints and network callbacks already request immediate sync. This is
      // only a loss-recovery reconciliation, not a minute-by-minute poll.
      if (syncPending || android.os.SystemClock.elapsedRealtime()-lastSync >= 15 * 60_000) requestSync()
      handler.postDelayed(this, 15 * 60_000)
    }
  }
  override fun onCreate() {
    super.onCreate()
    startForeground(NOTIFICATION_ID, buildNotification("Connecting to your Circle server"))
    instance = this
    RelayConnection.setListener { changed -> handler.post {
      if (!destroyed) { refreshStatus(); if (changed) { syncPending=true; requestSync() } }
    } }
    try { connectivity.registerDefaultNetworkCallback(networkListener); registeredNetwork=true } catch (_: Exception) { }
    refreshConfiguration()
    handler.post(check)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == PAUSE) { BackgroundNotifications.setEnabled(this,false); stopSelf(); return START_NOT_STICKY }
    if (!BackgroundNotifications.shouldRun(this)) { stopSelf(); return START_NOT_STICKY }
    refreshConfiguration()
    return START_STICKY
  }
  fun refreshConfiguration() { handler.post {
    if (destroyed) return@post
    if (!BackgroundNotifications.shouldRun(this)) { stopSelf(); return@post }
    val config = BackgroundNotifications.configuration(this)
    RelayConnection.configure(config.url, config.mailboxes, config.token)
  } }
  /** A native location fix has been checkpointed. Request JS catch-up immediately. */
  fun requestLocationUpload() { handler.post {
    if (destroyed) return@post
    android.util.Log.i("CircleLocation", "Location fix queued; requesting immediate background upload")
    syncPending = true
    requestSync()
  } }
  override fun onBind(intent: Intent?): IBinder? = null
  private fun requestSync() {
    if (destroyed || currentRequest != null || connectivity.activeNetwork == null) return
    syncPending=false
    lastSync=android.os.SystemClock.elapsedRealtime()
    val id=UUID.randomUUID().toString()
    currentRequest=id
    wakeLock=getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FamilyCircle:notification-sync").apply { acquire(35_000) }
    handler.postDelayed(timeout,30_000)
    fun start(context: ReactContext) {
      if (destroyed || currentRequest != id || taskId != null) return
      try {
        taskContext=HeadlessJsTaskContext.getInstance(context)
        taskId=taskContext!!.startTask(HeadlessJsTaskConfig("FamilyCircleSubscriberSync",Arguments.createMap().apply { putString("requestId",id) },25_000,true))
      } catch (_: Exception) { finishSync(id,false) }
    }
    try {
      startup = RuntimeStartup(
        current = { host.currentReactContext },
        ready = { it.hasActiveReactInstance() },
        listen = { initialized ->
          reactListener = object : ReactInstanceEventListener {
            override fun onReactContextInitialized(context: ReactContext) {
              handler.post { initialized() }
            }
          }.also { host.addReactInstanceEventListener(it) }
        },
        unlisten = {
          reactListener?.let { host.removeReactInstanceEventListener(it) }
          reactListener = null
        },
        startRuntime = { host.start(); Unit },
        startTask = { start(it) },
      )
      startup!!.begin()
    } catch (_: Exception) { finishSync(id,false) }
  }
  fun completed(requestId: String, success: Boolean) { handler.post { finishSync(requestId,success) } }
  private fun finishSync(requestId: String?, success: Boolean, cancel: Boolean=false) {
    if (requestId == null || requestId != currentRequest) return
    handler.removeCallbacks(timeout)
    startup?.cancel(); startup=null
    reactListener?.let { host.removeReactInstanceEventListener(it) }; reactListener=null
    if (cancel) taskId?.let { if (taskContext?.isTaskRunning(it)==true) taskContext?.finishTask(it) }
    currentRequest=null; taskId=null; taskContext=null
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock=null
    if (!success) syncPending=true
    // A hint arriving during a successful pass must not be lost behind its cursor.
    if (success && syncPending) handler.postDelayed({ requestSync() },250)
  }
  private fun refreshStatus() {
    val status=if (connectivity.activeNetwork == null) "Waiting for a connection" else if (RelayConnection.isConnected()) "Connected · Listening for Circle activity" else "Reconnecting to your Circle server"
    if (status != lastStatus) {
      lastStatus=status
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID,buildNotification(status))
    }
  }
  private fun buildNotification(status: String): Notification {
    val manager=getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID)==null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID,"Background connection",NotificationManager.IMPORTANCE_LOW).apply {
        description="Keeps messages and location-sharing alerts arriving when Family Circle is closed."
        setShowBadge(false)
      })
    }
    val launch=packageManager.getLaunchIntentForPackage(packageName)
    val open=launch?.let { PendingIntent.getActivity(this,0,it,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val pause=PendingIntent.getService(this,1,Intent(this,SyncForegroundService::class.java).setAction(PAUSE),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this,CHANNEL_ID).setContentTitle("Family Circle").setContentText(status)
      .setSmallIcon(applicationInfo.icon).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW).addAction(0,"Pause notifications",pause).build()
  }
  override fun onDestroy() {
    destroyed=true
    if (instance === this) instance=null
    handler.removeCallbacksAndMessages(null)
    RelayConnection.setListener(null)
    if (registeredNetwork) connectivity.unregisterNetworkCallback(networkListener)
    finishSync(currentRequest,false,true)
    if (!BackgroundNotifications.foreground) RelayConnection.configure("",emptyList(),"")
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
}
