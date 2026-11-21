package com.movieshub.app

import android.os.Bundle
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem as PlayerMediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.compose.runtime.livedata.observeAsState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.File

private data class MoviePalette(
    val background: Color,
    val panel: Color,
    val accent: Color,
    val muted: Color,
    val text: Color
)
private val LocalMoviePalette = staticCompositionLocalOf {
    MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), Color.White)
}
private object UiColors {
    val background: Color @Composable get() = LocalMoviePalette.current.background
    val panel: Color @Composable get() = LocalMoviePalette.current.panel
    val accent: Color @Composable get() = LocalMoviePalette.current.accent
    val muted: Color @Composable get() = LocalMoviePalette.current.muted
    val text: Color @Composable get() = LocalMoviePalette.current.text
}

class MainActivity : ComponentActivity() {
    private val incomingShareUri = mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incomingShareUri.value = extractIncomingVideo(intent)
        setContent { MoviesHubApp(incomingShareUri.value) { incomingShareUri.value = null } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        incomingShareUri.value = extractIncomingVideo(intent)
    }

    private fun extractIncomingVideo(source: Intent?): Uri? {
        val incoming = source ?: return null
        if (incoming.action != Intent.ACTION_SEND && incoming.action != Intent.ACTION_VIEW) return null
        val mime = incoming.type ?: return null
        if (!mime.startsWith("video/") && mime != "application/octet-stream") return null
        if (incoming.action == Intent.ACTION_VIEW) return incoming.data
        return if (android.os.Build.VERSION.SDK_INT >= 33) {
            incoming.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            incoming.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }
    }
}

private enum class Screen { HOME, CATEGORIES, SEARCH, DETAIL, PLAYER, DOWNLOADS, PROFILE, SETTINGS, AUTH, FAVORITES, HISTORY }

private data class SessionUser(val id: String, val email: String, val displayName: String)
private data class AuthSessionData(val user: SessionUser, val accessToken: String, val refreshToken: String, val expiresAtMillis: Long)
private data class HistoryEntry(
    val id: String,
    val content: MediaItem,
    val positionSeconds: Int,
    val durationSeconds: Int?,
    val versionId: String?,
    val completed: Boolean
)

private object SecureSessionStore {
    private fun preferences(context: Context) = EncryptedSharedPreferences.create(
        context,
        "moviehub_secure_session",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun read(context: Context): AuthSessionData? = runCatching {
        val prefs = preferences(context)
        val id = prefs.getString("user_id", null) ?: return null
        val email = prefs.getString("email", null) ?: return null
        val name = prefs.getString("display_name", null) ?: return null
        val access = prefs.getString("access_token", null) ?: return null
        val refresh = prefs.getString("refresh_token", null) ?: return null
        val expiresAt = prefs.getLong("expires_at", 0L)
        AuthSessionData(SessionUser(id, email, name), access, refresh, expiresAt)
    }.getOrNull()

    fun save(context: Context, session: AuthSessionData) {
        preferences(context).edit()
            .putString("user_id", session.user.id)
            .putString("email", session.user.email)
            .putString("display_name", session.user.displayName)
            .putString("access_token", session.accessToken)
            .putString("refresh_token", session.refreshToken)
            .putLong("expires_at", session.expiresAtMillis)
            .apply()
    }

    fun clear(context: Context) { preferences(context).edit().clear().apply() }
}

private data class Genre(val slug: String, val name: String)

private data class VideoVersion(
    val id: String,
    val label: String,
    val height: Int?,
    val durationSeconds: Int?
)

private data class SeasonRef(val id: String, val number: Int, val title: String, val episodeCount: Int)
private data class EpisodeRef(val number: Int, val title: String, val versions: List<VideoVersion>)

private data class MediaItem(
    val id: String,
    val title: String,
    val type: String = "Film",
    val year: String = "",
    val description: String = "",
    val poster: String? = null,
    val slug: String = id,
    val trailerUrl: String? = null,
    val versions: List<VideoVersion> = emptyList(),
    val seasons: List<SeasonRef> = emptyList()
)

private object MoviesHubApi {
    private fun request(path: String, method: String, body: JSONObject? = null, bearer: String? = null): String {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10000
            readTimeout = 15000
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        return try {
            if (body != null) connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val message = runCatching { JSONObject(response).optString("message") }.getOrNull()
                error(message?.takeIf { it.isNotBlank() } ?: "Erreur API HTTP $code")
            }
            response
        } finally {
            connection.disconnect()
        }
    }

    private fun get(path: String): String = request(path, "GET")

