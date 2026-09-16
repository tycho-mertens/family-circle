package expo.modules.familycirclebridge

import com.microsoft.signalr.HubConnection
import com.microsoft.signalr.HubConnectionBuilder
import com.microsoft.signalr.TransportEnum
import java.util.concurrent.TimeUnit

internal object RelayHubFactory {
  fun create(url: String, token: String, timeoutMs: Long = 10_000): HubConnection =
    HubConnectionBuilder.create(url)
      .withHeader("X-Installation-Token", token)
      // Our relay supports direct WebSockets. Negotiation in SignalR 9.0.20
      // can fail before transport exists; stop-during-start then dereferences
      // null asynchronously. Direct WebSockets install transport before I/O.
      .withTransport(TransportEnum.WEBSOCKETS)
      .shouldSkipNegotiate(true)
      .withHandshakeResponseTimeout(timeoutMs)
      .setHttpClientBuilderCallback { builder ->
        builder.connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
          .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
      }.build()
}
