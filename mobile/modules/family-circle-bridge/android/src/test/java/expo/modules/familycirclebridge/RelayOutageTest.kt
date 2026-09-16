package expo.modules.familycirclebridge

import com.microsoft.signalr.HubConnectionBuilder
import com.microsoft.signalr.HubConnectionState
import io.reactivex.rxjava3.plugins.RxJavaPlugins
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RelayOutageTest {
  @Test fun originalStopDuringNegotiationReproducesAsyncNullTransportCrash() {
    val errors = CopyOnWriteArrayList<Throwable>()
    val failed = CountDownLatch(1)
    RxJavaPlugins.setErrorHandler { errors.add(it); failed.countDown() }
    val server = MockWebServer()
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    server.start()
    val hub = HubConnectionBuilder.create(server.url("/sync").toString())
      .setHttpClientBuilderCallback { it.callTimeout(300, TimeUnit.MILLISECONDS) }.build()
    try {
      val start = hub.start().test()
      assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
      // This is the production failure ordering: outer start timeout, then
      // stop before the dependency's negotiation request reports its error.
      hub.stop().test()
      start.awaitDone(2, TimeUnit.SECONDS).assertError { true }
      assertTrue(failed.await(2, TimeUnit.SECONDS))
      assertTrue(errors.any { error ->
        generateSequence(error) { it.cause }.any { it is NullPointerException && it.stackTrace.any { f -> f.className == "com.microsoft.signalr.HubConnection" } }
      })
    } finally { hub.stop().blockingAwait(1, TimeUnit.SECONDS); server.shutdown(); RxJavaPlugins.reset() }
  }

  @Test fun directWebSocketTimeoutsRecoverAndSubscribeWithoutAsyncErrors() {
    val errors = CopyOnWriteArrayList<Throwable>()
    RxJavaPlugins.setErrorHandler { errors.add(it) }
    val server = MockWebServer()
    server.start()
    try {
      repeat(3) {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val hub = RelayHubFactory.create(server.url("/sync").toString(), "test", 200)
        hub.start().test().awaitDone(3, TimeUnit.SECONDS).assertError { true }
        hub.stop().test().awaitDone(2, TimeUnit.SECONDS).assertComplete()
        assertEquals(HubConnectionState.DISCONNECTED, hub.connectionState)
        assertEquals("/sync", server.takeRequest(2, TimeUnit.SECONDS)!!.path)
      }
      server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onMessage(socket: WebSocket, bytes: okio.ByteString) { onMessage(socket, bytes.utf8()) }
        override fun onMessage(socket: WebSocket, text: String) {
          if (text.contains("protocol")) socket.send("{}\u001e")
          if (text.contains("Subscribe")) {
            val id = Regex("\"invocationId\":\"([^\"]+)\"").find(text)!!.groupValues[1]
            socket.send("{\"type\":3,\"invocationId\":\"$id\",\"result\":true}\u001e")
          }
        }
        override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
      }))
      val recovered = RelayHubFactory.create(server.url("/sync").toString(), "test", 2_000)
      try {
        assertTrue(recovered.start().blockingAwait(3, TimeUnit.SECONDS))
        assertTrue(recovered.invoke(Boolean::class.javaObjectType, "Subscribe", arrayOf("mailbox") as Any).blockingGet())
        assertEquals(HubConnectionState.CONNECTED, recovered.connectionState)
      } finally { recovered.stop().blockingAwait(3, TimeUnit.SECONDS) }
      assertTrue(errors.toString(), errors.isEmpty())
    } finally { server.shutdown(); RxJavaPlugins.reset() }
  }
  @Test fun websocketHandshakeTimeoutAlsoEndsWithoutUnhandledCleanupErrors() {
    val errors = CopyOnWriteArrayList<Throwable>()
    RxJavaPlugins.setErrorHandler { errors.add(it) }
    val server = MockWebServer()
    server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
      override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
    }))
    server.start()
    val hub = RelayHubFactory.create(server.url("/sync").toString(), "test", 200)
    try {
      hub.start().test().awaitDone(3, TimeUnit.SECONDS).assertError { true }
      hub.stop().test().awaitDone(2, TimeUnit.SECONDS).assertComplete()
      assertEquals(HubConnectionState.DISCONNECTED, hub.connectionState)
      assertTrue(errors.toString(), errors.isEmpty())
    } finally { server.shutdown(); RxJavaPlugins.reset() }
  }

}
