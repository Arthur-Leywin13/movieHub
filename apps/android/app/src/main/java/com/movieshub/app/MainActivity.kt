package com.movieshub.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private val Black = Color(0xFF050608)
private val Panel = Color(0xFF11151B)
private val Gold = Color(0xFFFFC94A)
private val Muted = Color(0xFF9AA1AC)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MoviesHubApp() }
    }
}

private enum class Screen { HOME, CATEGORIES, SEARCH, DETAIL, PLAYER, DOWNLOADS, SHARE, PROFILE }

private data class MediaItem(
    val id: String,
    val title: String,
    val type: String = "Film",
    val year: String = "",
    val description: String = "",
    val poster: String? = null,
    val slug: String = id
)

private object MoviesHubApi {
    private fun get(path: String): String {
        val base = BuildConfig.API_BASE_URL.trimEnd('/')
        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 7000
            readTimeout = 7000
            setRequestProperty("Accept", "application/json")
        }
        return try {
            if (connection.responseCode !in 200..299) error("API HTTP ${connection.responseCode}")
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    suspend fun home(): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/home"))
    }

    suspend fun contents(type: String? = null): List<MediaItem> = withContext(Dispatchers.IO) {
        val query = type?.let { "?type=$it&limit=30" } ?: "?limit=30"
        parseMedia(get("/contents$query"))
    }

    suspend fun search(query: String): List<MediaItem> = withContext(Dispatchers.IO) {
        parseMedia(get("/search?q=${java.net.URLEncoder.encode(query, "UTF-8")}"))
    }

    suspend fun detail(slug: String): MediaItem? = withContext(Dispatchers.IO) {
        runCatching { parseItem(JSONObject(get("/contents/$slug"))) }.getOrNull()
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
        val id = obj.optString("id", obj.optString("slug", obj.optString("title", "item")))
        val posterObject = obj.optJSONObject("primaryPoster") ?: obj.optJSONObject("poster")
        val poster = obj.optString("posterUrl").takeIf { it.startsWith("http") }
            ?: obj.optString("imageUrl").takeIf { it.startsWith("http") }
            ?: posterObject?.optString("url")?.takeIf { it.startsWith("http") }
        return MediaItem(
            id = id,
            slug = obj.optString("slug", id),
            title = obj.optString("title", "Sans titre"),
            type = obj.optString("type", "Film"),
            year = obj.optString("year", ""),
            description = obj.optString("description", ""),
            poster = poster
        )
    }
}

@Composable
private fun MoviesHubApp() {
    var screen by remember { mutableStateOf(Screen.HOME) }
    var splash by remember { mutableStateOf(true) }
    var selected by remember { mutableStateOf<MediaItem?>(null) }
    var searchText by remember { mutableStateOf("") }
    var activeFilter by remember { mutableStateOf("Tous") }
    var media by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        delay(1400)
        splash = false
        loading = true
        runCatching { MoviesHubApi.home() }
            .onSuccess { media = it; error = null }
            .onFailure { error = "Connexion à l’API indisponible"; media = emptyList() }
        loading = false
    }

    MaterialTheme(colorScheme = darkColorScheme(
        primary = Gold, background = Black, surface = Panel,
        onPrimary = Black, onBackground = Color.White, onSurface = Color.White
    )) {
        if (splash) {
            SplashScreen()
        } else {
            Scaffold(
                containerColor = Black,
                bottomBar = {
                    if (screen in listOf(Screen.HOME, Screen.DOWNLOADS, Screen.SHARE, Screen.PROFILE, Screen.CATEGORIES, Screen.SEARCH)) {
                        BottomNavigationBar(screen) { screen = it }
                    }
                }
            ) { padding ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    when (screen) {
                        Screen.HOME -> HomeScreen(
                            media, loading, error,
                            onCategories = { screen = Screen.CATEGORIES },
                            onSearch = { screen = Screen.SEARCH },
                            onSelect = { selected = it; screen = Screen.DETAIL }
                        )
                        Screen.CATEGORIES -> CategoriesScreen(
                            activeFilter, onFilter = { activeFilter = it },
                            onBack = { screen = Screen.HOME },
                            onSelect = { selected = it; screen = Screen.DETAIL }
                        )
                        Screen.SEARCH -> SearchScreen(
                            searchText, { searchText = it }, media,
                            onSearch = {
                                if (searchText.trim().length >= 2) {
                                    scope.launch {
                                        loading = true
                                        runCatching { MoviesHubApi.search(searchText.trim()) }
                                            .onSuccess { media = it; error = null }
                                            .onFailure { error = "Recherche indisponible pour le moment" }
                                        loading = false
                                    }
                                }
                            },
                            onSelect = { selected = it; screen = Screen.DETAIL }
                        )
                        Screen.DETAIL -> DetailScreen(selected, onBack = { screen = Screen.HOME }, onPlay = { screen = Screen.PLAYER })
                        Screen.PLAYER -> PlayerScreen(selected, onBack = { screen = Screen.DETAIL })
                        Screen.DOWNLOADS -> DownloadsScreen()
                        Screen.SHARE -> ShareScreen()
                        Screen.PROFILE -> ProfileScreen()
                    }
                }
            }
        }
    }
}

