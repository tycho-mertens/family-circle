package expo.modules.familycirclebridge

import expo.modules.kotlin.exception.CodedException
import uniffi.crypto_core.CryptoCoreException

internal class CircleSyncBusyException : CodedException(
  "ERR_CIRCLE_SYNC_BUSY",
  "Circle sync is busy; try again shortly",
  null,
)

/** Preserve protocol classifications across Expo without parsing exception messages in JS. */
internal fun <T> withCryptoErrors(operation: () -> T): T =
  try {
    operation()
  } catch (error: CryptoCoreException) {
    val code = when (error) {
      is CryptoCoreException.AlreadyProcessed -> "ERR_MLS_ALREADY_PROCESSED"
      is CryptoCoreException.OwnMessage -> "ERR_MLS_OWN_MESSAGE"
      is CryptoCoreException.StaleEpoch -> "ERR_MLS_STALE_EPOCH"
      else -> throw error
    }
    throw CodedException(code, "MLS operation could not be applied", error)
  }
