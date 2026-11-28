package com.tumbletoad.ttasks

import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import expo.modules.ttaskslink.Failure
import expo.modules.ttaskslink.Scans
import expo.modules.ttaskslink.PinTrust
import expo.modules.ttaskslink.failureOf
import expo.modules.ttaskslink.openLink
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The installed app against the real service that tests/phone/emulator.ts runs on the computer: it
 * pushes the pairing code to the emulator and counts, on the computer's side, what each method makes
 * reach the listener. Each method is run on its own, in this order.
 */
@RunWith(AndroidJUnit4::class)
class LinkTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  /** The QR code's text the harness pushed, its addresses as the emulator reaches the computer. */
  private fun pairingText(): String {
    val fd = instrumentation.uiAutomation.executeShellCommand("cat $PAIRING_FILE")
    return ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }.trim()
  }

  private fun pairing(): JSONObject = JSONObject(pairingText().removePrefix("TTASKS1:"))

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

  /**
   * The screen a person meets: the app starts unpaired, Scan the code opens the scanner, the code
   * arrives there (from here, as an emulator has no camera to see it), the phone is named and
   * paired, and the screen says Connected.
   */
  @Test
  fun pairsThroughTheScreen() {
    val text = pairingText()
    val device = UiDevice.getInstance(instrumentation)
    val context = instrumentation.targetContext
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: throw AssertionError("the app has no launcher activity")
    context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    shown(device, "Scan the code").click()
    shown(device, "Cancel")
    // The scanner listens from its first frame on: hand the code in until the name screen shows.
    val name = (1..20).firstNotNullOfOrNull {
      Scans.read(text)
      device.wait(Until.findObject(By.clazz("android.widget.EditText")), 1_000L)
    } ?: throw AssertionError("no field for the phone's name")
    name.text = "Emulator"
    // For the pull request's pictures; the harness pulls it.
    context.getExternalFilesDir(null)?.let { device.takeScreenshot(java.io.File(it, "name.png")) }
    shown(device, "Pair").click()
    shown(device, "Connected")
  }

  private fun shown(device: UiDevice, text: String): UiObject2 =
    device.wait(Until.findObject(By.text(text)), WAIT_MS) ?: throw AssertionError("\"$text\" is not on the screen")

  companion object {
    const val PAIRING_FILE = "/data/local/tmp/ttasks-pairing.txt"
    const val WAIT_MS = 60_000L
  }
}