    suspend fun authenticate(email: String, password: String, displayName: String?, register: Boolean): AuthSessionData =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("email", email.trim())
                .put("password", password)
                .put("platform", "ANDROID")
                .put("deviceName", "Android")
            if (register) body.put("displayName", displayName?.trim().orEmpty())
            val result = JSONObject(request(if (register) "/auth/register" else "/auth/login", "POST", body))
            val user = result.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                result.getString("accessToken"),
                result.getString("refreshToken"),
                System.currentTimeMillis() + result.optLong("expiresIn", 900L) * 1000L
            )
        }

    suspend fun authorizedGet(path: String, session: AuthSessionData): Pair<AuthSessionData, String> = withContext(Dispatchers.IO) {
        val active = if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            val refreshed = JSONObject(request("/auth/refresh", "POST", JSONObject().put("refreshToken", session.refreshToken)))
            val user = refreshed.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                refreshed.getString("accessToken"),
                refreshed.getString("refreshToken"),
                System.currentTimeMillis() + refreshed.optLong("expiresIn", 900L) * 1000L
            )
        } else session
        active to request(path, "GET", bearer = active.accessToken)
    }

    suspend fun putAuthorized(path: String, session: AuthSessionData, body: JSONObject? = null): AuthSessionData = withContext(Dispatchers.IO) {
        val active = if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            val refreshed = JSONObject(request("/auth/refresh", "POST", JSONObject().put("refreshToken", session.refreshToken)))
            val user = refreshed.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                refreshed.getString("accessToken"),
                refreshed.getString("refreshToken"),
                System.currentTimeMillis() + refreshed.optLong("expiresIn", 900L) * 1000L
            )
        } else session
        request(path, "PUT", body = body, bearer = active.accessToken)
        active
    }

    suspend fun recordHistory(
        contentId: String,
        versionId: String,
        positionSeconds: Int,
        durationSeconds: Int,
        session: AuthSessionData
    ): AuthSessionData = putAuthorized(
        "/me/history",
        session,
        JSONObject()
            .put("contentId", contentId)
            .put("versionId", versionId)
            .put("positionSeconds", positionSeconds.coerceAtLeast(0))
            .put("durationSeconds", durationSeconds.coerceAtLeast(1))
            .put("completed", durationSeconds > 0 && positionSeconds >= durationSeconds * 0.95)
    )

    suspend fun deleteAuthorized(path: String, session: AuthSessionData): AuthSessionData = withContext(Dispatchers.IO) {
        val active = if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            val refreshed = JSONObject(request("/auth/refresh", "POST", JSONObject().put("refreshToken", session.refreshToken)))
            val user = refreshed.getJSONObject("user")
            AuthSessionData(
                SessionUser(user.getString("id"), user.getString("email"), user.getString("displayName")),
                refreshed.getString("accessToken"),
                refreshed.getString("refreshToken"),
                System.currentTimeMillis() + refreshed.optLong("expiresIn", 900L) * 1000L
            )
        } else session
        request(path, "DELETE", bearer = active.accessToken)
        active
    }

    suspend fun logout(refreshToken: String) = withContext(Dispatchers.IO) {
        request("/auth/logout", "POST", JSONObject().put("refreshToken", refreshToken))
    }

    suspend fun home(): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/home"))
    }

    suspend fun contents(type: String? = null, genre: String? = null): List<MediaItem> = withContext(Dispatchers.IO) {
        val params = mutableListOf<String>()
        type?.let { params += "type=$it" }
        genre?.let { params += "genre=${java.net.URLEncoder.encode(it, "UTF-8")}" }
        params += "limit=30"
        parseMedia(get("/contents?${params.joinToString("&")}"))
    }

    suspend fun genres(): List<Genre> = withContext(Dispatchers.IO) {
        val root = JSONObject(get("/genres"))
        val array = root.optJSONArray("genres") ?: return@withContext emptyList()
        buildList {
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val slug = item.optString("slug")
                val name = item.optString("name")
                if (slug.isNotBlank() && name.isNotBlank()) add(Genre(slug, name))
            }
        }
    }

    fun parseAccountItems(raw: String): List<MediaItem> = parseMedia(raw)

    fun parseHistory(raw: String): List<HistoryEntry> {
        val root = JSONObject(raw)
        val array = root.optJSONArray("items") ?: return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val entry = array.optJSONObject(i) ?: continue
                val content = entry.optJSONObject("content") ?: continue
                add(
                    HistoryEntry(
                        id = entry.optString("id"),
                        content = parseItem(content),
                        positionSeconds = entry.optInt("positionSeconds"),
                        durationSeconds = entry.optInt("durationSeconds").takeIf { it > 0 },
                        versionId = entry.optString("versionId").takeIf { it.isNotBlank() && it != "null" },
                        completed = entry.optBoolean("completed")
                    )
                )
            }
        }
    }

    suspend fun search(query: String): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/search?q=${java.net.URLEncoder.encode(query, "UTF-8")}"))
    }

    suspend fun detail(slug: String): MediaItem? = withContext(Dispatchers.IO) {
        runCatching { parseItem(JSONObject(get("/contents/${java.net.URLEncoder.encode(slug, "UTF-8")}"))) }.getOrNull()
    }

    suspend fun episodes(seasonId: String): List<EpisodeRef> = withContext(Dispatchers.IO) {
        val root = JSONObject(get("/seasons/${java.net.URLEncoder.encode(seasonId, "UTF-8")}/episodes"))
        val array = root.optJSONArray("episodes") ?: return@withContext emptyList()
        buildList {
            for (i in 0 until array.length()) {
                val e = array.optJSONObject(i) ?: continue
                val va = e.optJSONArray("versions") ?: continue
                val versions = buildList {
                    for (j in 0 until va.length()) {
                        val v = va.optJSONObject(j) ?: continue
                        val id = v.optString("id")
                        if (id.isNotBlank()) add(VideoVersion(id, v.optString("label").ifBlank { "Vidéo" }, v.optInt("height").takeIf { it > 0 }, v.optInt("durationSeconds").takeIf { it > 0 }))
                    }
                }
                add(EpisodeRef(e.optInt("number"), e.optString("title").ifBlank { "Épisode " + e.optInt("number") }, versions))
            }
        }.sortedBy { it.number }
    }

    private fun parseMedia(raw: String): List<MediaItem> {
        val root = JSONObject(raw)
        val result = mutableListOf<MediaItem>()
        val keys = listOf("newReleases", "trending", "newSeasons", "upcoming", "items", "contents", "results")
        keys.forEach { key ->
            val array = root.optJSONArray(key)
            if (array != null) {
                for (i in 0 until array.length()) {
                    array.optJSONObject(i)?.let { obj ->
                        val item = parseItem(obj)
                        if (result.none { it.id == item.id }) result += item
                    }
                }
            }
        }
        if (result.isEmpty()) {
            val data = root.optJSONObject("data")
            val array = data?.optJSONArray("items") ?: data?.optJSONArray("contents")
            if (array != null) for (i in 0 until array.length()) array.optJSONObject(i)?.let { result += parseItem(it) }
        }
        return result
    }

    private fun parseItem(obj: JSONObject): MediaItem {
        val source = obj.optJSONObject("content") ?: obj.optJSONObject("data") ?: obj
        val id = source.optString("id", source.optString("slug", source.optString("title", "item")))
        val posterObject = source.optJSONObject("primaryPoster") ?: source.optJSONObject("poster")
        val trailerObject = source.optJSONObject("primaryTrailer") ?: source.optJSONObject("trailer")
        val trailerUrl = source.optString("trailerUrl").takeIf { it.startsWith("https://") }
            ?: trailerObject?.optString("url")?.takeIf { it.startsWith("https://") }
        val poster = source.optString("posterUrl").takeIf { it.startsWith("http") }
            ?: source.optString("imageUrl").takeIf { it.startsWith("http") }
            ?: posterObject?.optString("url")?.takeIf { it.startsWith("http") }
        val versionsArray = source.optJSONArray("versions")
        val seasonsArray = source.optJSONArray("seasons")
        val seasons = buildList {
            if (seasonsArray != null) for (i in 0 until seasonsArray.length()) {
                val s = seasonsArray.optJSONObject(i) ?: continue
                val sid = s.optString("id")
                if (sid.isNotBlank()) add(SeasonRef(sid, s.optInt("number"), s.optString("title").ifBlank { "Saison " + s.optInt("number") }, s.optInt("episodeCount")))
            }
        }.sortedBy { it.number }
        val versions = buildList {
            if (versionsArray != null) for (index in 0 until versionsArray.length()) {
                val version = versionsArray.optJSONObject(index) ?: continue
                val versionId = version.optString("id")
                if (versionId.isBlank()) continue
                val height = version.optInt("height").takeIf { it > 0 }
                val label = version.optString("label").takeIf { it.isNotBlank() }
                    ?: height?.let { "${it}p" } ?: "Version vidéo ${index + 1}"
                add(VideoVersion(versionId, label, height, version.optInt("durationSeconds").takeIf { it > 0 }))
            }
        }
        return MediaItem(
            id = id,
            slug = source.optString("slug", id),
            title = source.optString("title", "Sans titre"),
            type = source.optString("type", "Film"),
            year = source.optString("year", ""),
            description = source.optString("description", ""),
            poster = poster,
            trailerUrl = trailerUrl,
            versions = versions,
            seasons = seasons
        )
    }
}

