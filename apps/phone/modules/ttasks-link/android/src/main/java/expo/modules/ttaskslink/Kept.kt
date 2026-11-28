package expo.modules.ttaskslink

import android.content.Context
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * What the app keeps across a restart besides its pairing: the space's last rows and what waits to
 * be sent. One file each in the app's private storage, which is not backed up, replaced whole.
 */
object Kept {
  private val NAME = Regex("^[a-z]{1,32}$")

  private fun file(context: Context, name: String): File {
    require(NAME.matches(name)) { "a kept file's name is lowercase letters" }
    return File(File(context.filesDir, "kept").apply { mkdirs() }, "$name.json")
  }

  fun read(context: Context, name: String): String? = file(context, name).takeIf { it.exists() }?.readText()

  /** Written beside, then moved over the old in one step: a failure leaves the old file whole. */
  fun write(context: Context, name: String, text: String) {
    val target = file(context, name)
    val next = File(target.parentFile, "$name.json.next")
    next.writeText(text)
    Files.move(next.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
  }
}
