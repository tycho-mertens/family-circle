package expo.modules.familycirclebridge

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.AtomicFile
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** Only routing metadata; never MLS state. Kept out of Android backups. */
object BackgroundNotifications {
  data class Configuration(val url: String = "", val mailboxes: List<String> = emptyList(), val token: String = "", val enabled: Boolean = true)
  private var cached: Configuration? = null
  private var restartScheduled: Boolean? = null
  @Volatile var foreground = false
  @Synchronized fun configuration(context: Context): Configuration {
    return cached ?: try {
      val json = JSONObject(String(file(context).readFully(), Charsets.UTF_8))
      val boxes = json.getJSONArray("mailboxes")
      Configuration(json.getString("url"), (0 until boxes.length()).map { boxes.getString(it) }, json.getString("token"), json.optBoolean("enabled", true))
    } catch (_: Exception) { Configuration() }.also { cached = it }
  }
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "notification-connection.json"))
  @Synchronized private fun save(context: Context, config: Configuration) {
    if (config == configuration(context)) return
    val file = file(context)
    val output = file.startWrite()
    try {
      output.write(JSONObject().put("url", config.url).put("mailboxes", JSONArray(config.mailboxes)).put("token", config.token).put("enabled",config.enabled).toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(output)
      cached = config
    } catch (error: Exception) { file.failWrite(output); throw error }
  }
  fun allowed(context: Context): Boolean {
    val channel = if (Build.VERSION.SDK_INT >= 26) context.getSystemService(NotificationManager::class.java).getNotificationChannel("circle-events") else null
    return NotificationManagerCompat.from(context).areNotificationsEnabled() && (channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE)
  }
  fun shouldRun(context: Context): Boolean {
    val config = configuration(context)
    return config.enabled && config.url.isNotEmpty() && config.mailboxes.isNotEmpty() && allowed(context)
  }
  fun configure(context: Context, url: String, mailboxes: List<String>, token: String) {
    require(mailboxes.size <= 100 && (url.isEmpty() || Uri.parse(url).scheme in listOf("https", "http")))
    save(context, configuration(context).copy(url=url, mailboxes=mailboxes.distinct().sorted(), token=token))
    ensureStarted(context)
  }
  fun setEnabled(context: Context, enabled: Boolean) {
    save(context, configuration(context).copy(enabled=enabled))
    ensureStarted(context)
  }
  fun ensureStarted(context: Context) {
    if (!shouldRun(context)) {
      context.stopService(Intent(context, SyncForegroundService::class.java))
      if (restartScheduled != false) WorkManager.getInstance(context).cancelUniqueWork("circle-notification-restart")
      restartScheduled=false
      return
    }
    if (restartScheduled != true) {
      WorkManager.getInstance(context).enqueueUniquePeriodicWork("circle-notification-restart", ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<NotificationRestartWorker>(15, TimeUnit.MINUTES).build())
      restartScheduled=true
    }
    val service = SyncForegroundService.instance
    if (service != null) { service.refreshConfiguration(); return }
    try { ContextCompat.startForegroundService(context, Intent(context, SyncForegroundService::class.java)) }
    catch (_: IllegalStateException) { android.util.Log.w("CircleSync", "Android deferred subscriber start; reopen the app or allow unrestricted battery use") }
    catch (_: SecurityException) { android.util.Log.w("CircleSync", "Subscriber start requires permission") }
  }
  fun status(context: Context): Map<String, Boolean> = mapOf(
    "allowed" to allowed(context), "enabled" to configuration(context).enabled,
    "configured" to configuration(context).mailboxes.isNotEmpty(),
    "running" to (SyncForegroundService.instance != null), "connected" to RelayConnection.isConnected(),
    "batteryUnrestricted" to context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))

  fun requestBatteryAccess(context: Context) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { context.startActivity(intent) }
    catch (_: android.content.ActivityNotFoundException) {
      context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}

class NotificationRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) {
      android.util.Log.i("CircleSync", "Restart broadcast received; listening eligible=${BackgroundNotifications.shouldRun(context)}")
      BackgroundNotifications.ensureStarted(context)
    }
  }
}
class NotificationRestartWorker(context: Context, params: WorkerParameters) : Worker(context,params) {
  override fun doWork(): Result {
    BackgroundNotifications.ensureStarted(applicationContext)
    return Result.success()
  }
}