@Composable
private fun MoviesHubApp(incomingShareUri: Uri?, onIncomingShareConsumed: () -> Unit) {
    var screen by remember { mutableStateOf(Screen.HOME) }
    val backStack = remember { mutableStateListOf<Screen>() }
    val navigate: (Screen) -> Unit = { destination ->
        if (destination != screen) { backStack.add(screen); screen = destination }
    }
    val goBack: () -> Unit = {
        screen = if (backStack.isNotEmpty()) backStack.removeAt(backStack.lastIndex) else Screen.HOME
    }
    val context = LocalContext.current
    var importedVideos by remember { mutableStateOf(listSharedVideos(context)) }
    var transferNotice by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(incomingShareUri) {
        val uri = incomingShareUri
        if (uri != null) {
            runCatching { importSharedVideo(context, uri) }
                .onSuccess {
                    importedVideos = listSharedVideos(context)
                    transferNotice = "Vidéo reçue : ${it.title}"
                    screen = Screen.DOWNLOADS
                }
                .onFailure { transferNotice = it.message ?: "Réception impossible." }
            onIncomingShareConsumed()
        }
    }
    var session by remember { mutableStateOf(SecureSessionStore.read(context)) }
    val preferences = remember { context.getSharedPreferences("moviehub_preferences", 0) }
    var themeMode by remember {
        mutableStateOf(preferences.getString("theme", "Sombre") ?: "Sombre")
    }
    var appLanguage by remember {
        mutableStateOf(preferences.getString("language", null))
    }
    LaunchedEffect(themeMode) {
        preferences.edit().putString("theme", themeMode).apply()
    }
    LaunchedEffect(appLanguage) {
        appLanguage?.let { preferences.edit().putString("language", it).apply() }
    }
    var splash by remember { mutableStateOf(true) }
    BackHandler(enabled = !splash && screen != Screen.HOME) { goBack() }
    var selected by remember { mutableStateOf<MediaItem?>(null) }
    var offlinePlaybackPath by remember { mutableStateOf<String?>(null) }
    var offlinePlaybackTitle by remember { mutableStateOf<String?>(null) }
    var detailLoading by remember { mutableStateOf(false) }
    var searchText by remember { mutableStateOf("") }
    var activeFilter by remember { mutableStateOf("Tous") }
    var genres by remember { mutableStateOf<List<Genre>>(emptyList()) }
    var media by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var authError by remember { mutableStateOf<String?>(null) }
    var accountItems by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var accountLoading by remember { mutableStateOf(false) }
    var accountError by remember { mutableStateOf<String?>(null) }
    var historyIds by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var favoriteIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    LaunchedEffect(Unit) {
        delay(1400)
        splash = false
        loading = true
        runCatching { MoviesHubApi.home() }
            .onSuccess { media = it; error = null }
            .onFailure { error = "Connexion à l’API indisponible"; media = emptyList() }
        runCatching { MoviesHubApi.genres() }
            .onSuccess { genres = it }
        loading = false
    }

    val systemDark = isSystemInDarkTheme()
    val useDark = when (themeMode) { "Clair" -> false; "Système" -> systemDark; else -> true }
    val palette = if (useDark) {
        MoviePalette(Color(0xFF050608), Color(0xFF11151B), Color(0xFFFFC94A), Color(0xFF9AA1AC), Color.White)
    } else {
        MoviePalette(Color(0xFFF4F1E9), Color.White, Color(0xFF9A6500), Color(0xFF68645C), Color(0xFF191919))
    }
    CompositionLocalProvider(
        LocalMoviePalette provides palette,
        LocalMovieHubLanguage provides (appLanguage ?: "fr")
    ) {
    MaterialTheme(colorScheme = if (useDark) darkColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = palette.background, onBackground = palette.text, onSurface = palette.text
    ) else lightColorScheme(
        primary = palette.accent, background = palette.background, surface = palette.panel,
        onPrimary = Color.White, onBackground = palette.text, onSurface = palette.text
    )) {
        if (splash) {
            SplashScreen()
        } else if (appLanguage == null) {
            LanguageSelectionScreen(onSelect = { appLanguage = it })
        } else {
            Scaffold(
                containerColor = UiColors.background,
                bottomBar = {
                    if (screen in listOf(Screen.HOME, Screen.CATEGORIES, Screen.DOWNLOADS, Screen.PROFILE)) {
                        BottomNavigationBar(screen) { backStack.clear(); screen = it }
                    }
                }
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    when (screen) {
                        Screen.HOME -> HomeScreen(
                            media, loading, error,
                            onFilterChange = { filter ->
                                val type = when (filter) {
                                    "Films" -> "MOVIE"
                                    "Séries" -> "SERIES"
                                    "Animes" -> "ANIME"
                                    else -> null
                                }
                                scope.launch {
                                    loading = true
                                    runCatching { if (type == null) MoviesHubApi.home() else MoviesHubApi.contents(type) }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger cette catégorie" }
                                    loading = false
                                }
                            },
                            onCategories = { navigate(Screen.CATEGORIES) },
                            onSearch = { navigate(Screen.SEARCH) },
                            onSelect = { selected = it; navigate(Screen.DETAIL); detailLoading = true; scope.launch { MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }; detailLoading = false } }
                        )
                        Screen.CATEGORIES -> CategoriesScreen(
                            activeFilter, genres, media, loading,
                            onFilter = { category ->
                                activeFilter = category.slug
                                scope.launch {
                                    loading = true
                                    runCatching { MoviesHubApi.contents(genre = category.slug) }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger cette catégorie" }
                                    loading = false
                                }
                            },
                            onClearFilter = {
                                activeFilter = "Tous"
                                scope.launch {
                                    loading = true
                                    runCatching { MoviesHubApi.contents() }
                                        .onSuccess { media = it; error = null }
                                        .onFailure { error = "Impossible de charger le catalogue" }
                                    loading = false
                                }
                            },
                            onBack = { goBack() },
                            onSelect = {
                                selected = it
                                navigate(Screen.DETAIL)
                                detailLoading = true
                                scope.launch {
                                    MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }
                                    detailLoading = false
                                }
                            }
                        )
                        Screen.SEARCH -> SearchScreen(
                            query = searchText,
                            onQuery = { searchText = it },
                            onSelect = {
                                selected = it
                                navigate(Screen.DETAIL)
                                detailLoading = true
                                scope.launch {
                                    MoviesHubApi.detail(it.slug)?.let { fresh -> selected = fresh }
                                    detailLoading = false
                                }
                            }
                        )
                        Screen.DETAIL -> DetailScreen(
                            selected, detailLoading,
                            isFavorite = selected?.id in favoriteIds,
                            onBack = { goBack() },
                            onDownload = { version ->
                                if (session == null) navigate(Screen.AUTH)
                                else enqueuePrivateDownload(context, selected, version)
                            },
                            onFavorite = {
                                val item = selected
                                val current = session
                                if (item != null && current == null) navigate(Screen.AUTH)
                                else if (item != null && current != null) scope.launch {
                                    val wasFavorite = item.id in favoriteIds
                                    runCatching {
                                        if (wasFavorite) MoviesHubApi.deleteAuthorized("/me/favorites/${item.id}", current)
                                        else MoviesHubApi.putAuthorized("/me/favorites/${item.id}", current)
                                    }.onSuccess { updated ->
                                        session = updated
                                        SecureSessionStore.save(context, updated)
                                        favoriteIds = if (wasFavorite) favoriteIds - item.id else favoriteIds + item.id
                                    }.onFailure { accountError = it.message ?: "Action impossible" }
                                }
                            }
                        )
                        Screen.PLAYER -> PlayerScreen(
                            item = selected,
                            offlineFilePath = offlinePlaybackPath,
                            offlineTitle = offlinePlaybackTitle,
                            onBack = { goBack() }
                        )
                        Screen.DOWNLOADS -> DownloadsScreen(
                            importedVideos = importedVideos,
                            transferNotice = transferNotice,
                            onNoticeConsumed = { transferNotice = null },
                            onTransferError = { transferNotice = it },
                            onPlayOffline = { path, title ->
                                offlinePlaybackPath = path
                                offlinePlaybackTitle = title
                                selected = null
                                navigate(Screen.PLAYER)
                            },
                            onDeleteImported = { video ->
                                video.file.delete()
                                importedVideos = listSharedVideos(context)
                            }
                        )
                        Screen.PROFILE -> ProfileScreen(
                            session = session,
                            onLogin = { navigate(Screen.AUTH) },
                            onFavorites = {
                                if (session == null) navigate(Screen.AUTH) else {
                                    navigate(Screen.FAVORITES)
                                    accountLoading = true
                                    scope.launch {
                                        runCatching { MoviesHubApi.authorizedGet("/me/favorites", session!!) }
                                            .onSuccess { (updated, raw) ->
                                                session = updated
                                                SecureSessionStore.save(context, updated)
                                                accountItems = MoviesHubApi.parseAccountItems(raw)
                                                accountError = null
                                            }
                                            .onFailure { accountError = it.message ?: "Favoris indisponibles" }
                                        accountLoading = false
                                    }
                                }
                            },
                            onHistory = {
                                if (session == null) navigate(Screen.AUTH) else {
                                    navigate(Screen.HISTORY)
                                    accountLoading = true
                                    scope.launch {
                                        runCatching { MoviesHubApi.authorizedGet("/me/history", session!!) }
                                            .onSuccess { (updated, raw) ->
                                                session = updated
                                                SecureSessionStore.save(context, updated)
                                                val parsed = MoviesHubApi.parseHistory(raw)
                                                accountItems = parsed.map { it.content }
                                                historyIds = parsed.associate { it.content.id to it.id }
                                                accountError = null
                                            }
                                            .onFailure { accountError = it.message ?: "Historique indisponible" }
                                        accountLoading = false
                                    }
                                }
                            },
                            onLogout = {
                                val current = session
                                scope.launch {
                                    if (current != null) runCatching { MoviesHubApi.logout(current.refreshToken) }
                                    SecureSessionStore.clear(context)
                                    session = null
                                }
                            },
                            onSettings = { navigate(Screen.SETTINGS) }
                        )
                        Screen.FAVORITES -> AccountListScreen(
                            title = "Mes favoris", items = accountItems, loading = accountLoading, error = accountError,
                            onBack = { goBack() }, onSelect = { selected = it; navigate(Screen.DETAIL) },
                            onRemove = { item ->
                                val current = session
                                if (current != null) scope.launch {
                                    runCatching { MoviesHubApi.deleteAuthorized("/me/favorites/${item.id}", current) }
                                        .onSuccess { updated ->
                                            session = updated; SecureSessionStore.save(context, updated)
                                            accountItems = accountItems.filterNot { it.id == item.id }
                                        }
                                        .onFailure { accountError = it.message ?: "Suppression impossible" }
                                }
                            }
                        )
                        Screen.HISTORY -> AccountListScreen(
                            title = "Historique", items = accountItems, loading = accountLoading, error = accountError,
                            onBack = { goBack() }, onSelect = { selected = it; navigate(Screen.DETAIL) },
                            onRemove = { item ->
                                val historyId = historyIds[item.id]
                                val current = session
                                if (historyId != null && current != null) scope.launch {
                                    runCatching { MoviesHubApi.deleteAuthorized("/me/history/$historyId", current) }
                                        .onSuccess { updated ->
                                            session = updated; SecureSessionStore.save(context, updated)
                                            accountItems = accountItems.filterNot { it.id == item.id }
                                        }
                                        .onFailure { accountError = it.message ?: "Suppression impossible" }
                                }
                            }
                        )
                        Screen.AUTH -> AuthScreen(
                            error = authError,
                            onErrorConsumed = { authError = null },
                            onBack = { goBack() },
                            onSubmit = { email, password, displayName, register ->
                                scope.launch {
                                    runCatching { MoviesHubApi.authenticate(email, password, displayName, register) }
                                        .onSuccess {
                                            SecureSessionStore.save(context, it)
                                            session = it
                                            goBack()
                                        }
                                        .onFailure { authError = it.message ?: "Connexion impossible" }
                                }
                            }
                        )
                        Screen.SETTINGS -> SettingsScreen(
                            themeMode = themeMode,
                            language = appLanguage ?: "fr",
                            onThemeChange = { themeMode = it },
                            onLanguageChange = { appLanguage = it },
                            onBack = { goBack() }
                        )
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun LanguageSelectionScreen(onSelect: (String) -> Unit) {
    Column(
        Modifier.fillMaxSize().background(UiColors.background).verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Image(
            painter = painterResource(id = R.drawable.moviehub_logo),
            contentDescription = "MovieHub",
            modifier = Modifier.size(116.dp),
            contentScale = ContentScale.Fit
        )
        Spacer(Modifier.height(22.dp))
        MovieHubText("Choisis ta langue", color = UiColors.text, fontSize = 25.sp, fontWeight = FontWeight.ExtraBold)
        Spacer(Modifier.height(8.dp))
        MovieHubText(
            "La langue pourra être modifiée à tout moment dans les paramètres.",
            color = UiColors.muted,
            fontSize = 13.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center
        )
        Spacer(Modifier.height(24.dp))
        MovieHubLanguages.options.forEach { option ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 5.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(UiColors.panel)
                    .clickable { onSelect(option.code) }
                    .padding(horizontal = 18.dp, vertical = 18.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                MovieHubText(option.nativeName, color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
            }
        }
    }
}

@Composable
private fun SplashScreen() {
    Box(Modifier.fillMaxSize().background(
        Brush.verticalGradient(listOf(Color(0xFF08090D), UiColors.background, Color(0xFF090B12)))
    ), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Image(
                painter = painterResource(id = R.drawable.moviehub_logo),
                contentDescription = "Logo MovieHub",
                modifier = Modifier.size(132.dp),
                contentScale = ContentScale.Fit
            )
            MovieHubText("Tes films, séries et animés\nau même endroit", color = UiColors.text, fontSize = 14.sp, lineHeight = 21.sp)
            Spacer(Modifier.height(95.dp))
            LinearProgressIndicator(color = UiColors.accent, trackColor = Color(0xFF332B1B), modifier = Modifier.width(170.dp))
            MovieHubText("Chargement…", color = UiColors.muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun BottomNavigationBar(screen: Screen, onNavigate: (Screen) -> Unit) {
    NavigationBar(containerColor = Color(0xFF090B0F), contentColor = UiColors.accent) {
        val entries = listOf(
            Triple(Screen.HOME, "Accueil", Icons.Default.Home),
            Triple(Screen.CATEGORIES, "Catégories", Icons.Default.GridView),
            Triple(Screen.DOWNLOADS, "Téléchargements", Icons.Default.Download),
            Triple(Screen.PROFILE, "Profil", Icons.Default.Person)
        )
        entries.forEach { (destination, label, icon) ->
            NavigationBarItem(
                selected = screen == destination || (destination == Screen.HOME && screen in listOf(Screen.SEARCH, Screen.DETAIL, Screen.PLAYER)),
                onClick = { onNavigate(destination) },
                icon = { Icon(icon, contentDescription = label) },
                label = { MovieHubText(label, fontSize = 10.sp) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = UiColors.accent, selectedTextColor = UiColors.accent,
                    unselectedIconColor = UiColors.muted, unselectedTextColor = UiColors.muted,
                    indicatorColor = Color(0xFF30240E)
                )
            )
        }
    }
}

@Composable
private fun Header(title: String = "MoviesHub", onCategories: (() -> Unit)? = null, onSearch: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (title == "MoviesHub") {
            Image(painterResource(R.drawable.moviehub_logo), contentDescription = "Logo MovieHub", modifier = Modifier.size(38.dp), contentScale = ContentScale.Fit)
            Spacer(Modifier.width(10.dp))
        }
        MovieHubText(title, color = UiColors.accent, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        if (onSearch != null) IconButton(onClick = onSearch) { Icon(Icons.Default.Search, "Recherche", tint = UiColors.text) }
    }
}

@Composable
private fun FilterChips(active: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("Tous", "Films", "Séries", "Animes").forEach { label ->
            FilterChip(
                selected = active == label, onClick = { onSelect(label) }, label = { MovieHubText(label) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = UiColors.accent, selectedLabelColor = UiColors.background,
                    containerColor = UiColors.panel, labelColor = UiColors.text
                ),
                border = null
            )
        }
    }
}

@Composable
private fun HomeScreen(
    media: List<MediaItem>, loading: Boolean, error: String?,
    onFilterChange: (String) -> Unit,
    onCategories: () -> Unit, onSearch: () -> Unit, onSelect: (MediaItem) -> Unit
) {
    var filter by remember { mutableStateOf("Tous") }
    val featured = media.firstOrNull()
    val remaining = media.drop(1)

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        item {
            Row(
                Modifier.fillMaxWidth().padding(start = 18.dp, end = 10.dp, top = 14.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Image(
                    painterResource(R.drawable.moviehub_logo),
                    contentDescription = "Logo MovieHub",
                    modifier = Modifier.size(42.dp),
                    contentScale = ContentScale.Fit
                )
                Column(Modifier.weight(1f).padding(start = 10.dp)) {
                    MovieHubText("MOVIEHUB", color = UiColors.text, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.5.sp)
                    MovieHubText("Ton prochain univers commence ici", color = UiColors.muted, fontSize = 10.sp)
                }
                IconButton(onClick = onSearch) {
                    Icon(Icons.Default.Search, "Rechercher", tint = UiColors.text, modifier = Modifier.size(25.dp))
                }
                IconButton(onClick = onCategories) {
                    Icon(Icons.Default.GridView, "Explorer", tint = UiColors.accent)
                }
            }
        }
        item {
            MovieHubText(
                "À LA UNE",
                color = UiColors.accent,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
                modifier = Modifier.padding(start = 18.dp, top = 18.dp, bottom = 8.dp)
            )
        }
        item {
            if (featured != null) {
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp)
                        .height(310.dp).clip(RoundedCornerShape(22.dp))
                        .background(UiColors.panel)
                ) {
                    if (!featured.poster.isNullOrBlank()) {
                        AsyncImage(
                            featured.poster,
                            contentDescription = featured.title,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop
                        )
                    }
                    Box(
                        Modifier.fillMaxSize().background(
                            Brush.verticalGradient(
                                0.0f to Color(0x22000000),
                                0.35f to Color(0x44000000),
                                1.0f to Color(0xF5050608)
                            )
                        )
                    )
                    Column(
                        Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        MovieHubText(
                            "SÉLECTION MOVIEHUB",
                            color = UiColors.accent,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 1.8.sp
                        )
                        MovieHubText(
                            featured.title,
                            color = Color.White,
                            fontSize = 27.sp,
                            lineHeight = 31.sp,
                            fontWeight = FontWeight.ExtraBold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        MovieHubText(
                            listOf(featured.type, featured.year).filter { it.isNotBlank() }.joinToString("  •  "),
                            color = Color.White.copy(alpha = .78f),
                            fontSize = 12.sp
                        )
                        MovieHubText(
                            featured.description.ifBlank { "Retrouve ce contenu dans le catalogue MovieHub." },
                            color = Color.White.copy(alpha = .78f),
                            fontSize = 12.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        Button(
                            onClick = { onSelect(featured) },
                            colors = ButtonDefaults.buttonColors(
                                containerColor = UiColors.accent,
                                contentColor = Color(0xFF100D07)
                            ),
                            shape = RoundedCornerShape(12.dp),
                            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp)
                        ) {
                            Icon(Icons.Default.Info, null, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.width(7.dp))
                            MovieHubText("Voir les détails", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            } else if (loading) {
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp).height(250.dp)
                        .clip(RoundedCornerShape(22.dp)).background(UiColors.panel),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(color = UiColors.accent)
                }
            } else {
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp).height(220.dp)
                        .clip(RoundedCornerShape(22.dp)).background(UiColors.panel),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
                        Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(42.dp))
                        Spacer(Modifier.height(12.dp))
                        MovieHubText("Le cinéma, à portée de main.", color = UiColors.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        MovieHubText(
                            error ?: "Les nouveautés apparaîtront ici dès leur publication.",
                            color = UiColors.muted, fontSize = 12.sp
                        )
                    }
                }
            }
        }
        item {
            MovieHubText(
                "EXPLORER LE CATALOGUE",
                color = UiColors.muted,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.6.sp,
                modifier = Modifier.padding(start = 18.dp, top = 22.dp, bottom = 8.dp)
            )
        }
        item {
            FilterChips(filter) {
                filter = it
                onFilterChange(it)
            }
        }
        item { SectionTitle("Tendances", "À découvrir") }
        if (loading && media.isEmpty()) {
            item { LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp)) }
        }
        if (error != null && media.isEmpty()) {
            item { EmptyMessage(error) }
        }
        if (media.isNotEmpty()) {
            item {
                androidx.compose.foundation.lazy.LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(13.dp)
                ) {
                    items(media.take(14), key = { it.id }) { item ->
                        Column(
                            Modifier.width(142.dp).clickable { onSelect(item) },
                            verticalArrangement = Arrangement.spacedBy(7.dp)
                        ) {
                            Box(
                                Modifier.fillMaxWidth().height(204.dp)
                                    .clip(RoundedCornerShape(14.dp)).background(UiColors.panel)
                            ) {
                                if (!item.poster.isNullOrBlank()) {
                                    AsyncImage(item.poster, item.title, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                                } else {
                                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(38.dp))
                                    }
                                }
                                Box(
                                    Modifier.align(Alignment.TopStart).padding(8.dp)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(Color(0xCC090B0F)).padding(horizontal = 7.dp, vertical = 4.dp)
                                ) {
                                    MovieHubText(item.type.uppercase(), color = UiColors.accent, fontSize = 8.sp, fontWeight = FontWeight.Bold)
                                }
                            }
                            MovieHubText(item.title, color = UiColors.text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 13.sp)
                            MovieHubText(item.year.ifBlank { "Découvrir" }, color = UiColors.muted, fontSize = 11.sp)
                        }
                    }
                }
            }
        } else if (!loading && error == null) {
            item { EmptyMessage("Le catalogue apparaîtra ici dès que des contenus seront publiés.") }
        }
        if (remaining.isNotEmpty()) {
            item { SectionTitle("À explorer", "Catalogue") }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    remaining.take(6).forEach { item ->
                        MediaPoster(item) { onSelect(item) }
                    }
                }
            }
        }
        item {
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = onCategories, modifier = Modifier.fillMaxWidth()) {
                MovieHubText("Explorer toutes les catégories", color = UiColors.accent, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Default.ArrowForward, null, tint = UiColors.accent)
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, action: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        MovieHubText(title, color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        MovieHubText(action, color = UiColors.accent, fontSize = 12.sp)
    }
}

