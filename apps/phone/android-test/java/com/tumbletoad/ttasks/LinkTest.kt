package com.tumbletoad.ttasks

import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.ttaskslink.Failure
import expo.modules.ttaskslink.LinkStore
import expo.modules.ttaskslink.PinTrust
import expo.modules.ttaskslink.failureOf
import expo.modules.ttaskslink.openLink
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The link from inside the installed app, against the real service that tests/phone/emulator.ts
 * runs on the computer: it pushes the pairing code to the emulator and counts, on the computer's
 * side, what each method makes reach the listener. Each method is run on its own, in this order.
 */
@RunWith(AndroidJUnit4::class)
class LinkTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  /** The QR code's JSON the harness pushed, its addresses as the emulator reaches the computer. */
  private fun pairing(): JSONObject {
    val fd = instrumentation.uiAutomation.executeShellCommand("cat $PAIRING_FILE")
    val text = ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    return JSONObject(text.trim().removePrefix("TTASKS1:"))
  }

  private sealed interface Event {
    data object Open : Event
    data class Message(val text: String) : Event
    data class Failed(val failure: Failure) : Event
  }

  private fun connect(addr: String, pin: String): Pair<WebSocket, LinkedBlockingQueue<Event>> {
    val events = LinkedBlockingQueue<Event>()
    val socket = openLink("wss://$addr/v1/link", pin) { trust: PinTrust ->
      object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          events.add(Event.Open)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          events.add(Event.Message(text))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          events.add(Event.Failed(failureOf(trust, t)))
        }
      }
    }
    return socket to events
  }

  private fun LinkedBlockingQueue<Event>.next(): Event =
    poll(20, TimeUnit.SECONDS) ?: throw AssertionError("nothing from the link in 20 s")

  /** Another key at the computer's address: the handshake fails on the pin, and nothing is sent. */
  @Test
  fun wrongPin() {
    val qr = pairing()
    val pin = qr.getString("pin")
    val other = (if (pin[0] == 'A') "B" else "A") + pin.substring(1)
    val (_, events) = connect(qr.getJSONArray("addrs").getString(0), other)
    assertEquals(Event.Failed(Failure.PIN), events.next())
  }

  /** The right pin and the code: the computer's hello names the space, and the app keeps the pairing. */
  @Test
  fun pairs() {
    val qr = pairing()
    val space = qr.getJSONObject("space")
    val (socket, events) = connect(qr.getJSONArray("addrs").getString(0), qr.getString("pin"))
    assertEquals(Event.Open, events.next())
    val pair = JSONObject().put("code", qr.getString("code")).put("name", "Emulator").put("platform", "android")
    socket.send(
      JSONObject().put("type", "open").put("protocol", 1).put("space", space.getString("id")).put("pair", pair).toString(),
    )
    val hello = JSONObject((events.next() as Event.Message).text)
    assertEquals("hello", hello.getString("type"))
    val link = hello.getJSONObject("link")
    assertEquals(1, link.getInt("protocol"))
    assertEquals(space.getString("id"), link.getJSONObject("space").getString("id"))
    socket.close(1000, null)
    // What the app reads on its next start (src/link/open.ts readSaved).
    val saved = JSONObject()
      .put("addrs", JSONArray(listOf(qr.getJSONArray("addrs").getString(0))))
      .put("pin", qr.getString("pin"))
      .put("space", JSONObject().put("id", space.getString("id")).put("name", space.getString("name")))
    LinkStore.save(instrumentation.targetContext, saved.toString())
  }

  companion object {
    const val PAIRING_FILE = "/data/local/tmp/ttasks-pairing.txt"
  }
}
