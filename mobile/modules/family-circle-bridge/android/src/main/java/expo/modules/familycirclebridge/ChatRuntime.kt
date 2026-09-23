package expo.modules.familycirclebridge

import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import java.io.File
import org.json.JSONObject
import uniffi.crypto_core.exportEncryptedState
import uniffi.crypto_core.importEncryptedState

/**
 * The local checkpoint is separate from seed backups and Android Auto Backup. One atomic file
 * contains encrypted MLS/app state and the encrypted location vault. No envelope may be uploaded
 * until its state transaction commits. LocationRuntime uses this same monitor, including from the
 * native service.
 */
object ChatRuntime {
  val lock = Any()
  private var file: AtomicFile? = null
  private var key: ByteArray? = null
  private var metadata = byteArrayOf()
  private var rollback: ByteArray? = null
  private var rollbackLocation: String? = null
  var active = false
    private set

  private var failed = false
  private var savedLocations: String? = null
  var allowLegacyLocations = true
    private set

  fun read(context: Context): ByteArray? =
    synchronized(lock) {
      val target = AtomicFile(File(context.noBackupFilesDir, "chat-state-v1.json"))
      if (!target.baseFile.exists()) return@synchronized null
      val container = JSONObject(target.readFully().toString(Charsets.UTF_8))
      Base64.decode(container.getString("state"), Base64.NO_WRAP)
    }

  fun locationVault(context: Context): String? =
    synchronized(lock) {
      val target = AtomicFile(File(context.noBackupFilesDir, "chat-state-v1.json"))
      if (!target.baseFile.exists()) return@synchronized null
      JSONObject(target.readFully().toString(Charsets.UTF_8)).optString("locations").takeIf {
        it.isNotEmpty()
      }
    }

  fun configure(
    context: Context,
    encKey: ByteArray,
    appMetadata: ByteArray,
    preserveLocations: Boolean,
  ) =
    synchronized(lock) {
      check(!active) { "A chat transaction is already active" }
      savedLocations = if (preserveLocations) locationVault(context) else null
      allowLegacyLocations = preserveLocations
      LocationRuntime.resetLoaded()
      file = AtomicFile(File(context.noBackupFilesDir, "chat-state-v1.json"))
      key = encKey.copyOf()
      metadata = appMetadata.copyOf()
      failed = false
    }

  fun begin() =
    synchronized(lock) {
      check(!active && !failed) { "Chat storage is not ready. Restart the app." }
      rollback = exportEncryptedState("device", checkNotNull(key), metadata)
      rollbackLocation = LocationRuntime.exportVault()
      active = true
    }

  fun commit(appMetadata: ByteArray): ByteArray =
    synchronized(lock) {
      check(active)
      val sealed = persist(appMetadata)
      metadata = appMetadata.copyOf()
      active = false
      rollback = null
      rollbackLocation = null
      sealed
    }

  fun abort() =
    synchronized(lock) {
      check(active)
      try {
        importEncryptedState("device", checkNotNull(key), checkNotNull(rollback))
        LocationRuntime.restoreVault(rollbackLocation)
      } catch (error: Exception) {
        failed = true
        throw error
      } finally {
        active = false
        rollback = null
        rollbackLocation = null
      }
    }

  /**
   * Native location changes also consume MLS ratchets. Save those before returning a control
   * envelope to JS, using the last committed app metadata.
   */
  fun checkpointLocation() =
    synchronized(lock) {
      check(!failed && key != null) { "Chat storage is not ready" }
      if (!active) {
        try {
          persist(metadata)
        } catch (error: Exception) {
          failed = true
          throw error
        }
      }
    }

  fun checkLocationCommand(op: String) =
    synchronized(lock) {
      check(!failed && key != null) { "Chat storage is not ready" }
      // Starting or reconciling sharing requires settled membership state.
      if (op == "start" || op == "reconcile") {
        val circles = JSONObject(metadata.toString(Charsets.UTF_8)).optJSONArray("circles")
        if (circles != null)
          for (index in 0 until circles.length()) {
            if (circles.getJSONObject(index).optString("pendingCommitEventId").isNotEmpty())
              throw CircleSyncBusyException()
            check(
              circles.getJSONObject(index).optString("role", "member") != "member" ||
                !circles.getJSONObject(index).optBoolean("recoveryRequired")
            ) {
              "Reconnect your Circles before starting location sharing"
            }
          }
      }
      // Incoming controls and stop commands may run inside a JS chat transaction.
      if (active && op != "control" && op != "stop") throw CircleSyncBusyException()
    }

  private fun persist(appMetadata: ByteArray): ByteArray {
    val sealed = exportEncryptedState("device", checkNotNull(key), appMetadata)
    val container = JSONObject().put("state", Base64.encodeToString(sealed, Base64.NO_WRAP))
    (LocationRuntime.exportVault() ?: savedLocations)?.let { container.put("locations", it) }
    val target = checkNotNull(file)
    val output = target.startWrite()
    try {
      output.write(container.toString().toByteArray(Charsets.UTF_8))
      target.finishWrite(output)
    } catch (error: Exception) {
      target.failWrite(output)
      throw error
    }
    return sealed
  }
}
