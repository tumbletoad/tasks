package expo.modules.ttaskslink

import android.content.Context

/**
 * The pairing the app reopens with, as the app's JSON: the computer's addresses, the pin of its key
 * and the space. Nothing in it is secret (the phone's key is in the Keystore), and the app's
 * private storage is not backed up.
 */
object LinkStore {
  private const val FILE = "ttasks-link"
  private const val KEY = "pairing"

  private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun read(context: Context): String? = prefs(context).getString(KEY, null)

  fun save(context: Context, json: String) {
    prefs(context).edit().putString(KEY, json).commit()
  }
}
