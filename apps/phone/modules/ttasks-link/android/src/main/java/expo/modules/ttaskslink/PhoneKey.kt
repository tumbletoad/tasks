package expo.modules.ttaskslink

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.security.auth.x500.X500Principal

/**
 * The phone's own key: one P-256 key in the Android Keystore, made on first use and kept across a
 * removal and a new pairing, so the computer knows the phone again by it. It cannot be exported and
 * never leaves the phone. NONE beside SHA-256 because the TLS stack hashes the handshake itself and
 * asks the key to sign the digest.
 */
object PhoneKey : X509ExtendedKeyManager() {
  const val ALIAS = "ttasks-link"

  @Synchronized
  private fun entry(): KeyStore.PrivateKeyEntry {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (!store.containsAlias(ALIAS)) {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
        initialize(
          KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
            // The computer reads the certificate only for its key: the name says nothing.
            .setCertificateSubject(X500Principal("CN=link"))
            .build(),
        )
        generateKeyPair()
      }
    }
    return store.getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
  }

  override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS

  override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS

  override fun getPrivateKey(alias: String?): PrivateKey? = if (alias == ALIAS) entry().privateKey else null

  override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
    if (alias == ALIAS) arrayOf(entry().certificate as X509Certificate) else null

  override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)

  override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null

  override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
}
