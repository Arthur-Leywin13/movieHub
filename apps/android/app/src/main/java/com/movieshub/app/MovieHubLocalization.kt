package com.movieshub.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit

internal val LocalMovieHubLanguage = staticCompositionLocalOf { "fr" }

internal data class MovieHubLanguageOption(val code: String, val nativeName: String)

internal object MovieHubLanguages {
    val options = listOf(
        MovieHubLanguageOption("fr", "Français"),
        MovieHubLanguageOption("en", "English"),
        MovieHubLanguageOption("es", "Español"),
        MovieHubLanguageOption("ht", "Kreyòl ayisyen")
    )
}

private val translations = mapOf(
    "Accueil" to listOf("Home", "Inicio", "Akèy"),
    "Catégories" to listOf("Categories", "Categorías", "Kategori"),
    "Téléchargements" to listOf("Downloads", "Descargas", "Telechajman"),
    "Profil" to listOf("Profile", "Perfil", "Pwofil"),
    "Recherche" to listOf("Search", "Buscar", "Rechèch"),
    "Paramètres" to listOf("Settings", "Configuración", "Paramèt"),
    "Choisis ta langue" to listOf("Choose your language", "Elige tu idioma", "Chwazi lang ou"),
    "La langue pourra être modifiée à tout moment dans les paramètres." to listOf("You can change the language anytime in Settings.", "Puedes cambiar el idioma en cualquier momento desde Configuración.", "Ou ka chanje lang lan nenpòt lè nan paramèt yo."),
    "Langue de l’application" to listOf("App language", "Idioma de la aplicación", "Lang aplikasyon an"),
    "Choisis la langue de toute l’interface MovieHub." to listOf("Choose the language for the entire MovieHub interface.", "Elige el idioma de toda la interfaz de MovieHub.", "Chwazi lang pou tout koòdone MovieHub la."),
    "LANGUE" to listOf("LANGUAGE", "IDIOMA", "LANG"),
    "APPARENCE" to listOf("APPEARANCE", "APARIENCIA", "APARANS"),
    "Thème de l’application" to listOf("App theme", "Tema de la aplicación", "Tèm aplikasyon an"),
    "Choisis l’apparence de MovieHub." to listOf("Choose how MovieHub looks.", "Elige la apariencia de MovieHub.", "Chwazi aparans MovieHub."),
    "Sombre" to listOf("Dark", "Oscuro", "Nwa"),
    "Clair" to listOf("Light", "Claro", "Klè"),
    "Système" to listOf("System", "Sistema", "Sistèm"),
    "Les préférences sont enregistrées sur cet appareil." to listOf("Preferences are saved on this device.", "Las preferencias se guardan en este dispositivo.", "Preferans yo anrejistre sou aparèy sa a."),
    "Tes films, séries et animés\nau même endroit" to listOf("Your movies, series and anime\nin one place", "Tus películas, series y anime\nen un solo lugar", "Fim, seri ak anime ou yo\nan yon sèl kote"),
    "Ton prochain univers commence ici" to listOf("Your next world starts here", "Tu próximo universo comienza aquí", "Pwochen linivè ou kòmanse isit la"),
    "À LA UNE" to listOf("FEATURED", "DESTACADOS", "AN VEDET"),
    "SÉLECTION MOVIEHUB" to listOf("MOVIEHUB PICKS", "SELECCIÓN MOVIEHUB", "SELEKSYON MOVIEHUB"),
    "Voir les détails" to listOf("View details", "Ver detalles", "Gade detay yo"),
    "Le cinéma, à portée de main." to listOf("Cinema, at your fingertips.", "El cine, al alcance de tu mano.", "Sinema a nan men ou."),
    "Les nouveautés apparaîtront ici dès leur publication." to listOf("New releases will appear here when published.", "Los estrenos aparecerán aquí cuando se publiquen.", "Nouvo kontni yo ap parèt isit la lè yo pibliye."),
    "EXPLORER LE CATALOGUE" to listOf("EXPLORE THE CATALOG", "EXPLORAR EL CATÁLOGO", "EKSplore KATALÒG LA"),
    "Tendances" to listOf("Trending", "Tendencias", "Sa k popilè"),
    "À découvrir" to listOf("Discover", "Por descubrir", "Pou dekouvri"),
    "Découvrir" to listOf("Discover", "Descubrir", "Dekouvri"),
    "Le catalogue apparaîtra ici dès que des contenus seront publiés." to listOf("The catalog will appear here when content is published.", "El catálogo aparecerá aquí cuando se publique contenido.", "Katalòg la ap parèt isit la lè gen kontni ki pibliye."),
    "Explorer toutes les catégories" to listOf("Explore all categories", "Explorar todas las categorías", "Eksplore tout kategori yo"),
    "Voir la fiche" to listOf("View details", "Ver ficha", "Gade fich la"),
    "Retour" to listOf("Back", "Volver", "Retounen"),
    "Choisis un univers" to listOf("Choose a world", "Elige un universo", "Chwazi yon linivè"),
    "Les catégories apparaîtront ici dès qu'elles seront disponibles dans le catalogue." to listOf("Categories will appear here when available in the catalog.", "Las categorías aparecerán aquí cuando estén disponibles.", "Kategori yo ap parèt isit la lè yo disponib nan katalòg la."),
    "Toutes" to listOf("All", "Todas", "Tout"),
    "Aucun résultat pour cette catégorie pour le moment." to listOf("No results in this category yet.", "Todavía no hay resultados en esta categoría.", "Pa gen rezilta nan kategori sa a pou kounye a."),
    "La recherche est momentanément indisponible." to listOf("Search is temporarily unavailable.", "La búsqueda no está disponible temporalmente.", "Rechèch la pa disponib pou kounye a."),
    "Film, série, anime…" to listOf("Movie, series, anime…", "Película, serie, anime…", "Fim, seri, anime…"),
    "Effacer la recherche" to listOf("Clear search", "Borrar búsqueda", "Efase rechèch la"),
    "Que veux-tu regarder ?" to listOf("What do you want to watch?", "¿Qué quieres ver?", "Kisa ou vle gade?"),
    "Saisis au moins deux caractères pour rechercher dans le catalogue." to listOf("Enter at least two characters to search the catalog.", "Escribe al menos dos caracteres para buscar en el catálogo.", "Ekri omwen de karaktè pou chèche nan katalòg la."),
    "Recherche en cours…" to listOf("Searching…", "Buscando…", "Ap chèche…"),
    "FICHE DU CONTENU" to listOf("CONTENT DETAILS", "DETALLES DEL CONTENIDO", "DETAY KONTNI"),
    "Détails" to listOf("Details", "Detalles", "Detay"),
    "Synopsis" to listOf("Synopsis", "Sinopsis", "Rezime"),
    "La description sera affichée à partir des métadonnées du catalogue." to listOf("The description will be shown from catalog metadata.", "La descripción se mostrará desde los metadatos del catálogo.", "Deskripsyon an ap parèt apati enfòmasyon katalòg la."),
    "Les informations du contenu seront chargées depuis MovieHub." to listOf("Content information will be loaded from MovieHub.", "La información se cargará desde MovieHub.", "Enfòmasyon sou kontni an ap soti nan MovieHub."),
    "Regarder le film" to listOf("Watch", "Ver", "Gade"),
    "Lecture indisponible" to listOf("Playback unavailable", "Reproducción no disponible", "Lekti pa disponib"),
    "Voir la bande-annonce" to listOf("Watch trailer", "Ver tráiler", "Gade trelè a"),
    "TÉLÉCHARGER HORS CONNEXION" to listOf("DOWNLOAD FOR OFFLINE", "DESCARGAR PARA VER SIN CONEXIÓN", "TELECHAJE POU GADE SAN ENTÈNÈT"),
    "Retirer des favoris" to listOf("Remove from favorites", "Quitar de favoritos", "Retire nan favori yo"),
    "Ajouter aux favoris" to listOf("Add to favorites", "Añadir a favoritos", "Ajoute nan favori yo"),
    "Les versions publiées peuvent être téléchargées dans l’espace privé de MovieHub." to listOf("Published versions can be downloaded to MovieHub's private storage.", "Las versiones publicadas se pueden descargar al espacio privado de MovieHub.", "Ou ka telechaje vèsyon ki pibliye yo nan espas prive MovieHub."),
    "Lecteur vidéo" to listOf("Video player", "Reproductor de video", "Lektè videyo"),
    "Qualité vidéo" to listOf("Video quality", "Calidad de video", "Kalite videyo"),
    "Aucune version vidéo disponible." to listOf("No video version available.", "No hay ninguna versión de video disponible.", "Pa gen okenn vèsyon videyo ki disponib."),
    "L’API n’a pas renvoyé de lien vidéo valide." to listOf("The API did not return a valid video link.", "La API no devolvió un enlace de video válido.", "API a pa retounen yon lyen videyo ki valab."),
    "Impossible de lancer la lecture." to listOf("Unable to start playback.", "No se puede iniciar la reproducción.", "Li pa posib pou kòmanse lekti a."),
    "Préparation…" to listOf("Preparing…", "Preparando…", "Ap prepare…"),
    "Reprendre la lecture" to listOf("Resume playback", "Reanudar reproducción", "Kontinye gade"),
    "Lire cette version" to listOf("Play this version", "Reproducir esta versión", "Jwe vèsyon sa a"),
    "Bande-annonce" to listOf("Trailer", "Tráiler", "Trelè"),
    "Aucune version vidéo ni bande-annonce publiée." to listOf("No video version or trailer has been published.", "No se ha publicado ningún video ni tráiler.", "Pa gen okenn videyo oswa trelè ki pibliye."),
    "La vidéo apparaîtra ici" to listOf("The video will appear here", "El video aparecerá aquí", "Videyo a ap parèt isit la"),
    "La progression est synchronisée automatiquement lorsque tu regardes un film." to listOf("Your progress syncs automatically while watching a movie.", "Tu progreso se sincroniza automáticamente al ver una película.", "Pwogrè ou ap senkronize otomatikman lè w ap gade yon fim."),
    "Aperçu de la bande-annonce officielle." to listOf("Official trailer preview.", "Vista previa del tráiler oficial.", "Apèsi trelè ofisyèl la."),
    "Ta bibliothèque hors connexion" to listOf("Your offline library", "Tu biblioteca sin conexión", "Bibliyotèk ou san entènèt"),
    "Partager" to listOf("Share", "Compartir", "Pataje"),
    "Recevoir" to listOf("Receive", "Recibir", "Resevwa"),
    "Aucun téléchargement" to listOf("No downloads", "No hay descargas", "Pa gen telechajman"),
    "Les vidéos enregistrées apparaîtront ici." to listOf("Saved videos will appear here.", "Los videos guardados aparecerán aquí.", "Videyo ou sove yo ap parèt isit la."),
    "Les fichiers terminés restent dans l’espace privé de MovieHub, invisibles dans la galerie publique." to listOf("Completed files stay in MovieHub's private storage and are hidden from the public gallery.", "Los archivos terminados permanecen en el espacio privado de MovieHub y no aparecen en la galería pública.", "Fichye ki fini yo rete nan espas prive MovieHub; yo pa parèt nan galri piblik la."),
    "Téléchargement terminé • enregistré en privé" to listOf("Download complete • saved privately", "Descarga completa • guardada en privado", "Telechajman fini • anrejistre an prive"),
    "En attente du réseau…" to listOf("Waiting for network…", "Esperando la red…", "Ap tann rezo a…"),
    "Mettre en pause" to listOf("Pause", "Pausar", "Mete sou poz"),
    "En pause • fichier partiel conservé en privé" to listOf("Paused • partial file kept privately", "En pausa • archivo parcial guardado en privado", "Sou poz • fichye pasyèl la rete an prive"),
    "Reprendre" to listOf("Resume", "Reanudar", "Kontinye"),
    "Échec du téléchargement" to listOf("Download failed", "Error de descarga", "Telechajman an echwe"),
    "Envoyer un téléchargement" to listOf("Send a download", "Enviar una descarga", "Voye yon telechajman"),
    "Recevoir un fichier" to listOf("Receive a file", "Recibir un archivo", "Resevwa yon fichye"),
    "Fermer" to listOf("Close", "Cerrar", "Fèmen"),
    "Envoyer" to listOf("Send", "Enviar", "Voye"),
    "Partage" to listOf("Sharing", "Compartir", "Pataj"),
    "Partager tes fichiers" to listOf("Share your files", "Compartir tus archivos", "Pataje fichye ou yo"),
    "Recevoir des fichiers" to listOf("Receive files", "Recibir archivos", "Resevwa fichye"),
    "Transfert local entre appareils, sans passer par le stockage cloud." to listOf("Transfer locally between devices without cloud storage.", "Transferencia local entre dispositivos, sin almacenamiento en la nube.", "Transfè lokal ant aparèy san depo nan nwaj."),
    "Choisir un fichier" to listOf("Choose a file", "Elegir un archivo", "Chwazi yon fichye"),
    "Rechercher un appareil" to listOf("Find a device", "Buscar un dispositivo", "Chèche yon aparèy"),
    "Le transfert Wi-Fi direct et l’appairage QR seront implémentés dans une étape dédiée." to listOf("Direct Wi-Fi transfer and QR pairing will be added in a dedicated step.", "La transferencia Wi-Fi directa y el emparejamiento QR se añadirán en una etapa específica.", "Transfè Wi-Fi dirèk ak koneksyon QR ap vini nan yon etap apa."),
    "Bienvenue sur MovieHub" to listOf("Welcome to MovieHub", "Bienvenido a MovieHub", "Byenveni sou MovieHub"),
    "Connecte-toi pour synchroniser tes favoris et ton historique." to listOf("Sign in to sync your favorites and history.", "Inicia sesión para sincronizar tus favoritos y tu historial.", "Konekte pou senkronize favori ak istwa ou."),
    "Se connecter / Créer un compte" to listOf("Sign in / Create account", "Iniciar sesión / Crear cuenta", "Konekte / Kreye kont"),
    "Compte connecté" to listOf("Account connected", "Cuenta conectada", "Kont lan konekte"),
    "Sécurité du compte" to listOf("Account security", "Seguridad de la cuenta", "Sekirite kont lan"),
    "Aucune session active" to listOf("No active session", "No hay sesión activa", "Pa gen sesyon aktif"),
    "Les identifiants de session sont stockés de manière chiffrée et ne sont jamais affichés." to listOf("Session credentials are encrypted and never displayed.", "Las credenciales de sesión se almacenan cifradas y nunca se muestran.", "Enfòmasyon sesyon yo ankripte epi yo pa janm parèt."),
    "Se déconnecter" to listOf("Sign out", "Cerrar sesión", "Dekonekte"),
    "Historique de visionnage" to listOf("Watch history", "Historial de reproducción", "Istwa sa ou gade"),
    "Aide & support" to listOf("Help & support", "Ayuda y soporte", "Èd ak sipò"),
    "À propos" to listOf("About", "Acerca de", "Konsènan"),
    "Aucun contenu pour le moment." to listOf("No content yet.", "Todavía no hay contenido.", "Pa gen kontni pou kounye a."),
    "Retirer" to listOf("Remove", "Quitar", "Retire"),
    "Créer un compte" to listOf("Create account", "Crear cuenta", "Kreye kont"),
    "Bienvenue" to listOf("Welcome", "Bienvenido", "Byenveni"),
    "Rejoins MovieHub pour retrouver tes contenus." to listOf("Join MovieHub to keep your content in one place.", "Únete a MovieHub para encontrar tu contenido.", "Vin sou MovieHub pou jwenn kontni ou yo."),
    "Connecte-toi pour synchroniser ton profil." to listOf("Sign in to sync your profile.", "Inicia sesión para sincronizar tu perfil.", "Konekte pou senkronize pwofil ou."),
    "Nom affiché" to listOf("Display name", "Nombre visible", "Non ki parèt"),
    "Adresse e-mail" to listOf("Email address", "Correo electrónico", "Adrès imèl"),
    "Mot de passe" to listOf("Password", "Contraseña", "Modpas"),
    "8 caractères minimum." to listOf("At least 8 characters.", "Mínimo 8 caracteres.", "Omwen 8 karaktè."),
    "Créer mon compte" to listOf("Create my account", "Crear mi cuenta", "Kreye kont mwen"),
    "J’ai déjà un compte" to listOf("I already have an account", "Ya tengo una cuenta", "Mwen deja gen yon kont"),
    "Mes favoris" to listOf("My favorites", "Mis favoritos", "Favori mwen yo"),
    "MOVIEHUB" to listOf("MOVIEHUB", "MOVIEHUB", "MOVIEHUB"),
    "Chargement…" to listOf("Loading…", "Cargando…", "Ap chaje…"),
    "Film" to listOf("Movie", "Película", "Fim"),
    "Films" to listOf("Movies", "Películas", "Fim"),
    "Séries" to listOf("Series", "Series", "Seri"),
    "Animes" to listOf("Anime", "Anime", "Anime"),
    "Tous" to listOf("All", "Todos", "Tout")
)

