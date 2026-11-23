package com.movieshub.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.util.UUID

private const val CLOUD_TRANSFER_MAX_BYTES = 40L * 1024L * 1024L

@Composable
fun CloudTransferDialog(
    session: AuthSessionData?,
    onSessionUpdated: (AuthSessionData) -> Unit,
    onLogin: () -> Unit,
    onReceived: () -> Unit,
    onError: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("Test cloud : fichier vidéo de 40 Mio maximum.") }
    var receiveUrl by remember { mutableStateOf("") }
    var completedUrl by remember { mutableStateOf("") }
    var completedName by remember { mutableStateOf("video.mp4") }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val currentSession = session
            if (currentSession == null) {
                status = "Connecte-toi d’abord pour envoyer un fichier."
                onLogin()
            } else {
                scope.launch {
                    busy = true
                    status = "Préparation de l’envoi…"
                    runCatching {
                        val info = queryCloudFile(context, uri)
                        require(info.size in 1..CLOUD_TRANSFER_MAX_BYTES) { "Pour ce test, choisis une vidéo de 40 Mio maximum." }
                        val (activeSession, initRaw) = MoviesHubApi.authorizedPost(
                            "/me/transfers",
                            currentSession,
                            JSONObject().put("filename", info.name).put("sizeBytes", info.size)
                        )
                        onSessionUpdated(activeSession)
                        val init = JSONObject(initRaw)
                        status = "Envoi vers le stockage cloud…"
                        uploadCloudFile(context, uri, init.getString("uploadUrl"), info.size, info.mime)
                        status = "Vérification du fichier…"
                        val (updatedSession, completeRaw) = MoviesHubApi.authorizedPost(
                            "/me/transfers/${init.getString("transferId")}/complete",
                            activeSession,
                            JSONObject().put("filename", info.name).put("sizeBytes", info.size)
                        )
                        onSessionUpdated(updatedSession)
                        val complete = JSONObject(completeRaw)
                        completedUrl = complete.getString("downloadUrl")
                        completedName = info.name
                        status = "Envoi terminé. Le lien expire dans environ une heure."
                    }.onFailure {
                        status = it.message ?: "Échec du transfert cloud."
                        onError(status)
                    }
                    busy = false
                }
            }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Transfert cloud · test") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Envoie une vidéo via Supabase/R2 puis partage un lien temporaire. Limite de test : 50 Mio.")
                if (session == null) {
                    Text("Une session MovieHub est nécessaire pour envoyer.")
                    Button(onClick = onLogin, modifier = Modifier.fillMaxWidth(), enabled = !busy) {
                        Text("Se connecter")
                    }
                } else {
                    Button(
                        onClick = { picker.launch(arrayOf("video/*")) },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !busy
                    ) { Text("Choisir une vidéo et envoyer") }
                }
                if (completedUrl.isNotBlank()) {
                    OutlinedButton(
                        onClick = {
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, completedUrl)
                            }
                            context.startActivity(Intent.createChooser(intent, "Partager le lien MovieHub"))
                        },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !busy
                    ) { Text("Partager le lien reçu") }
                }
                Spacer(Modifier.height(4.dp))
                Text("Recevoir un fichier")
                TextField(
                    value = receiveUrl,
                    onValueChange = { receiveUrl = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Lien de téléchargement") },
                    placeholder = { Text("https://…") },
                    singleLine = false,
                    enabled = !busy
                )
                OutlinedButton(
                    onClick = {
                        scope.launch {
                            busy = true
                            status = "Téléchargement du lien…"
                            runCatching { downloadCloudFile(context, receiveUrl) }
                                .onSuccess {
                                    onReceived()
                                    status = "Fichier reçu : ${it.title}"
                                    receiveUrl = ""
                                }
                                .onFailure {
                                    status = it.message ?: "Réception impossible."
                                    onError(status)
                                }
                            busy = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !busy && receiveUrl.isNotBlank()
                ) { Text("Recevoir dans MovieHub") }
                if (busy) Text("Opération en cours…")
                Text(status)
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Fermer") }
        }
    )
}

private data class CloudFileInfo(val name: String, val size: Long, val mime: String)

