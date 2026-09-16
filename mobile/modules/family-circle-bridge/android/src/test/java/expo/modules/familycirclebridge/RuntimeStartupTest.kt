package expo.modules.familycirclebridge

import org.junit.Assert.*
import org.junit.Test

class RuntimeStartupTest {
  private data class Context(val active: Boolean)
  private class Harness {
    var context: Context? = null
    var callback: (() -> Unit)? = null
    var starts = 0
    var runtimeStarts = 0
    var listening = false
    var startedContext: Context? = null
    val startup = RuntimeStartup(
      current = { check(listening); context },
      ready = { it.active },
      listen = { listening = true; callback = it },
      unlisten = { listening = false },
      startRuntime = { runtimeStarts++ },
      startTask = { starts++; startedContext = it },
    )
  }
  @Test fun inactiveNonNullContextWaitsForReadiness() {
    val h = Harness()
    h.context = Context(false)
    h.startup.begin()
    assertEquals(0, h.starts)
    assertEquals(1, h.runtimeStarts)
    assertTrue(h.listening)
    h.callback!!()
    assertEquals(0, h.starts)
    h.context = Context(true)
    h.callback!!()
    h.callback!!()
    assertEquals(1, h.starts)
    assertFalse(h.listening)
  }
  @Test fun alreadyReadyContextStartsOnceWithoutRestartingRuntime() {
    val h = Harness()
    h.context = Context(true)
    h.startup.begin()
    h.callback!!()
    assertEquals(1, h.starts)
    assertEquals(0, h.runtimeStarts)
    assertFalse(h.listening)
  }
  @Test fun timeoutOrServiceDestructionCancelsQueuedInitialization() {
    val h = Harness()
    h.startup.begin()
    h.startup.cancel()
    h.context = Context(true)
    h.callback!!()
    assertEquals(0, h.starts)
    assertFalse(h.listening)
  }
  @Test fun delayedInitializationUsesTheCurrentContextAfterReplacement() {
    val h = Harness()
    h.startup.begin()
    h.context = Context(false)
    h.callback!!()
    assertEquals(0, h.starts)
    val replacement = Context(true)
    h.context = replacement
    h.callback!!()
    assertSame(replacement, h.startedContext)
  }
}