@Composable
private fun MediaPoster(item: MediaItem, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(15.dp))
            .background(UiColors.panel)
            .clickable(onClick = onClick)
            .padding(9.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier.size(76.dp, 104.dp).clip(RoundedCornerShape(10.dp))
                .background(Color(0xFF202630))
        ) {
            if (!item.poster.isNullOrBlank()) {
                AsyncImage(item.poster, item.title, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(30.dp))
                }
            }
        }
        Column(
            Modifier.weight(1f).padding(start = 13.dp, end = 8.dp),
            verticalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            MovieHubText(item.title, color = UiColors.text, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            MovieHubText(
                listOf(item.type, item.year).filter { it.isNotBlank() }.joinToString("  •  "),
                color = UiColors.accent, fontSize = 11.sp, fontWeight = FontWeight.Medium
            )
            if (item.description.isNotBlank()) {
                MovieHubText(item.description, color = UiColors.muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            MovieHubText("Voir la fiche", color = UiColors.text.copy(alpha = .75f), fontSize = 10.sp)
        }
        Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
    }
}

@Composable
private fun CategoriesScreen(
    active: String,
    genres: List<Genre>,
    media: List<MediaItem>,
    loading: Boolean,
    onFilter: (Genre) -> Unit,
    onClearFilter: () -> Unit,
    onBack: () -> Unit,
    onSelect: (MediaItem) -> Unit
) {
    val activeName = genres.firstOrNull { it.slug == active }?.name ?: active
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            MovieHubText("Explorer", color = UiColors.text, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.weight(1f))
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
        }
        if (active == "Tous") {
            MovieHubText("Choisis un univers", color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp))
            if (genres.isEmpty()) {
                EmptyMessage("Les catégories apparaîtront ici dès qu'elles seront disponibles dans le catalogue.")
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(14.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(genres.size) { index ->
                        val category = genres[index]
                        Column(
                            Modifier.fillMaxWidth().height(112.dp).clip(RoundedCornerShape(16.dp))
                                .background(Brush.linearGradient(listOf(Color(0xFF302719), UiColors.panel)))
                                .clickable { onFilter(category) }.padding(14.dp),
                            verticalArrangement = Arrangement.SpaceBetween
                        ) {
                            Icon(
                                when (category.name.lowercase()) {
                                    "action" -> Icons.Default.Bolt
                                    "aventure" -> Icons.Default.Explore
                                    "comédie", "comedie" -> Icons.Default.TheaterComedy
                                    "drame" -> Icons.Default.Theaters
                                    "horreur" -> Icons.Default.DarkMode
                                    "science-fiction", "science fiction" -> Icons.Default.RocketLaunch
                                    "fantastique" -> Icons.Default.AutoAwesome
                                    else -> Icons.Default.Movie
                                }, null, tint = UiColors.accent, modifier = Modifier.size(25.dp)
                            )
                            MovieHubText(category.name, color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        }
                    }
                }
            }
        } else {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                MovieHubText(activeName, color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = onClearFilter) { MovieHubText("Toutes", color = UiColors.accent) }
            }
            if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp))
            if (!loading && media.isEmpty()) EmptyMessage("Aucun résultat pour cette catégorie pour le moment.")
            LazyColumn(contentPadding = PaddingValues(bottom = 20.dp)) {
                items(media) { item -> MediaPoster(item) { onSelect(item) } }
            }
        }
    }
}

