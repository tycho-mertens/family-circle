package expo.modules.familycirclebridge

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import uniffi.crypto_core.locationCommand

/** Serialized Rust commands + atomic encrypted local vault. Never part of the
 * seed backup or Android Auto Backup. No coordinates/keys are logged. */
object LocationRuntime {
  private var loadedIdentity: String? = null
  private var vault: AtomicFile? = null
  @Volatile var statusMessage: String? = null
  fun load(context: Context, identity: String) = synchronized(ChatRuntime.lock) {
    check(!ChatRuntime.active) { "Circle sync is busy; try again shortly" }
    if (loadedIdentity == identity) return@synchronized
    val safe = identity.replace(Regex("[^a-zA-Z0-9_-]"), "")
    val file = AtomicFile(File(context.noBackupFilesDir, "location-$safe.enc"))
    val saved = ChatRuntime.locationVault(context) ?: if (ChatRuntime.allowLegacyLocations && file.baseFile.exists()) file.readFully().toString(Charsets.UTF_8) else null
    if (saved != null) {
      try { locationCommand("device", JSONObject().put("op", "import").put("vault", saved).toString()) }
      catch (_: Exception) { statusMessage = "Location sharing needs to be started again on this phone." }
    }
    loadedIdentity = identity; vault = file
  }
  fun command(command: JSONObject): String = synchronized(ChatRuntime.lock) {
    ChatRuntime.checkLocationCommand(command.optString("op"))
    check(loadedIdentity != null) { "Location state is not ready" }
    if (!command.has("now")) command.put("now", System.currentTimeMillis())
    val result = locationCommand("device", command.toString())
    // One atomic checkpoint contains both MLS and location state.
    ChatRuntime.checkpointLocation()
    result
  }
  fun resetLoaded() { loadedIdentity = null; vault = null }
  fun exportVault(): String? {
    if (loadedIdentity == null) return null
    return org.json.JSONArray("[" + locationCommand("device", "{\"op\":\"export\"}") + "]").getString(0)
  }
  fun restoreVault(saved: String?) {
    if (saved != null) locationCommand("device", JSONObject().put("op", "import").put("vault", saved).toString())
  }

  fun status(): JSONObject = JSONObject(command(JSONObject().put("op", "status")))
  fun stopAll() { command(JSONObject().put("op", "stopAll")) }
}