@Composable
private fun SplashScreen() {
    Box(Modifier.fillMaxSize().background(
        Brush.verticalGradient(listOf(Color(0xFF08090D), Black, Color(0xFF090B12)))
    ), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Box(Modifier.size(116.dp).clip(RoundedCornerShape(28.dp)).background(Color(0xFF17130A)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.PlayCircle, null, tint = Gold, modifier = Modifier.size(86.dp))
            }
            Text("MoviesHub", color = Gold, fontSize = 34.sp, fontWeight = FontWeight.ExtraBold)
            Text("Tes films, séries et animés\nau même endroit", color = Color.White, fontSize = 14.sp, lineHeight = 21.sp)
            Spacer(Modifier.height(95.dp))
            LinearProgressIndicator(color = Gold, trackColor = Color(0xFF332B1B), modifier = Modifier.width(170.dp))
            Text("Chargement…", color = Muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun BottomNavigationBar(screen: Screen, onNavigate: (Screen) -> Unit) {
    NavigationBar(containerColor = Color(0xFF090B0F), contentColor = Gold) {
        val entries = listOf(
            Triple(Screen.HOME, "Accueil", Icons.Default.Home),
            Triple(Screen.DOWNLOADS, "Téléchargements", Icons.Default.Download),
            Triple(Screen.SHARE, "Partage", Icons.Default.Share),
            Triple(Screen.PROFILE, "Profil", Icons.Default.Person)
        )
        entries.forEach { (destination, label, icon) ->
            NavigationBarItem(
                selected = screen == destination || (destination == Screen.HOME && screen in listOf(Screen.CATEGORIES, Screen.SEARCH)),
                onClick = { onNavigate(destination) },
                icon = { Icon(icon, contentDescription = label) },
                label = { Text(label, fontSize = 10.sp) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Gold, selectedTextColor = Gold,
                    unselectedIconColor = Muted, unselectedTextColor = Muted,
                    indicatorColor = Color(0xFF30240E)
                )
            )
        }
    }
}

@Composable
private fun Header(title: String = "MoviesHub", onCategories: (() -> Unit)? = null, onSearch: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onCategories != null) IconButton(onClick = onCategories) { Icon(Icons.Default.Menu, "Catégories", tint = Color.White) }
        Text(title, color = Gold, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        if (onSearch != null) IconButton(onClick = onSearch) { Icon(Icons.Default.Search, "Recherche", tint = Color.White) }
    }
}

@Composable
private fun FilterChips(active: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("Tous", "Films", "Séries", "Animes").forEach { label ->
            FilterChip(
                selected = active == label, onClick = { onSelect(label) }, label = { Text(label) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = Gold, selectedLabelColor = Black,
                    containerColor = Panel, labelColor = Color.White
                ),
                border = null
            )
        }
    }
}

@Composable
private fun HomeScreen(
    media: List<MediaItem>, loading: Boolean, error: String?,
    onCategories: () -> Unit, onSearch: () -> Unit, onSelect: (MediaItem) -> Unit
) {
    var filter by remember { mutableStateOf("Tous") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 20.dp)) {
        item { Header(onCategories = onCategories, onSearch = onSearch) }
        item { FilterChips(filter) { filter = it } }
        item {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Box(Modifier.fillMaxWidth().height(205.dp).clip(RoundedCornerShape(18.dp)).background(
                    Brush.linearGradient(listOf(Color(0xFF26384B), Color(0xFF151A22), Color(0xFF6B351C)))
                )) {
                    Column(Modifier.align(Alignment.BottomStart).padding(18.dp)) {
                        Text("À DÉCOUVRIR", color = Gold, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Text("Votre prochain film préféré", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text("Films • Séries • Animes", color = Color.White.copy(alpha = .8f), fontSize = 12.sp)
                    }
                }
            }
        }
        item { SectionTitle("Tendances", "Voir tout") }
        if (loading) item { LinearProgressIndicator(color = Gold, modifier = Modifier.fillMaxWidth().padding(16.dp)) }
        if (error != null && media.isEmpty()) item { EmptyMessage(error) }
        if (!loading && media.isEmpty() && error == null) item { EmptyMessage("Le catalogue apparaîtra ici dès que des contenus seront publiés.") }
        items(media.take(12)) { item -> MediaPoster(item, onClick = { onSelect(item) }) }
        item { SectionTitle("Animes populaires", "Explorer") }
        item { Text("Les catégories et les contenus publiés seront chargés depuis le catalogue MovieHub.", color = Muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), fontSize = 12.sp) }
    }
}

