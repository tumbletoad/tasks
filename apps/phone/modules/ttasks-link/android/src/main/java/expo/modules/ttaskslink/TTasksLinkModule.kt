package expo.modules.ttaskslink

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The link to JS: connections by number, and four events, each naming its connection. Every
 * connection ends with one `close`; one that failed says why first, with `error`.
 */
class TTasksLinkModule : Module() {
  private val sockets = ConcurrentHashMap<Int, WebSocket>()
  private val next = AtomicInteger(1)

  override fun definition() = ModuleDefinition {
    Name("TTasksLink")
    Events("open", "message", "close", "error")

    Function("connect") { url: String, pin: String ->
      val id = next.getAndIncrement()
      sockets[id] = openLink(url, pin) { trust -> listener(id, trust) }
      id
    }

    Function("send") { id: Int, text: String ->
      sockets[id]?.send(text)
      Unit
    }

    Function("close") { id: Int, code: Int, reason: String ->
      // OkHttp sends the close frame and reports the end through onClosed or onFailure.
      if (sockets[id]?.close(code, reason) != true) sockets.remove(id)?.cancel()
      Unit
    }

    Function("pairing") {
      appContext.reactContext?.let { LinkStore.read(it) }
    }

    Function("clearPairing") {
      appContext.reactContext?.let { LinkStore.clear(it) }
      Unit
    }

    // A module destroyed while the process lives (a reload) must not leave an authenticated
    // connection behind with nobody to hear it.
    OnDestroy {
      // Forgotten first, so their endings send no event to a module that is gone.
      val open = sockets.values.toList()
      sockets.clear()
      open.forEach { it.cancel() }
    }
  }

  private fun ended(id: Int, code: Int, reason: String) {
    if (sockets.remove(id) != null) sendEvent("close", mapOf("id" to id, "code" to code, "reason" to reason))
  }

  private fun listener(id: Int, trust: PinTrust) = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      sendEvent("open", mapOf("id" to id))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      sendEvent("message", mapOf("id" to id, "text" to text))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      // The answer to the computer's close frame; its own code may be one a client cannot send.
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      ended(id, code, reason)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (sockets.containsKey(id)) sendEvent("error", mapOf("id" to id, "kind" to failureOf(trust, t).kind))
      // An ending without a close frame, as browsers report it.
      ended(id, 1006, "")
    }
  }
}