private fun queryCloudFile(context: Context, uri: Uri): CloudFileInfo {
    val resolver = context.contentResolver
    var name = "video.mp4"
    var size = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
            if (sizeIndex >= 0) size = cursor.getLong(sizeIndex)
        }
    }
    if (size <= 0L) {
        size = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
    }
    val mime = resolver.getType(uri) ?: "application/octet-stream"
    return CloudFileInfo(name.take(255), size, mime)
}

private suspend fun uploadCloudFile(context: Context, uri: Uri, signedUrl: String, size: Long, mime: String) = withContext(Dispatchers.IO) {
    val connection = (URL(signedUrl).openConnection() as HttpURLConnection).apply {
        requestMethod = "PUT"
        doOutput = true
        connectTimeout = 20_000
        readTimeout = 120_000
        setFixedLengthStreamingMode(size)
        setRequestProperty("Content-Type", mime)
    }
    try {
        val input = context.contentResolver.openInputStream(uri) ?: error("Impossible de lire le fichier choisi.")
        input.use { source ->
            connection.outputStream.use { output -> source.copyTo(output, 256 * 1024) }
        }
        val code = connection.responseCode
        if (code !in 200..299) {
            val detail = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty().take(250)
            error("Le stockage a refusé l’envoi (HTTP $code). ${detail.takeIf { it.isNotBlank() } ?: ""}")
        }
    } finally {
        connection.disconnect()
    }
}

private suspend fun downloadCloudFile(context: Context, rawUrl: String): SharedVideo = withContext(Dispatchers.IO) {
    val url = URL(rawUrl.trim())
    require(url.protocol == "https" && url.userInfo == null) { "Le lien doit être une URL HTTPS valide." }
    val host = url.host.lowercase()
    require(host.endsWith(".supabase.co") || host.endsWith(".r2.cloudflarestorage.com")) {
        "Ce lien ne provient pas d’un stockage MovieHub pris en charge."
    }
    val connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = 20_000
        readTimeout = 120_000
    }
    val directory = File(context.filesDir, "downloads/shared").apply { mkdirs() }
    var destination: File? = null
    try {
        val code = connection.responseCode
        if (code !in 200..299) error("Lien expiré ou fichier inaccessible (HTTP $code).")
        val length = connection.contentLengthLong
        require(length <= CLOUD_TRANSFER_MAX_BYTES) { "Le fichier dépasse la limite de test de 50 Mio." }
        val disposition = connection.getHeaderField("Content-Disposition").orEmpty()
        val headerName = Regex("filename\*=UTF-8''([^;]+)|filename=\"?([^;\"\\r\\n]+)").find(disposition)
        val queryName = url.query.orEmpty().split('&').firstOrNull { it.startsWith("download=") }?.substringAfter('=')
            ?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
        val name = (headerName?.groups?.get(1)?.value?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            ?: headerName?.groups?.get(2)?.value
            ?: queryName
            ?: url.path.substringAfterLast('/')).orEmpty()
        val extension = name.substringAfterLast('.', "").lowercase().filter { it.isLetterOrDigit() }.take(8)
        require(extension in setOf("mp4", "mkv", "webm", "mov", "m4v", "avi")) { "Le lien ne semble pas contenir une vidéo prise en charge." }
        val title = name.substringBeforeLast('.', name).replace(Regex("[^A-Za-z0-9 _-]"), "_").trim().take(70).ifBlank { "MovieHub video" }
        val target = File(directory, "${title}_${UUID.randomUUID().toString().take(8)}.$extension")
        destination = target
        connection.inputStream.use { input ->
            target.outputStream().buffered().use { output ->
                val buffer = ByteArray(256 * 1024)
                var total = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= CLOUD_TRANSFER_MAX_BYTES) { "Le fichier dépasse la limite de test de 50 Mio." }
                    output.write(buffer, 0, count)
                }
            }
        }
        require(target.length() > 0L) { "Le fichier reçu est vide." }
        SharedVideo(target, title)
    } catch (error: Throwable) {
        destination?.delete()
        throw error
    } finally {
        connection.disconnect()
    }
}
