package expo.modules.familycirclebridge

import expo.modules.kotlin.exception.CodedException
import org.junit.Assert.*
import org.junit.Test
import uniffi.crypto_core.CryptoCoreException

class BridgeErrorsTest {
  @Test fun protocolErrorsKeepStableCodesAndTheirCauses() {
    val cases = listOf(
      CryptoCoreException.AlreadyProcessed("duplicate") to "ERR_MLS_ALREADY_PROCESSED",
      CryptoCoreException.OwnMessage("echo") to "ERR_MLS_OWN_MESSAGE",
      CryptoCoreException.StaleEpoch("old") to "ERR_MLS_STALE_EPOCH",
      CryptoCoreException.UnauthorizedMembershipCommit("private details") to "ERR_MLS_UNAUTHORIZED_COMMIT",
      CryptoCoreException.InvalidControl("private details") to "ERR_MLS_INVALID_CONTROL",
    )
    for ((failure, expectedCode) in cases) {
      val caught = assertThrows(CodedException::class.java) {
        withCryptoErrors { throw failure }
      }
      assertEquals(expectedCode, caught.code)
      assertSame(failure, caught.cause)
      assertFalse(caught.message.orEmpty().contains("private details"))
    }
  }

  @Test fun unrelatedFailuresAreNotMisclassified() {
    val failure = IllegalStateException("disk failure")
    val caught = assertThrows(IllegalStateException::class.java) {
      withCryptoErrors { throw failure }
    }
    assertSame(failure, caught)
    val mls = CryptoCoreException.Mls("storage or future epoch")
    assertSame(mls, assertThrows(CryptoCoreException.Mls::class.java) {
      withCryptoErrors { throw mls }
    })
    assertEquals(42, withCryptoErrors { 42 })
    assertEquals("ERR_CIRCLE_SYNC_BUSY", CircleSyncBusyException().code)
  }
}
