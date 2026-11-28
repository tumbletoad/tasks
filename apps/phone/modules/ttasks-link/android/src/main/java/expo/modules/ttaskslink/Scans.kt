package expo.modules.ttaskslink

/**
 * A code read for the open scanner, from inside the app's own process. The installed-app test hands
 * one in here, because an emulator has no camera that can see a QR code; the camera's own reads go
 * to the same screen through expo-camera. No other app can reach this.
 */
object Scans {
  @Volatile internal var deliver: ((String) -> Unit)? = null

  fun read(text: String) {
    deliver?.invoke(text)
  }
}