@Composable
private fun SearchScreen(query: String, onQuery: (String) -> Unit, onSelect: (MediaItem) -> Unit) {
    var results by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(query) {
        val term = query.trim()
        results = emptyList()
        error = null
        if (term.length < 2) {
            loading = false
        } else {
            loading = true
            delay(350)
            runCatching { MoviesHubApi.search(term) }
                .onSuccess { results = it }
                .onFailure { error = "La recherche est momentanément indisponible." }
            loading = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        Header("Recherche")
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { MovieHubText("Film, série, anime…", color = UiColors.muted) },
            singleLine = true,
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { onQuery("") }) {
                        Icon(Icons.Default.Close, "Effacer la recherche", tint = UiColors.muted)
                    }
                } else {
                    Icon(Icons.Default.Search, null, tint = UiColors.accent)
                }
            },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = UiColors.accent,
                unfocusedBorderColor = Color(0xFF343A44),
                focusedTextColor = UiColors.text,
                unfocusedTextColor = UiColors.text
            )
        )

        when {
            query.trim().length < 2 -> {
                Column(
                    Modifier.fillMaxWidth().weight(1f).padding(28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(Icons.Default.Search, null, tint = UiColors.accent, modifier = Modifier.size(48.dp))
                    Spacer(Modifier.height(12.dp))
                    MovieHubText("Que veux-tu regarder ?", color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    MovieHubText("Saisis au moins deux caractères pour rechercher dans le catalogue.", color = UiColors.muted, fontSize = 13.sp)
                }
            }
            loading -> {
                LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth().padding(16.dp))
                MovieHubText("Recherche en cours…", color = UiColors.muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp))
            }
            error != null -> {
                EmptyMessage(error!!)
            }
            results.isEmpty() -> {
                EmptyMessage("Aucun résultat pour « ${query.trim()} ». Essaie un autre titre.")
            }
            else -> {
                MovieHubText(
                    "${results.size} résultat(s)",
                    color = UiColors.accent,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                )
                LazyColumn(contentPadding = PaddingValues(bottom = 20.dp)) {
                    items(results, key = { it.id }) { item ->
                        MediaPoster(item) { onSelect(item) }
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailScreen(item: MediaItem?, loading: Boolean, isFavorite: Boolean, onBack: () -> Unit, onDownload: (VideoVersion) -> Unit, onFavorite: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Box(
            Modifier.fillMaxWidth().height(390.dp)
                .background(Color(0xFF10141B))
        ) {
            if (!item?.poster.isNullOrBlank()) {
                AsyncImage(
                    item?.poster,
                    item?.title,
                    Modifier.fillMaxSize(),
                    contentScale = ContentScale.Crop
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Movie, null, tint = UiColors.accent, modifier = Modifier.size(70.dp))
                }
            }
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(
                        0.0f to Color(0x55000000),
                        0.45f to Color(0x33000000),
                        1.0f to Color(0xFF050608)
                    )
                )
            )
            IconButton(
                onClick = onBack,
                modifier = Modifier.align(Alignment.TopStart).padding(10.dp)
                    .clip(RoundedCornerShape(50)).background(Color(0x99090B0F))
            ) {
                Icon(Icons.Default.ArrowBack, "Retour", tint = Color.White)
            }
            Column(
                Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp)
            ) {
                MovieHubText("FICHE DU CONTENU", color = UiColors.accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.6.sp)
                MovieHubText(item?.title ?: "Détails", color = Color.White, fontSize = 28.sp, lineHeight = 32.sp, fontWeight = FontWeight.ExtraBold)
                MovieHubText(
                    listOf(item?.type ?: "Film", item?.year ?: "").filter { it.isNotBlank() }.joinToString("  •  "),
                    color = Color.White.copy(alpha = .8f), fontSize = 12.sp
                )
            }
        }
        Column(Modifier.padding(horizontal = 18.dp, vertical = 18.dp)) {
            if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth())
            MovieHubText("Synopsis", color = UiColors.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            MovieHubText(
                item?.description?.ifBlank { "La description sera affichée à partir des métadonnées du catalogue." }
                    ?: "Les informations du contenu seront chargées depuis MovieHub.",
                color = UiColors.muted, fontSize = 13.sp, lineHeight = 20.sp
            )
            Spacer(Modifier.height(22.dp))
            if (!item?.versions.isNullOrEmpty()) {
                MovieHubText("Télécharge une version pour la regarder hors connexion.", color = UiColors.muted, fontSize = 12.sp)
            }
            if (!item?.versions.isNullOrEmpty()) {
                Spacer(Modifier.height(12.dp))
                MovieHubText("TÉLÉCHARGER POUR REGARDER HORS CONNEXION", color = UiColors.accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
                item?.versions.orEmpty().forEach { version ->
                    OutlinedButton(
                        onClick = { onDownload(version) },
                        modifier = Modifier.fillMaxWidth().padding(top = 7.dp),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
                    ) {
                        Icon(Icons.Default.Download, null)
                        Spacer(Modifier.width(8.dp))
                        MovieHubText("Télécharger ${version.label}")
                    }
                }
            }
            Spacer(Modifier.height(9.dp))
            OutlinedButton(
                onClick = onFavorite,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(13.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
            ) {
                Icon(if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, null)
                Spacer(Modifier.width(7.dp))
                MovieHubText(if (isFavorite) "Retirer des favoris" else "Ajouter aux favoris")
            }
            Spacer(Modifier.height(10.dp))
            MovieHubText(
                "Télécharge une version pour la regarder hors connexion.",
                color = UiColors.muted, fontSize = 11.sp, lineHeight = 16.sp
            )
            Spacer(Modifier.height(22.dp))
        }
    }
}

@Composable
private fun PlayerScreen(
    item: MediaItem?,
    offlineFilePath: String?,
    offlineTitle: String?,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val file = remember(offlineFilePath) { offlineFilePath?.let(::File) }
    val playableFile = remember(file) { file?.takeIf { it.isFile && it.canRead() } }
    val prefs = remember(context) { context.getSharedPreferences("moviehub_offline_progress", Context.MODE_PRIVATE) }
    val key = remember(file) { file?.absolutePath?.hashCode()?.let { "position_$it" } }
    var resumeMs by remember(key) { mutableLongStateOf(key?.let { prefs.getLong(it, 0L) } ?: 0L) }
    val videoUri = remember(playableFile) { playableFile?.toURI()?.toString() }
    val error = when { offlineFilePath == null -> "Télécharge d’abord cette vidéo pour la regarder hors connexion."; playableFile == null -> "Fichier hors connexion introuvable."; else -> null }
    fun saveProgress(position: Long, duration: Long) {
        val progressKey = key ?: return
        prefs.edit().putLong(progressKey, position.coerceAtLeast(0L)).putLong("${progressKey}_duration", duration.coerceAtLeast(0L)).apply()
        resumeMs = position.coerceAtLeast(0L)
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = UiColors.text) }
            MovieHubText(offlineTitle ?: item?.title ?: "Lecteur hors connexion", color = UiColors.text, fontWeight = FontWeight.Bold)
        }
        MovieHubText("Lecture hors connexion", color = UiColors.accent, fontWeight = FontWeight.SemiBold)
        if (resumeMs > 5_000L) {
            val minutes = resumeMs / 60_000L
            val seconds = (resumeMs / 1_000L) % 60L
            MovieHubText("Reprise locale à ${minutes}:${seconds.toString().padStart(2, '0')}", color = UiColors.accent, fontSize = 12.sp)
        }
        error?.let { MovieHubText(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        if (videoUri == null) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Color(0xFF171D26)), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.DownloadForOffline, null, tint = UiColors.accent, modifier = Modifier.size(46.dp))
                    MovieHubText("Vidéo non disponible hors connexion", color = UiColors.muted, fontSize = 12.sp)
                }
            }
        } else {
            val player = remember(videoUri) {
                ExoPlayer.Builder(context).build().apply {
                    setMediaItem(PlayerMediaItem.fromUri(videoUri))
                    if (resumeMs > 5_000L) seekTo(resumeMs)
                    prepare()
                    playWhenReady = true
                }
            }
            LaunchedEffect(player, key) {
                while (true) {
                    delay(5_000)
                    saveProgress(player.currentPosition, player.duration)
                }
            }
            DisposableEffect(player, lifecycleOwner, key) {
                val observer = LifecycleEventObserver { _, event ->
                    when (event) {
                        Lifecycle.Event.ON_PAUSE -> { saveProgress(player.currentPosition, player.duration); player.pause() }
                        Lifecycle.Event.ON_RESUME -> if (player.playbackState != androidx.media3.common.Player.STATE_ENDED) player.play()
                        else -> Unit
                    }
                }
                lifecycleOwner.lifecycle.addObserver(observer)
                onDispose {
                    lifecycleOwner.lifecycle.removeObserver(observer)
                    saveProgress(player.currentPosition, player.duration)
                    player.release()
                }
            }
            AndroidView(factory = { viewContext -> PlayerView(viewContext).apply { this.player = player; useController = true } }, update = { it.player = player }, modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)))
        }
        MovieHubText("Cette vidéo est lue depuis le stockage privé de cet appareil. La position de lecture est enregistrée localement.", color = UiColors.muted, fontSize = 12.sp)
    }
}

