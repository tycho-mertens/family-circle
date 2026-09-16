package expo.modules.familycirclebridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise

/** A bounded, foreground-only fix for local distance calculations. This never
 * calls LocationRuntime, writes the vault, or publishes a position. */
object DistanceLocation {
  private val handler = Handler(Looper.getMainLooper())
  private var finish: (() -> Unit)? = null
  fun cancel() { handler.post { finish?.invoke() } }
  fun request(context: Context, promise: Promise) { handler.post {
    finish?.invoke()
    val manager = context.getSystemService(LocationManager::class.java)
    val precise = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!precise && !coarse) { promise.resolve(null); return@post }
    val providers = mutableListOf<String>()
    if (precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER)
    if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER)
    if (providers.isEmpty()) { promise.resolve(null); return@post }
    var completed = false
    lateinit var listener: LocationListener
    lateinit var timeout: Runnable
    fun complete(location: Location?) {
      if (completed) return
      completed = true
      manager.removeUpdates(listener); handler.removeCallbacks(timeout); finish = null
      promise.resolve(location?.let { mapOf("latitude" to it.latitude, "longitude" to it.longitude, "accuracy" to it.accuracy.toDouble(), "observedAt" to it.time.toDouble()) })
    }
    listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        if (SystemClock.elapsedRealtime() - location.elapsedRealtimeNanos / 1_000_000 <= 45_000) complete(location)
      }
      override fun onProviderDisabled(provider: String) {}
      override fun onProviderEnabled(provider: String) {}
    }
    timeout = Runnable { complete(null) }
    finish = { complete(null) }
    try {
      providers.forEach { manager.requestLocationUpdates(it, 0L, 0f, listener, Looper.getMainLooper()) }
      handler.postDelayed(timeout, 40_000)
    } catch (_: SecurityException) { complete(null) }
  } }
}
