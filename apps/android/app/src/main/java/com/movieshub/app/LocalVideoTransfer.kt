package com.movieshub.app

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.URL
import java.net.URLDecoder
import java.util.UUID
import kotlin.concurrent.thread

class LocalVideoTransferServer(private val videos: List<Pair<File, String>>) : AutoCloseable {
    private val secret = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "")
    private val socket = ServerSocket(0, 8)
    private val host = findLanAddress()
    val uri: String = "moviehub://receive?host=$host&port=${socket.localPort}&token=$secret&count=${videos.size}"

    init {
        require(videos.isNotEmpty() && videos.all { it.first.isFile && it.first.canRead() }) {
            "Sélectionne au moins une vidéo lisible."
        }
        thread(name = "moviehub-local-transfer", isDaemon = true) {
            while (!socket.isClosed) {
                try {
                    val client = socket.accept()
                    thread(name = "moviehub-transfer-client", isDaemon = true) { serve(client) }
                } catch (_: Exception) {
                    if (!socket.isClosed) continue
                }
            }
        }
    }

    private fun serve(client: java.net.Socket) {
        client.use { peer ->
            try {
                val input = BufferedReader(InputStreamReader(peer.getInputStream(), Charsets.US_ASCII))
                val request = input.readLine().orEmpty().split(" ")
                if (request.size < 2 || request[0] != "GET") {
                    respond(peer, 405, "Method Not Allowed", "Only GET")
                    return
                }
                val target = request[1]
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                }
                val path = target.substringBefore("?")
                val query = target.substringAfter("?", "")
                    .split("&").filter { it.isNotBlank() }.associate {
                        val parts = it.split("=", limit = 2)
                        URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
                    }
                if (query["token"] != secret) {
                    respond(peer, 403, "Forbidden", "Invalid transfer token")
                    return
                }
                if (path == "/manifest") {
                    val manifest = JSONArray()
                    videos.forEachIndexed { index, (file, title) ->
                        manifest.put(JSONObject().put("index", index).put("title", title).put("name", file.name).put("size", file.length()))
                    }
                    val bytes = manifest.toString().toByteArray(Charsets.UTF_8)
                    val out = peer.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    out.write(bytes); out.flush()
                    return
                }
                if (path.startsWith("/file/")) {
                    val index = path.removePrefix("/file/").toIntOrNull()
                    val file = index?.let { videos.getOrNull(it)?.first }
                    if (file == null || !file.isFile) {
                        respond(peer, 404, "Not Found", "File unavailable")
                        return
                    }
                    val out = peer.getOutputStream()
                    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${file.length()}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
                    file.inputStream().use { it.copyTo(out, 256 * 1024) }
                    out.flush()
                    return
                }
                respond(peer, 404, "Not Found", "Unknown path")
            } catch (_: Exception) {
                runCatching { respond(peer, 500, "Internal Server Error", "Transfer failed") }
            }
        }
    }

    private fun respond(peer: java.net.Socket, code: Int, status: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val out = peer.getOutputStream()
        out.write("HTTP/1.1 $code $status\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
        out.write(bytes); out.flush()
    }

    override fun close() {
        runCatching { socket.close() }
    }

    private fun findLanAddress(): String {
        val interfaces = NetworkInterface.getNetworkInterfaces()
        while (interfaces.hasMoreElements()) {
            val network = interfaces.nextElement()
            if (!network.isUp || network.isLoopback) continue
            val addresses = network.inetAddresses
            while (addresses.hasMoreElements()) {
                val address = addresses.nextElement()
                if (address is Inet4Address && !address.isLoopbackAddress && address.isSiteLocalAddress) return address.hostAddress ?: continue
            }
        }
        error("Connecte le téléphone à un réseau Wi-Fi pour créer le transfert local.")
    }
}

fun localTransferQr(uri: String): Bitmap {
    val matrix = com.google.zxing.qrcode.QRCodeWriter().encode(
        uri, com.google.zxing.BarcodeFormat.QR_CODE, 640, 640
    )
    val pixels = IntArray(640 * 640)
    for (y in 0 until 640) for (x in 0 until 640) {
        pixels[y * 640 + x] = if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    return Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888).apply {
        setPixels(pixels, 0, 640, 0, 0, 640, 640)
    }
}

suspend fun receiveMovieHubTransfer(context: Context, uri: Uri): List<SharedVideo> = withContext(Dispatchers.IO) {
    val host = uri.getQueryParameter("host") ?: error("QR de transfert invalide.")
    val port = uri.getQueryParameter("port")?.toIntOrNull() ?: error("Port de transfert invalide.")
    val token = uri.getQueryParameter("token") ?: error("Jeton de transfert absent.")
    require(port in 1..65535) { "Port de transfert invalide." }
    fun get(path: String): HttpURLConnection = (URL("http://$host:$port$path").openConnection() as HttpURLConnection).apply {
        connectTimeout = 10_000
        readTimeout = 60_000
        setRequestProperty("Connection", "close")
    }
    val manifestConnection = get("/manifest?token=$token")
    val manifest = try {
        if (manifestConnection.responseCode != 200) error("Le téléphone expéditeur n’est pas accessible.")
        JSONArray(manifestConnection.inputStream.bufferedReader().use { it.readText() })
    } finally { manifestConnection.disconnect() }
    val directory = File(context.filesDir, "downloads/shared").apply { mkdirs() }
    val received = mutableListOf<SharedVideo>()
    for (i in 0 until manifest.length()) {
        val item = manifest.getJSONObject(i)
        val index = item.getInt("index")
        val title = item.optString("title").replace(Regex("[^A-Za-z0-9 _-]"), "_").trim().take(70).ifBlank { "MovieHub video" }
        val originalName = item.optString("name", "video.mp4")
        val ext = originalName.substringAfterLast('.', "mp4").lowercase().filter { it.isLetterOrDigit() }.take(8).ifBlank { "mp4" }
        val destination = File(directory, title + "_" + UUID.randomUUID().toString().take(8) + "." + ext)
        val connection = get("/file/$index?token=$token")
        try {
            if (connection.responseCode != 200) error("Échec de réception de « $title ».")
            connection.inputStream.use { input -> destination.outputStream().buffered().use { output -> input.copyTo(output, 256 * 1024) } }
            require(destination.length() > 0L) { "Le fichier reçu est vide." }
            received += SharedVideo(destination, title)
        } catch (error: Throwable) {
            destination.delete()
            throw error
        } finally { connection.disconnect() }
    }
    received
}