@Composable
private fun SectionTitle(title: String, action: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text(action, color = Gold, fontSize = 12.sp)
    }
}

@Composable
private fun MediaPoster(item: MediaItem, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 5.dp).clip(RoundedCornerShape(12.dp)).background(Panel).clickable(onClick = onClick).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (item.poster != null) {
            AsyncImage(item.poster, contentDescription = item.title, modifier = Modifier.size(68.dp, 92.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
        } else {
            Box(Modifier.size(68.dp, 92.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF242A33)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Movie, null, tint = Gold, modifier = Modifier.size(30.dp))
            }
        }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(item.title, color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOf(item.type, item.year).filter { it.isNotBlank() }.joinToString(" • "), color = Muted, fontSize = 12.sp)
            if (item.description.isNotBlank()) Text(item.description, color = Muted, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Icon(Icons.Default.ChevronRight, null, tint = Gold)
    }
}

@Composable
private fun CategoriesScreen(active: String, onFilter: (String) -> Unit, onBack: () -> Unit, onSelect: (MediaItem) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Header("Catégories", onCategories = onBack)
        FilterChips(active, onFilter)
        val categories = listOf("Action", "Aventure", "Comédie", "Drame", "Horreur", "Science-fiction", "Fantastique", "Animation")
        LazyColumn(contentPadding = PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            items(categories) { category ->
                Row(Modifier.fillMaxWidth().height(62.dp).clip(RoundedCornerShape(12.dp)).background(
                    Brush.horizontalGradient(listOf(Color(0xFF202B38), Color(0xFF17191E)))
                ).clickable { onFilter(category) }.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(category, color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Icon(Icons.Default.ChevronRight, null, tint = Gold)
                }
            }
        }
    }
}

@Composable
private fun SearchScreen(query: String, onQuery: (String) -> Unit, media: List<MediaItem>, onSearch: () -> Unit, onSelect: (MediaItem) -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Header("Recherche")
        OutlinedTextField(
            value = query, onValueChange = onQuery, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("Film, série, anime…", color = Muted) }, singleLine = true,
            trailingIcon = { IconButton(onClick = onSearch) { Icon(Icons.Default.Search, null, tint = Gold) } },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Gold, unfocusedBorderColor = Color(0xFF343A44),
                focusedTextColor = Color.White, unfocusedTextColor = Color.White
            )
        )
        Text("Suggestions", color = Gold, modifier = Modifier.padding(16.dp), fontWeight = FontWeight.Bold)
        LazyColumn { items(media.take(8)) { MediaPoster(it) { onSelect(it) } } }
    }
}

