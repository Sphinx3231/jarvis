package ai.jarvis.mobile.control

/** One thing on screen the model can refer to by number. */
data class UiElement(
    val id: Int,
    val role: String,
    val text: String,
    val description: String = "",
    val clickable: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val password: Boolean = false,
    val checked: Boolean? = null,
    val selected: Boolean = false,
) {
    val label: String get() = listOf(text, description).filter { it.isNotBlank() }.distinct().joinToString(" · ")
}

/** What's on screen, as text a small model can read. */
data class ScreenSnapshot(
    val packageName: String,
    val appName: String,
    val elements: List<UiElement>,
    val isGame: Boolean = false,
    val truncated: Boolean = false,
    val ownApp: Boolean = false,
) {
    /** Jarvis can't act on this screen at all. */
    val blocked: Boolean get() = isGame || ownApp

    fun describe(): String = buildString {
        append("Screen: $appName ($packageName)\n")
        if (isGame) { append(GAME_NOTICE); return@buildString }
        if (ownApp) { append(OWN_APP_NOTICE); return@buildString }
        if (elements.isEmpty()) { append("(nothing readable on screen — it may still be loading; try screen_read again)"); return@buildString }
        for (e in elements) {
            append('[').append(e.id).append("] ").append(e.role)
            if (e.password) append(" (password, hidden)")
            // Buttons and rows stay short; text the user wants read (an email body, a message) is kept.
            else if (e.label.isNotBlank()) append(" \"").append(e.label.take(if (e.clickable || e.editable) 120 else 400)).append('"')
            val flags = listOfNotNull("tap".takeIf { e.clickable }, "type".takeIf { e.editable && !e.password }, "scroll".takeIf { e.scrollable },
                e.checked?.let { if (it) "checked" else "unchecked" }, "selected".takeIf { e.selected })
            if (flags.isNotEmpty()) append(" {").append(flags.joinToString(",")).append('}')
            append('\n')
        }
        if (truncated) append("(more below — use screen_scroll down)\n")
    }

    companion object {
        const val OWN_APP_NOTICE = "This is Jarvis's own screen; open the app you want to use with app_launch first."
        const val GAME_NOTICE = "This is a game. Jarvis doesn't play or control games (it would break most games' rules and can't see inside them)."
    }
}

/** Which on-screen actions ask the user first. */
object ActionRisk {
    /** Buttons whose tap changes something outside the screen: sending, paying, deleting, publishing… */
    private val consequential = Regex(
        "\\b(send|reply|forward|post|publish|tweet|share|delete|remove|erase|discard|trash|archive|unsubscribe|pay|buy|purchase|order|checkout|check out|" +
            "transfer|withdraw|deposit|donate|subscribe|install|uninstall|update|accept|decline|allow|deny|confirm|submit|sign out|log out|logout|" +
            "block|report|call|dial|book|reserve|apply|upload|save changes|factory reset|reset)\\b",
        RegexOption.IGNORE_CASE,
    )

    /** Apps where every action asks: money, passwords, security. */
    private val sensitivePackage = Regex("(bank|pay|wallet|cash|venmo|paypal|revolut|wise|crypto|coinbase|binance|trading|broker|invest|authenticator|password|1password|bitwarden|lastpass|keepass|settings|vending)", RegexOption.IGNORE_CASE)

    /**
     * Buttons have short labels ("Send", "Place order"): judged as a whole. Long labels are list rows
     * or content ("Amazon · Your order has shipped"), consequential only when they start with the verb.
     */
    fun isConsequential(label: String): Boolean {
        val l = label.trim()
        if (l.isEmpty()) return false
        val words = l.split(Regex("[\\s·]+")).filter { it.isNotBlank() }
        return if (words.size <= 4) consequential.containsMatchIn(l) else consequential.find(l)?.range?.first == 0
    }
    /** Banks, brokers, payment apps and wallets whose package names carry only the brand. */
    private val financeBrands = Regex(
        "(\\.chase\\.|wellsfargo|\\.bofa|infonow\\.bofa|citi|capitalone|usbank|pnc|truist|tdbank|ally|discover|amex|americanexpress|hsbc|barclays|lloyds|natwest|santander|" +
            "monzo|starling|n26|squareup\\.cash|zellepay|schwab|fidelity|vanguard|robinhood|etrade|webull|kraken|crypto\\.com|walletnfcrel|samsung\\.android\\.spay|" +
            "google\\.android\\.apps\\.nbu\\.paisa|klarna|afterpay|affirm|alipay|tencent\\.mm)",
        RegexOption.IGNORE_CASE,
    )

    fun isSensitiveApp(packageName: String): Boolean = sensitivePackage.containsMatchIn(packageName) || financeBrands.containsMatchIn(packageName)

    /** Known games are recognized by package too (some don't declare the game category). */
    private val gamePackages = Regex("^(com\\.epicgames\\.|com\\.activision\\.|com\\.tencent\\.ig|com\\.pubg\\.|com\\.garena\\.|com\\.supercell\\.|com\\.miHoYo\\.|com\\.hoyoverse\\.|com\\.roblox\\.|com\\.mojang\\.|com\\.riotgames\\.|com\\.ea\\.|com\\.king\\.)", RegexOption.IGNORE_CASE)
    fun isKnownGame(packageName: String): Boolean = gamePackages.containsMatchIn(packageName)
}
