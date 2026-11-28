package expo.modules.ttaskslink

import android.util.Base64
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.TlsVersion
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** The pin of a certificate's key: SHA-256 of its DER SubjectPublicKeyInfo, unpadded base64url. */
fun pinOf(cert: X509Certificate): String =
  Base64.encodeToString(
    MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded),
    Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
  )

/**
 * Trusts the computer by the pin of its key alone. Its certificate names no address, so neither
 * a chain nor a hostname says anything. A refusal ends the handshake before the phone writes a
 * byte of its own: OkHttp sends the upgrade only after it, and TLS 1.3 sends the phone's
 * certificate only after the computer's was checked.
 */
class PinTrust(private val pin: String) : X509TrustManager {
  @Volatile var mismatch = false
    private set

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
    if (pinOf(leaf) != pin) {
      mismatch = true
      throw CertificateException("pin")
    }
  }

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
    throw CertificateException("a phone serves no one")

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** How a connection that never opened failed. */
enum class Failure(val kind: String) { PIN("pin"), TLS("tls"), NETWORK("network") }

/** Shares one dispatcher and its threads between every connection. */
private val base = OkHttpClient()

private val TLS_1_3 = ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS).tlsVersions(TlsVersion.TLS_1_3).build()

/** A WebSocket to `url`, trusted by `pin`, with the phone's key. */
fun openLink(url: String, pin: String, listener: (PinTrust) -> WebSocketListener): WebSocket {
  val trust = PinTrust(pin)
  val tls = SSLContext.getInstance("TLSv1.3").apply { init(arrayOf(PhoneKey), arrayOf(trust), null) }
  val client = base.newBuilder()
    .sslSocketFactory(tls.socketFactory, trust)
    .hostnameVerifier { _, _ -> true }
    .connectionSpecs(listOf(TLS_1_3))
    .connectTimeout(5, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    // A socket that died while the phone slept is found within two pings.
    .pingInterval(20, TimeUnit.SECONDS)
    .build()
  return client.newWebSocket(Request.Builder().url(url).build(), listener(trust))
}

fun failureOf(trust: PinTrust, error: Throwable): Failure = when {
  trust.mismatch -> Failure.PIN
  error is javax.net.ssl.SSLException -> Failure.TLS
  else -> Failure.NETWORK
}