@Composable
private fun DetailScreen(item: MediaItem?, onBack: () -> Unit, onPlay: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = Color.White) }
            Text(item?.title ?: "Détails", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }
        if (item?.poster != null) AsyncImage(item.poster, null, modifier = Modifier.fillMaxWidth().height(250.dp), contentScale = ContentScale.Crop)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(18.dp)) {
            Text(item?.title ?: "Contenu", color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.Bold)
            Text(listOf(item?.type ?: "Film", item?.year ?: "").filter { it.isNotBlank() }.joinToString(" • "), color = Gold)
            Spacer(Modifier.height(12.dp))
            Text(item?.description?.ifBlank { "La description sera affichée à partir des métadonnées du catalogue." } ?: "Les informations du contenu seront chargées depuis MovieHub.", color = Muted)
            Spacer(Modifier.height(22.dp))
            Button(onClick = onPlay, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Black)) {
                Icon(Icons.Default.PlayArrow, null); Spacer(Modifier.width(6.dp)); Text("Voir la bande-annonce")
            }
            OutlinedButton(onClick = {}, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = Gold)) {
                Icon(Icons.Default.Download, null); Spacer(Modifier.width(6.dp)); Text("Télécharger — connexion requise")
            }
        }
    }
}

@Composable
private fun PlayerScreen(item: MediaItem?, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(18.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, null, tint = Color.White) }
            Text(item?.title ?: "Lecteur vidéo", color = Color.White, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Color(0xFF171D26)), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.PlayCircle, null, tint = Gold, modifier = Modifier.size(72.dp))
        }
        Text("Le lecteur Media3 sera connecté aux versions vidéo publiées.", color = Muted, modifier = Modifier.padding(16.dp))
        Text("Qualité vidéo", color = Color.White, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("480p", "720p", "1080p").forEach { quality ->
                FilterChip(selected = quality == "720p", onClick = {}, label = { Text(quality) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Gold, selectedLabelColor = Black, labelColor = Color.White),
                    border = null)
            }
        }
        Text("Audio et sous-titres seront proposés selon les pistes disponibles.", color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun DownloadsScreen() {
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Default.Download, null, tint = Gold, modifier = Modifier.size(62.dp))
        Spacer(Modifier.height(16.dp))
        Text("Téléchargements", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text("Tes fichiers téléchargés apparaîtront ici.", color = Muted)
        Text("Le téléchargement réel utilisera les liens temporaires fournis par l’API et le stockage local Android.", color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun ShareScreen() {
    var mode by remember { mutableStateOf("Envoyer") }
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Header("Partage")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("Envoyer", "Recevoir").forEach { option ->
                FilterChip(selected = mode == option, onClick = { mode = option }, label = { Text(option) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = Gold, selectedLabelColor = Black, labelColor = Color.White),
                    border = null)
            }
        }
        Spacer(Modifier.height(35.dp))
        Icon(Icons.Default.Devices, null, tint = Gold, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(18.dp))
        Text(if (mode == "Envoyer") "Partager tes fichiers" else "Recevoir des fichiers", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text("Transfert local entre appareils, sans passer par le stockage cloud.", color = Muted, fontSize = 13.sp)
        Spacer(Modifier.height(24.dp))
        Button(onClick = {}, colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Black)) {
            Text(if (mode == "Envoyer") "Choisir un fichier" else "Rechercher un appareil")
        }
        Text("Le transfert Wi-Fi direct et l’appairage QR seront implémentés dans une étape dédiée.", color = Muted, fontSize = 11.sp, modifier = Modifier.padding(top = 22.dp))
    }
}

@Composable
private fun ProfileScreen() {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Header("Profil")
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.AccountCircle, null, tint = Gold, modifier = Modifier.size(76.dp))
                Text("Utilisateur", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text("Connecte-toi pour synchroniser tes favoris et ton historique.", color = Muted, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(25.dp))
        listOf("Mes favoris", "Historique de visionnage", "Paramètres", "Aide & support", "À propos").forEach {
            Row(Modifier.fillMaxWidth().clickable {}.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, color = Color.White, modifier = Modifier.weight(1f))
                Icon(Icons.Default.ChevronRight, null, tint = Gold)
            }
            HorizontalDivider(color = Color(0xFF242932))
        }
    }
}

@Composable
private fun EmptyMessage(message: String) {
    Text(message, color = Muted, fontSize = 13.sp, modifier = Modifier.fillMaxWidth().padding(22.dp))
}
