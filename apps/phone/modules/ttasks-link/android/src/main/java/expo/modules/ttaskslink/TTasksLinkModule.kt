package expo.modules.ttaskslink

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The link to JS: connections by number, and four events, each naming its connection. Every
 * connection ends with one `close`; one that failed says why first, with `error`. Besides: the
 * saved pairing, the phone's own name, `network` when the phone moves to another network, and
 * `scan` for a code handed to the open scanner (Scans).
 */
class TTasksLinkModule : Module() {
  private val sockets = ConcurrentHashMap<Int, WebSocket>()
  private val next = AtomicInteger(1)
  private var network: ConnectivityManager.NetworkCallback? = null

  override fun definition() = ModuleDefinition {
    Name("TTasksLink")
    Events("open", "message", "close", "error", "network", "scan")

    OnCreate {
      Scans.deliver = { text -> sendEvent("scan", mapOf("text" to text)) }
      val connectivity = appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      val callback = object : ConnectivityManager.NetworkCallback() {
        private var current: Network? = null

        // The first call names the network there is; each later one, another.
        override fun onAvailable(available: Network) {
          val moved = current != null && current != available
          current = available
          if (moved) sendEvent("network", emptyMap<String, Any>())
        }
      }
      connectivity?.registerDefaultNetworkCallback(callback)
      network = callback
    }

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

    Function("savePairing") { json: String ->
      appContext.reactContext?.let { LinkStore.save(it, json) }
      Unit
    }

    /** The name the person gave the phone in Android's settings, else its model. */
    Function("deviceName") {
      val context = appContext.reactContext
      context?.let { Settings.Global.getString(it.contentResolver, Settings.Global.DEVICE_NAME) }
        ?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }

    // A module destroyed while the process lives (a reload) must not leave an authenticated
    // connection behind with nobody to hear it.
    OnDestroy {
      Scans.deliver = null
      network?.let { callback ->
        val connectivity = appContext.reactContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        runCatching { connectivity?.unregisterNetworkCallback(callback) }
      }
      network = null
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
