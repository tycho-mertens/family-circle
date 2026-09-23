package expo.modules.familycirclebridge

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import uniffi.crypto_core.EncryptedEnvelope as RustEnvelope
import uniffi.crypto_core.addMember
import uniffi.crypto_core.adoptMembershipAdmin
import uniffi.crypto_core.commitPendingProposals
import uniffi.crypto_core.computeBackupProof
import uniffi.crypto_core.createCircle
import uniffi.crypto_core.createIdentity
import uniffi.crypto_core.createIdentityFromSeedPhrase
import uniffi.crypto_core.createKeyPackage
import uniffi.crypto_core.createWelcome
import uniffi.crypto_core.decryptEvent
import uniffi.crypto_core.deriveBackupCredentialsFromSeedPhrase
import uniffi.crypto_core.encryptEvent
import uniffi.crypto_core.exportEncryptedState
import uniffi.crypto_core.forgetCircle
import uniffi.crypto_core.generateSeedPhrase
import uniffi.crypto_core.importEncryptedState
import uniffi.crypto_core.joinFromWelcome
import uniffi.crypto_core.joinFromWelcomeWithAdmin
import uniffi.crypto_core.keyPackageIdentity
import uniffi.crypto_core.listMembers
import uniffi.crypto_core.openInviteRequest
import uniffi.crypto_core.processCommit
import uniffi.crypto_core.processProposal
import uniffi.crypto_core.proposeLeave
import uniffi.crypto_core.randomBytes
import uniffi.crypto_core.removeMember
import uniffi.crypto_core.sealInviteRequest

/**
 * Android bindings for crypto-core, local checkpoints, location, and notifications. Cryptographic
 * operations delegate to the UniFFI bindings. Identity calls use deviceSlot; Android services are
 * process-wide. UniFFI records are converted to plain maps for the Expo bridge. Notification
 * content is produced locally after decryption by the shared runtime.
 */
class FamilyCircleBridgeModule : Module() {
  companion object {
    // Decrypted message alerts use a separate channel from the silent foreground service.
    private const val EVENTS_CHANNEL_ID = "circle-events"
    private val nextNotificationId = java.util.concurrent.atomic.AtomicInteger(10000)
  }