private fun enqueuePrivateDownload(context: Context, item: MediaItem?, version: VideoVersion, titleOverride: String? = null) {
    val title = titleOverride ?: item?.title ?: "Film MovieHub"
    val request = OneTimeWorkRequestBuilder<PrivateDownloadWorker>()
        .setInputData(
            Data.Builder()
                .putString("versionId", version.id)
                .putString("title", title)
                .putString("versionLabel", version.label)
                .build()
        )
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .addTag(PrivateDownloadWorker.TAG)
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
        "moviehub-download-${version.id}",
        ExistingWorkPolicy.REPLACE,
        request
    )
}

@Composable
private fun DownloadsScreen(
    importedVideos: List<SharedVideo>,
    transferNotice: String?,
    onNoticeConsumed: () -> Unit,
    onTransferError: (String) -> Unit,
    onPlayOffline: (String, String) -> Unit,
    onDeleteImported: (SharedVideo) -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val workInfos by WorkManager.getInstance(context).getWorkInfosByTagLiveData(PrivateDownloadWorker.TAG).observeAsState(emptyList())
    var transferMode by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Téléchargements")
        MovieHubText("Ta bibliothèque hors connexion", color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 2.dp, vertical = 6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            listOf("Partager", "Recevoir").forEach { action ->
                OutlinedButton(onClick = { transferMode = action }, modifier = Modifier.weight(1f), colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)) {
                    Icon(if (action == "Partager") Icons.Default.Share else Icons.Default.Download, null)
                    Spacer(Modifier.width(6.dp)); MovieHubText(action)
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        transferNotice?.let { notice ->
            Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    MovieHubText(notice, color = UiColors.accent, modifier = Modifier.weight(1f), fontSize = 12.sp)
                    IconButton(onClick = onNoticeConsumed) { Icon(Icons.Default.Close, "Fermer", tint = UiColors.muted) }
                }
            }
        }
        if (workInfos.isEmpty() && importedVideos.isEmpty()) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.DownloadForOffline, null, tint = UiColors.accent, modifier = Modifier.size(62.dp))
                    Spacer(Modifier.height(14.dp))
                    MovieHubText("Aucun téléchargement", color = UiColors.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    MovieHubText("Les vidéos enregistrées apparaîtront ici.", color = UiColors.muted, fontSize = 13.sp)
                    MovieHubText("Les fichiers terminés restent dans l’espace privé de MovieHub, invisibles dans la galerie publique.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp))
                }
            }
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(importedVideos, key = { "shared-${it.file.absolutePath}" }) { video ->
                    Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            MovieHubText(video.title, color = UiColors.text, fontWeight = FontWeight.Bold)
                            MovieHubText("Reçu depuis un autre appareil • stocké en privé", color = UiColors.muted, fontSize = 11.sp)
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(
                                    onClick = { onPlayOffline(video.file.absolutePath, video.title) },
                                    modifier = Modifier.weight(1f),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
                                ) { Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(5.dp)); MovieHubText("Lire") }
                                OutlinedButton(
                                    onClick = { runCatching { sharePrivateVideo(context, video.file, video.title) }.onFailure { onTransferError(it.message ?: "Partage impossible.") } },
                                    modifier = Modifier.weight(1f),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
                                ) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(5.dp)); MovieHubText("Partager") }
                                IconButton(onClick = { onDeleteImported(video) }) {
                                    Icon(Icons.Default.DeleteOutline, "Supprimer", tint = MaterialTheme.colorScheme.error)
                                }
                            }
                        }
                    }
                }
                items(workInfos, key = { it.id }) { info ->
                    val title = info.outputData.getString("title") ?: info.progress.getString("title") ?: "Téléchargement MovieHub"
                    val label = info.outputData.getString("versionLabel") ?: info.progress.getString("versionLabel") ?: "Vidéo"
                    val percent = info.progress.getInt("progressPercent", if (info.state == WorkInfo.State.SUCCEEDED) 100 else 0)
                    Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            MovieHubText(title, color = UiColors.text, fontWeight = FontWeight.Bold)
                            MovieHubText(label, color = UiColors.muted, fontSize = 12.sp)
                            when (info.state) {
                                WorkInfo.State.RUNNING, WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> {
                                    LinearProgressIndicator(progress = { percent / 100f }, color = UiColors.accent, modifier = Modifier.fillMaxWidth())
                                    MovieHubText(if (info.state == WorkInfo.State.RUNNING) "Téléchargement : $percent %" else "En attente du réseau…", color = UiColors.muted, fontSize = 11.sp)
                                    TextButton(onClick = { WorkManager.getInstance(context).cancelWorkById(info.id) }) { MovieHubText("Mettre en pause", color = UiColors.accent) }
                                }
                                WorkInfo.State.SUCCEEDED -> {
                                    MovieHubText("Téléchargement terminé • enregistré en privé", color = UiColors.accent, fontSize = 12.sp)
                                    val filePath = info.outputData.getString("filePath")
                                    val savedFile = filePath?.let { File(it) }
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        OutlinedButton(
                                            onClick = { if (savedFile?.isFile == true) onPlayOffline(savedFile.absolutePath, title) },
                                            enabled = savedFile?.isFile == true,
                                            modifier = Modifier.weight(1f),
                                            colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
                                        ) {
                                            Icon(Icons.Default.PlayArrow, null)
                                            Spacer(Modifier.width(5.dp))
                                            MovieHubText("Lire hors connexion")
                                        }
                                        OutlinedButton(
                                            onClick = { savedFile?.let { file -> runCatching { sharePrivateVideo(context, file, title) }.onFailure { onTransferError(it.message ?: "Partage impossible.") } } },
                                            modifier = Modifier.weight(1f),
                                            colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)
                                        ) {
                                            Icon(Icons.Default.Share, null)
                                            Spacer(Modifier.width(5.dp))
                                            MovieHubText("Partager")
                                        }
                                        OutlinedButton(
                                            onClick = {
                                                scope.launch {
                                                    savedFile?.delete()
                                                    WorkManager.getInstance(context).pruneWork()
                                                }
                                            },
                                            modifier = Modifier.weight(1f),
                                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
                                        ) {
                                            Icon(Icons.Default.DeleteOutline, null)
                                            Spacer(Modifier.width(5.dp))
                                            MovieHubText("Supprimer")
                                        }
                                    }
                                }
                                WorkInfo.State.CANCELLED -> {
                                    MovieHubText("En pause • fichier partiel conservé en privé", color = UiColors.muted, fontSize = 12.sp)
                                    val versionId = info.progress.getString("versionId")
                                    if (versionId != null) {
                                        TextButton(onClick = { enqueuePrivateDownload(context, null, VideoVersion(versionId, label, null, null), title) }) {
                                            MovieHubText("Reprendre", color = UiColors.accent)
                                        }
                                    }
                                }
                                WorkInfo.State.FAILED -> MovieHubText(info.outputData.getString("error") ?: "Échec du téléchargement", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                            }
                        }
                    }
                }
            }
        }
        if (transferMode != null) {
            Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    MovieHubText(if (transferMode == "Partager") "Envoyer un téléchargement" else "Recevoir un fichier", color = UiColors.text, fontWeight = FontWeight.Bold)
                    MovieHubText(
                        if (transferMode == "Partager")
                            "Utilise le bouton Partager d’une vidéo téléchargée. Android proposera Quick Share, Bluetooth ou les applications compatibles."
                        else
                            "Sur l’autre appareil, reçois la vidéo avec Quick Share, puis ouvre-la depuis les fichiers et choisis MovieHub. Elle sera copiée dans l’espace privé de l’application.",
                        color = UiColors.muted, fontSize = 12.sp
                    )
                    TextButton(onClick = { transferMode = null }) { MovieHubText("Fermer", color = UiColors.accent) }
                }
            }
        }
    }
}