internal fun translateMovieHubText(value: String, language: String): String {
    if (language == "fr") return value
    val index = when (language) { "en" -> 0; "es" -> 1; "ht" -> 2; else -> return value }
    translations[value]?.let { return it[index] }
    return when {
        value.startsWith("Télécharger ") -> listOf("Download ", "Descargar ", "Telechaje ")[index] + value.removePrefix("Télécharger ")
        value.startsWith("Téléchargement : ") -> listOf("Downloading: ", "Descargando: ", "Ap telechaje: ")[index] + value.removePrefix("Téléchargement : ")
        value.startsWith("Reprise disponible à ") -> listOf("Resume available at ", "Reanudar disponible en ", "Ou ka kontinye nan ")[index] + value.removePrefix("Reprise disponible à ")
        value.startsWith("Aucun résultat pour « ") -> listOf("No results for “", "No hay resultados para “", "Pa gen rezilta pou “")[index] + value.removePrefix("Aucun résultat pour « ").removeSuffix(" ».") + listOf("”. Try another title.", "”. Prueba otro título.", "”. Eseye yon lòt tit.")[index]
        value.endsWith(" résultat(s)") -> value.removeSuffix(" résultat(s)") + listOf(" result(s)", " resultado(s)", " rezilta")[index]
        value == "Connexion à l’API indisponible" -> listOf("API connection unavailable", "Conexión a la API no disponible", "Koneksyon API a pa disponib")[index]
        value == "Connexion impossible" -> listOf("Unable to sign in", "No se pudo iniciar sesión", "Koneksyon an pa reyisi")[index]
        value == "Erreur API HTTP" -> listOf("API HTTP error", "Error HTTP de la API", "Erè HTTP API")[index]
        value == "Action impossible" -> listOf("Action failed", "Acción fallida", "Aksyon an pa reyisi")[index]
        else -> value
    }
}

@Composable
internal fun MovieHubText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontSize: TextUnit = TextUnit.Unspecified,
    fontStyle: FontStyle? = null,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    textDecoration: TextDecoration? = null,
    textAlign: TextAlign? = null,
    lineHeight: TextUnit = TextUnit.Unspecified,
    overflow: TextOverflow = TextOverflow.Clip,
    softWrap: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    minLines: Int = 1,
    onTextLayout: (TextLayoutResult) -> Unit = {},
    style: TextStyle = LocalTextStyle.current
) {
    Text(
        text = translateMovieHubText(text, LocalMovieHubLanguage.current),
        modifier = modifier,
        color = color,
        fontSize = fontSize,
        fontStyle = fontStyle,
        fontWeight = fontWeight,
        fontFamily = fontFamily,
        letterSpacing = letterSpacing,
        textDecoration = textDecoration,
        textAlign = textAlign,
        lineHeight = lineHeight,
        overflow = overflow,
        softWrap = softWrap,
        maxLines = maxLines,
        minLines = minLines,
        onTextLayout = onTextLayout,
        style = style
    )
}