  override fun definition() = ModuleDefinition {
    Name("FamilyCircleBridge")
    Function("backgroundNotificationStatus") {
      BackgroundNotifications.status(requireNotNull(appContext.reactContext))
    }
    Function("configureBackgroundNotifications") {
      url: String,
      mailboxes: List<String>,
      token: String ->
      BackgroundNotifications.configure(
        requireNotNull(appContext.reactContext),
        url,
        mailboxes,
        token,
      )
    }
    Function("setBackgroundNotificationsEnabled") { enabled: Boolean ->
      BackgroundNotifications.setEnabled(requireNotNull(appContext.reactContext), enabled)
    }
    Function("requestNotificationBatteryAccess") {
      BackgroundNotifications.requestBatteryAccess(requireNotNull(appContext.reactContext))
    }
    Function("setAppForeground") { foreground: Boolean ->
      BackgroundNotifications.foreground = foreground
      if (!foreground && SyncForegroundService.instance == null)
        RelayConnection.configure("", emptyList(), "")
    }
    Function("completeSubscriberSync") { requestId: String, success: Boolean ->
      SyncForegroundService.instance?.completed(requestId, success)
      Unit
    }
    Function("configureRelayConnection") { url: String, mailboxes: List<String>, token: String ->
      RelayConnection.configure(url, mailboxes, token)
    }
    Function("relayConnectionStatus") { RelayConnection.status() }
    AsyncFunction("saveSeedPhraseToDownloads") { phrase: String ->
      val context = requireNotNull(appContext.reactContext)
      val values =
        ContentValues().apply {
          put(MediaStore.Downloads.DISPLAY_NAME, "family-circle-recovery-phrase.txt")
          put(MediaStore.Downloads.MIME_TYPE, "text/plain")
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
          }
        }
      val uri =
        context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
          ?: throw IllegalStateException("Couldn't create the recovery-phrase download.")
      try {
        context.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8).use { writer
          ->
          if (writer == null)
            throw IllegalStateException("Couldn't write the recovery-phrase download.")
          writer.write(phrase)
          writer.newLine()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          context.contentResolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
            null,
            null,
          )
        }
      } catch (error: Throwable) {
        context.contentResolver.delete(uri, null, null)
        throw error
      }
    }

    AsyncFunction("readChatState") { ChatRuntime.read(requireNotNull(appContext.reactContext)) }
    AsyncFunction("configureChatState") {
      encKey: ByteArray,
      metadata: ByteArray,
      preserveLocations: Boolean ->
      ChatRuntime.configure(
        requireNotNull(appContext.reactContext),
        encKey,
        metadata,
        preserveLocations,
      )
    }
    AsyncFunction("beginChatTransaction") { ChatRuntime.begin() }
    AsyncFunction("commitChatTransaction") { metadata: ByteArray -> ChatRuntime.commit(metadata) }
    AsyncFunction("abortChatTransaction") { ChatRuntime.abort() }

    AsyncFunction("createIdentity") { deviceSlot: String ->
      val identity = createIdentity(deviceSlot)
      mapOf("deviceId" to identity.deviceId)
    }

    AsyncFunction("createCircle") { deviceSlot: String ->
      val circle = createCircle(deviceSlot)
      mapOf("circleId" to circle.circleId)
    }

    AsyncFunction("createKeyPackage") { deviceSlot: String -> createKeyPackage(deviceSlot) }
    AsyncFunction("keyPackageIdentity") { deviceSlot: String, keyPackage: ByteArray ->
      keyPackageIdentity(deviceSlot, keyPackage)
    }

    AsyncFunction("sealInviteRequest") {
      inviteNonce: String,
      circleId: String,
      mailboxId: String,
      kind: String,
      payload: ByteArray ->
      sealInviteRequest(inviteNonce, circleId, mailboxId, kind, payload)
    }

    AsyncFunction("openInviteRequest") {
      inviteNonce: String,
      circleId: String,
      mailboxId: String,
      kind: String,
      sealed: ByteArray ->
      openInviteRequest(inviteNonce, circleId, mailboxId, kind, sealed)
    }

    AsyncFunction("addMember") { deviceSlot: String, circleId: String, memberKeyPackage: ByteArray
      ->
      val commit = addMember(deviceSlot, circleId, memberKeyPackage)
      mapOf("commitBytes" to commit.commitBytes)
    }

    AsyncFunction("refreshCircleKeys") { deviceSlot: String, circleId: String ->
      val commit = uniffi.crypto_core.refreshCircleKeys(deviceSlot, circleId)
      mapOf("commitBytes" to commit.commitBytes)
    }

    AsyncFunction("prepareMembershipChange") {
      deviceSlot: String,
      circleId: String,
      keyPackage: ByteArray,
      removeIds: List<String> ->
      val change =
        uniffi.crypto_core.prepareMembershipChange(deviceSlot, circleId, keyPackage, removeIds)
      mapOf("commitBytes" to change.commitBytes, "welcomeBytes" to change.welcomeBytes)
    }
    AsyncFunction("circlePublicationState") { deviceSlot: String, circleId: String ->
      val state = uniffi.crypto_core.circlePublicationState(deviceSlot, circleId)
      mapOf("epoch" to state.epoch.toLong(), "pendingCommit" to state.pendingCommit)
    }
    AsyncFunction("processLeave") { deviceSlot: String, circleId: String, proposal: ByteArray ->
      withCryptoErrors { uniffi.crypto_core.processLeave(deviceSlot, circleId, proposal) }
    }

    AsyncFunction("processCommit") { deviceSlot: String, circleId: String, commit: ByteArray ->
      withCryptoErrors { processCommit(deviceSlot, circleId, commit) }
    }

    AsyncFunction("createWelcome") {
      deviceSlot: String,
      circleId: String,
      memberKeyPackage: ByteArray ->
      createWelcome(deviceSlot, circleId, memberKeyPackage)
    }

    AsyncFunction("joinFromWelcome") { deviceSlot: String, welcome: ByteArray ->
      joinFromWelcome(deviceSlot, welcome)
    }

    AsyncFunction("joinFromWelcomeWithAdmin") {
      deviceSlot: String,
      welcome: ByteArray,
      administrator: String ->
      joinFromWelcomeWithAdmin(deviceSlot, welcome, administrator)
    }

    AsyncFunction("adoptMembershipAdmin") {
      deviceSlot: String,
      circleId: String,
      currentAdmin: String,
      nextAdmin: String ->
      adoptMembershipAdmin(deviceSlot, circleId, currentAdmin, nextAdmin)
    }

    AsyncFunction("removeMember") { deviceSlot: String, circleId: String, memberId: String ->
      val commit = removeMember(deviceSlot, circleId, memberId)
      mapOf("commitBytes" to commit.commitBytes)
    }

    AsyncFunction("encryptEvent") { deviceSlot: String, circleId: String, payload: ByteArray ->
      val envelope = encryptEvent(deviceSlot, circleId, payload)
      envelopeToMap(envelope)
    }

    // Use top-level ByteArray arguments. Expo/JSI fails to convert nested Uint8Arrays
    // in a generic Map on repeated calls.
    AsyncFunction("decryptEvent") {
      deviceSlot: String,
      circleId: String,
      eventId: String,
      epoch: Long,
      nonce: ByteArray,
      ciphertext: ByteArray ->
      val result = withCryptoErrors {
        decryptEvent(
          deviceSlot,
          circleId,
          RustEnvelope(eventId, epoch.toULong(), nonce, ciphertext),
        )
      }
      mapOf("senderDeviceId" to result.senderDeviceId, "plaintext" to result.plaintext)
    }

    AsyncFunction("loadLocations") { identity: String ->
      LocationRuntime.load(requireNotNull(appContext.reactContext), identity)
    }
    AsyncFunction("locationCommand") { command: String ->
      withCryptoErrors { LocationRuntime.command(org.json.JSONObject(command)) }
    }
    Function("locationRuntimeReady") { LocationSharingService.runtimeReady() }
    Function("locationStatusMessage") { LocationRuntime.statusMessage }
    Function("locationServiceRunning") { LocationSharingService.isRunning() }
    Function("startLocationService") {
      val context = requireNotNull(appContext.reactContext)
      ContextCompat.startForegroundService(
        context,
        Intent(context, LocationSharingService::class.java),
      )
    }
    Function("getThemePreference") {
      requireNotNull(appContext.reactContext)
        .getSharedPreferences("display-preferences", 0)
        .getString("theme", "system")
    }
    Function("setThemePreference") { theme: String ->
      require(theme == "system" || theme == "light" || theme == "dark")
      check(
        requireNotNull(appContext.reactContext)
          .getSharedPreferences("display-preferences", 0)
          .edit()
          .putString("theme", theme)
          .commit()
      ) {
        "Appearance could not be saved"
      }
    }
    Function("getDistanceUnit") {
      requireNotNull(appContext.reactContext)
        .getSharedPreferences("display-preferences", 0)
        .getString("distance-unit", "km")
    }
    Function("setDistanceUnit") { unit: String ->
      require(unit == "km" || unit == "mi")
      check(
        requireNotNull(appContext.reactContext)
          .getSharedPreferences("display-preferences", 0)
          .edit()
          .putString("distance-unit", unit)
          .commit()
      ) {
        "Distance preference could not be saved"
      }
    }
    AsyncFunction("getDistanceLocation") { promise: expo.modules.kotlin.Promise ->
      DistanceLocation.request(requireNotNull(appContext.reactContext), promise)
    }
    Function("cancelDistanceLocation") { DistanceLocation.cancel() }
    Function("locationSettingsStatus") {
      val context = requireNotNull(appContext.reactContext)
      val manager = context.getSystemService(android.location.LocationManager::class.java)
      val notifications = context.getSystemService(NotificationManager::class.java)
      val channel =
        if (Build.VERSION.SDK_INT >= 26)
          notifications.getNotificationChannel("family-circle-location")
        else null
      mapOf(
        "precise" to
          (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED),
        "approximate" to
          (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED),
        "locationEnabled" to
          androidx.core.location.LocationManagerCompat.isLocationEnabled(manager),
        "notifications" to
          (NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE)),
        "batteryUnrestricted" to
          context
            .getSystemService(android.os.PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName),
      )
    }
    Function("openLocationSettings") { target: String ->
      val context = requireNotNull(appContext.reactContext)
      val intent =
        when (target) {
          "location" -> Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
          "battery" -> Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
          "notifications" ->
            if (Build.VERSION.SDK_INT >= 26)
              Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
            else
              Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                android.net.Uri.parse("package:" + context.packageName),
              )
          else ->
            Intent(
              android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
              android.net.Uri.parse("package:" + context.packageName),
            )
        }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    AsyncFunction("requestLocationPermission") { promise: expo.modules.kotlin.Promise ->
      val permissions = appContext.permissions
      if (permissions == null) {
        promise.resolve(false)
      } else
        permissions.askForPermissions(
          { responses ->
            promise.resolve(responses.values.any { it.status == PermissionsStatus.GRANTED })
          },
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION,
        )
    }

    AsyncFunction("listMembers") { deviceSlot: String, circleId: String ->
      listMembers(deviceSlot, circleId)
    }

    // Clear stale group state before accepting a rejoin Welcome. OpenMLS cannot
    // create a group while the same GroupId is still stored. See forget_circle
    // in crypto-core/src/lib.rs and handleWelcome in src/runtime/control-handler.ts.
    AsyncFunction("forgetCircle") { deviceSlot: String, circleId: String ->
      forgetCircle(deviceSlot, circleId)
    }

    AsyncFunction("proposeLeave") { deviceSlot: String, circleId: String ->
      proposeLeave(deviceSlot, circleId)
    }

    AsyncFunction("processProposal") { deviceSlot: String, circleId: String, proposal: ByteArray ->
      processProposal(deviceSlot, circleId, proposal)
    }

    AsyncFunction("commitPendingProposals") { deviceSlot: String, circleId: String ->
      val commit = commitPendingProposals(deviceSlot, circleId)
      mapOf("commitBytes" to commit.commitBytes)
    }

    AsyncFunction("exportEncryptedState") {
      deviceSlot: String,
      encKey: ByteArray,
      appMetadata: ByteArray ->
      exportEncryptedState(deviceSlot, encKey, appMetadata)
    }

    AsyncFunction("importEncryptedState") { deviceSlot: String, encKey: ByteArray, state: ByteArray
      ->
      val imported = importEncryptedState(deviceSlot, encKey, state)
      mapOf("deviceId" to imported.identity.deviceId, "appMetadata" to imported.appMetadata)
    }

    // Recovery helpers are available before a local identity exists.
    AsyncFunction("generateSeedPhrase") { generateSeedPhrase() }

    AsyncFunction("deriveBackupCredentialsFromSeedPhrase") { phrase: String ->
      val credentials = deriveBackupCredentialsFromSeedPhrase(phrase)
      mapOf(
        "backupId" to credentials.backupId,
        "authKey" to credentials.authKey,
        "encKey" to credentials.encKey,
      )
    }

    AsyncFunction("createIdentityFromSeedPhrase") { deviceSlot: String, phrase: String ->
      val created = createIdentityFromSeedPhrase(deviceSlot, phrase)
      mapOf(
        "deviceId" to created.identity.deviceId,
        "backupId" to created.backupId,
        "authKey" to created.authKey,
        "encKey" to created.encKey,
      )
    }

    AsyncFunction("computeBackupProof") { authKey: ByteArray, nonce: ByteArray ->
      computeBackupProof(authKey, nonce)
    }

    // Use the OS CSPRNG for invitation secrets.
    AsyncFunction("randomBytes") { len: Int ->
      // Reject negative lengths before converting to UInt.
      require(len >= 0) { "randomBytes: len must be >= 0" }
      randomBytes(len.toUInt())
    }

    // Service intents return immediately. Return Unit explicitly on early exits
    // to match the Expo Function callback's Any? return type.
    Function("startSyncService") {
      val context = appContext.reactContext ?: return@Function Unit
      BackgroundNotifications.ensureStarted(context)
    }

    Function("stopSyncService") {
      val context = appContext.reactContext ?: return@Function Unit
      context.stopService(Intent(context, SyncForegroundService::class.java))
    }

    // Channel creation is idempotent. Runtime notification permission is requested separately.
    Function("createEventsChannel") {
      val context = appContext.reactContext ?: return@Function Unit
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(EVENTS_CHANNEL_ID) == null) {
          val channel =
            NotificationChannel(
              EVENTS_CHANNEL_ID,
              "Circle activity",
              NotificationManager.IMPORTANCE_HIGH,
            )
          channel.description = "New messages and new members in your Circles."
          manager.createNotificationChannel(channel)
        }
      }
    }

    // Background notifications are enabled only when this returns true.
    AsyncFunction("requestNotificationPermission") { promise: expo.modules.kotlin.Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      permissions.askForPermissions(
        { responses ->
          val granted = responses.values.all { it.status == PermissionsStatus.GRANTED }
          promise.resolve(granted)
        },
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    // The caller supplies decrypted content. Separate IDs keep alerts from
    // overwriting each other in the notification tray.
    Function("showNotification") { title: String, body: String ->
      val context = appContext.reactContext ?: return@Function Unit
      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val tap =
        launchIntent?.let {
          android.app.PendingIntent.getActivity(
            context,
            0,
            it,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or
              android.app.PendingIntent.FLAG_IMMUTABLE,
          )
        }
      val notification =
        NotificationCompat.Builder(context, EVENTS_CHANNEL_ID)
          .setContentTitle(title)
          .setContentText(body)
          .setContentIntent(tap)
          .setSmallIcon(context.applicationInfo.icon)
          .setPriority(NotificationCompat.PRIORITY_HIGH)
          .setAutoCancel(true)
          .build()
      NotificationManagerCompat.from(context)
        .notify(nextNotificationId.incrementAndGet(), notification)
    }
  }

  private fun envelopeToMap(envelope: RustEnvelope) =
    mapOf(
      "eventId" to envelope.eventId,
      // ULong doesn't cross the Expo JS bridge cleanly; MLS epoch numbers
      // are tiny in practice (nowhere near Long's range), so this is safe.
      "epoch" to envelope.epoch.toLong(),
      "nonce" to envelope.nonce,
      "ciphertext" to envelope.ciphertext,
    )
}