@Composable
private fun ShareScreen() {
    var mode by remember { mutableStateOf("Envoyer") }
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Header("Partage")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("Envoyer", "Recevoir").forEach { option ->
                FilterChip(selected = mode == option, onClick = { mode = option }, label = { MovieHubText(option) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = UiColors.accent, selectedLabelColor = UiColors.background, labelColor = UiColors.text),
                    border = null)
            }
        }
        Spacer(Modifier.height(35.dp))
        Icon(Icons.Default.Devices, null, tint = UiColors.accent, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(18.dp))
        MovieHubText(if (mode == "Envoyer") "Partager tes fichiers" else "Recevoir des fichiers", color = UiColors.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        MovieHubText("Transfert local entre appareils, sans passer par le stockage cloud.", color = UiColors.muted, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        Button(onClick = {}, colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)) {
            MovieHubText(if (mode == "Envoyer") "Choisir un fichier" else "Rechercher un appareil")
        }
        MovieHubText("Le transfert Wi-Fi direct et l’appairage QR seront implémentés dans une étape dédiée.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 22.dp))
    }
}

@Composable
private fun ProfileScreen(session: AuthSessionData?, onLogin: () -> Unit, onFavorites: () -> Unit, onHistory: () -> Unit, onLogout: () -> Unit, onSettings: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Profil")
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.AccountCircle, null, tint = UiColors.accent, modifier = Modifier.size(76.dp))
                MovieHubText(session?.user?.displayName ?: "Bienvenue sur MovieHub", color = UiColors.text, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                MovieHubText(session?.user?.email ?: "Connecte-toi pour synchroniser tes favoris et ton historique.", color = UiColors.muted, fontSize = 12.sp)
                if (session == null) {
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onLogin, colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)) {
                        MovieHubText("Se connecter / Créer un compte")
                    }
                } else {
                    Spacer(Modifier.height(8.dp))
                    MovieHubText("Compte connecté", color = UiColors.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(24.dp))
        Card(colors = CardDefaults.cardColors(containerColor = UiColors.panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                MovieHubText("Sécurité du compte", color = UiColors.text, fontWeight = FontWeight.SemiBold)
                MovieHubText(if (session == null) "Aucune session active" else "Session active • jetons protégés sur cet appareil", color = UiColors.muted, fontSize = 12.sp)
                MovieHubText("Les identifiants de session sont stockés de manière chiffrée et ne sont jamais affichés.", color = UiColors.muted, fontSize = 11.sp)
            }
        }
        if (session != null) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = UiColors.accent)) {
                Icon(Icons.Default.Logout, null); Spacer(Modifier.width(8.dp)); MovieHubText("Se déconnecter")
            }
        }
        Spacer(Modifier.height(12.dp))
        listOf("Mes favoris" to onFavorites, "Historique de visionnage" to onHistory).forEach { (label, action) ->
            Row(Modifier.fillMaxWidth().clickable(onClick = action).padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                MovieHubText(label, color = UiColors.text, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
            }
            HorizontalDivider(color = Color(0xFF242932))
        }
        Row(Modifier.fillMaxWidth().clickable(onClick = onSettings).padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Settings, null, tint = UiColors.accent); Spacer(Modifier.width(12.dp))
            MovieHubText("Paramètres", color = UiColors.text, modifier = Modifier.weight(1f))
            Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
        }
        HorizontalDivider(color = Color(0xFF242932))
        listOf("Aide & support", "À propos").forEach { label ->
            Row(Modifier.fillMaxWidth().clickable {}.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                MovieHubText(label, color = UiColors.text, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = UiColors.accent)
            }
            HorizontalDivider(color = Color(0xFF242932))
        }
    }
}

@Composable
private fun AccountListScreen(
    title: String,
    items: List<MediaItem>,
    loading: Boolean,
    error: String?,
    onBack: () -> Unit,
    onSelect: (MediaItem) -> Unit,
    onRemove: (MediaItem) -> Unit
) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
            MovieHubText(title, color = UiColors.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        if (loading) LinearProgressIndicator(color = UiColors.accent, modifier = Modifier.fillMaxWidth())
        if (error != null) MovieHubText(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        if (!loading && items.isEmpty()) EmptyMessage("Aucun contenu pour le moment.")
        LazyColumn(contentPadding = PaddingValues(bottom = 20.dp)) {
            items(items, key = { it.id }) { item ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { MediaPoster(item) { onSelect(item) } }
                    IconButton(onClick = { onRemove(item) }) {
                        Icon(Icons.Default.DeleteOutline, "Retirer", tint = UiColors.accent)
                    }
                }
            }
        }
    }
}

@Composable
private fun AuthScreen(
    error: String?,
    onErrorConsumed: () -> Unit,
    onBack: () -> Unit,
    onSubmit: (String, String, String, Boolean) -> Unit
) {
    var register by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    LaunchedEffect(error) { if (error != null) submitting = false }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Retour", tint = UiColors.text) }
        Spacer(Modifier.height(18.dp))
        MovieHubText(if (register) "Créer un compte" else "Bienvenue", color = UiColors.text, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold)
        MovieHubText(if (register) "Rejoins MovieHub pour retrouver tes contenus." else "Connecte-toi pour synchroniser ton profil.", color = UiColors.muted, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        if (register) {
            OutlinedTextField(value = displayName, onValueChange = { displayName = it }, label = { MovieHubText("Nom affiché") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
        }
        OutlinedTextField(value = email, onValueChange = { email = it }, label = { MovieHubText("Adresse e-mail") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(value = password, onValueChange = { password = it }, label = { MovieHubText("Mot de passe") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
        if (register) MovieHubText("8 caractères minimum.", color = UiColors.muted, fontSize = 11.sp, modifier = Modifier.padding(top = 5.dp))
        if (error != null) MovieHubText(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
        Spacer(Modifier.height(18.dp))
        Button(
            onClick = {
                onErrorConsumed()
                submitting = true
                onSubmit(email, password, displayName, register)
            },
            enabled = !submitting && email.contains("@") && password.isNotBlank() && (!register || displayName.trim().length >= 2 && password.length >= 8),
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = UiColors.accent, contentColor = UiColors.background)
        ) {
            if (submitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else MovieHubText(if (register) "Créer mon compte" else "Se connecter")
        }
        TextButton(onClick = { register = !register; onErrorConsumed() }, modifier = Modifier.fillMaxWidth()) {
            MovieHubText(if (register) "J’ai déjà un compte" else "Créer un compte", color = UiColors.accent)
        }
    }
}

@Composable
private fun EmptyMessage(message: String) {
    MovieHubText(message, color = UiColors.muted, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().padding(22.dp))
}

@Composable
private fun SettingsScreen(
    themeMode: String,
    language: String,
    onThemeChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onBack: () -> Unit
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = UiColors.text) }
            MovieHubText("Paramètres", color = UiColors.text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(20.dp))
        MovieHubText("LANGUE", color = UiColors.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        MovieHubText("Langue de l’application", color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        MovieHubText("Choisis la langue de toute l’interface MovieHub.", color = UiColors.muted, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))
        MovieHubLanguages.options.forEach { option ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .background(if (language == option.code) Color(0xFF282113) else UiColors.panel)
                    .clickable { onLanguageChange(option.code) }.padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                MovieHubText(option.nativeName, color = UiColors.text, modifier = Modifier.weight(1f))
                RadioButton(selected = language == option.code, onClick = { onLanguageChange(option.code) }, colors = RadioButtonDefaults.colors(selectedColor = UiColors.accent))
            }
            Spacer(Modifier.height(7.dp))
        }
        Spacer(Modifier.height(18.dp))
        MovieHubText("APPARENCE", color = UiColors.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        Spacer(Modifier.height(8.dp))
        MovieHubText("Thème de l’application", color = UiColors.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        MovieHubText("Choisis l’apparence de MovieHub.", color = UiColors.muted, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        listOf("Sombre", "Clair", "Système").forEach { option ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .background(if (themeMode == option) Color(0xFF282113) else UiColors.panel)
                    .clickable { onThemeChange(option) }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    when (option) {
                        "Sombre" -> Icons.Default.DarkMode
                        "Clair" -> Icons.Default.LightMode
                        else -> Icons.Default.SettingsSuggest
                    }, null, tint = UiColors.accent
                )
                Spacer(Modifier.width(12.dp))
                MovieHubText(option, color = UiColors.text, modifier = Modifier.weight(1f))
                RadioButton(selected = themeMode == option, onClick = { onThemeChange(option) }, colors = RadioButtonDefaults.colors(selectedColor = UiColors.accent))
            }
            Spacer(Modifier.height(8.dp))
        }
        Spacer(Modifier.height(18.dp))
        MovieHubText("Les préférences sont enregistrées sur cet appareil.", color = UiColors.muted, fontSize = 11.sp)
    }
}
