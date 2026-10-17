package com.readingsapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.graphics.BitmapFactory
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class GlucoseService : Service() {

  companion object {
    /** Silent channel for the ongoing foreground notification. */
    const val CHANNEL_STATUS = "glucose_status_v3"
    /** Urgent low alerts channel (< 70 mg/dL). */
    const val CHANNEL_ALERT_LOW = "glucose_alerts_low_v4"
    /** High alerts channel (> 180 mg/dL). */
    const val CHANNEL_ALERT_HIGH = "glucose_alerts_high_v4"
    /** Periodic reading broadcast chime. */
    const val CHANNEL_BROADCAST = "glucose_broadcast_v4"

    const val NOTIF_ID = 1001
    const val ALERT_LOW_NOTIF_ID = 1002
    const val ALERT_HIGH_NOTIF_ID = 1003
    const val BROADCAST_NOTIF_ID = 1004
    const val ACTION_REFRESH = "com.readingsapp.REFRESH"
    const val ACTION_STOP = "com.readingsapp.STOP"
    const val ACTION_UPDATE_SETTINGS = "com.readingsapp.UPDATE_SETTINGS"

    /** Minimum interval between audible alert notifications (ms). */
    const val ALERT_THROTTLE_MS = 10L * 60 * 1000  // 10 minutes

    fun getSecurePrefs(context: Context): SharedPreferences {
      return try {
        val masterKey = MasterKey.Builder(context)
          .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
          .build()
        EncryptedSharedPreferences.create(
          context, "glucose_secure", masterKey,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
      } catch (_: Exception) {
        context.getSharedPreferences("glucose_secure_fallback", Context.MODE_PRIVATE)
      }
    }

    fun fireBroadcastNotification(
      context: Context,
      display: String,
      arrow: String,
      state: String
    ) {
      val openIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(
          context, 3, it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }
      val title = "Reading: $display $arrow"
      val body = "Periodic glucose update ($state). Tap to open Readings."
      val notif = NotificationCompat.Builder(context, CHANNEL_BROADCAST)
        .setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(R.drawable.ic_stat_glucose)
        .setColor(0xFF00E5FF.toInt())
        .setLargeIcon(BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher))
        .setContentIntent(openIntent)
        .setAutoCancel(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setCategory(NotificationCompat.CATEGORY_EVENT)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setDefaults(NotificationCompat.DEFAULT_ALL)
        .build()

      try {
        val mgr = context.getSystemService(NotificationManager::class.java)
        mgr?.notify(BROADCAST_NOTIF_ID, notif)
      } catch (_: Exception) {}

      try {
        val alertUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val r = RingtoneManager.getRingtone(context, alertUri)
        r?.play()
      } catch (_: Exception) {}
    }

    fun fireAlertNotification(
      context: Context,
      display: String,
      arrow: String,
      state: String,
      isLow: Boolean,
      isTest: Boolean = false
    ) {
      val prefs = getSecurePrefs(context)
      val channelId = if (isLow) CHANNEL_ALERT_LOW else CHANNEL_ALERT_HIGH
      val notifId = if (isLow) ALERT_LOW_NOTIF_ID else ALERT_HIGH_NOTIF_ID

      val tone = if (isLow) prefs.getString("lowAlertTone", "alarm") ?: "alarm"
                 else prefs.getString("highAlertTone", "notification") ?: "notification"
      val vibStyle = if (isLow) prefs.getString("lowVibration", "urgent") ?: "urgent"
                     else prefs.getString("highVibration", "pulse") ?: "pulse"
      val vibrateEnabled = prefs.getBoolean("vibrateEnabled", true)

      val pattern: LongArray? = if (!vibrateEnabled || vibStyle == "off") {
        null
      } else when (vibStyle) {
        "urgent" -> longArrayOf(0, 600, 250, 600, 250, 600)
        "pulse" -> longArrayOf(0, 400, 200, 400)
        "gentle" -> longArrayOf(0, 250, 150, 250)
        else -> longArrayOf(0, 400, 200, 400)
      }

      val openIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(
          context, 2, it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }
      val prefix = if (isTest) "[TEST] " else ""
      val title = if (isLow) "${prefix}⚠ LOW GLUCOSE: $display $arrow" else "${prefix}⚠ HIGH GLUCOSE: $display $arrow"
      val body = if (isTest) {
        "Sound: ${tone.uppercase()} · Vibration: ${vibStyle.uppercase()} · Simulated: $display."
      } else {
        "Blood sugar is $state ($display $arrow). Immediate action may be required."
      }

      val alertColor = if (isLow) 0xFFEF4444.toInt() else 0xFFF59E0B.toInt()
      val b = NotificationCompat.Builder(context, channelId)
        .setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(R.drawable.ic_stat_glucose)
        .setColor(alertColor)
        .setLargeIcon(BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher))
        .setContentIntent(openIntent)
        .setAutoCancel(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setCategory(if (isLow) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_EVENT)
        .setPriority(NotificationCompat.PRIORITY_HIGH)

      if (pattern != null) {
        b.setVibrate(pattern)
      } else {
        b.setVibrate(longArrayOf(0))
      }

      try {
        val mgr = context.getSystemService(NotificationManager::class.java)
        mgr?.notify(notifId, b.build())
      } catch (_: Exception) {}

      // Trigger custom hardware vibration
      if (pattern != null) {
        try {
          val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? android.os.VibratorManager)?.defaultVibrator
          } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? android.os.Vibrator
          }
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v?.vibrate(android.os.VibrationEffect.createWaveform(pattern, -1))
          } else {
            @Suppress("DEPRECATION")
            v?.vibrate(pattern, -1)
          }
        } catch (_: Exception) {}
      }

      // Trigger custom audio playback
      if (tone != "silent") {
        try {
          val soundUri = if (tone == "alarm") {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
              ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
          } else {
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
          }
          val r = RingtoneManager.getRingtone(context, soundUri)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            r?.audioAttributes = AudioAttributes.Builder()
              .setUsage(if (tone == "alarm") AudioAttributes.USAGE_ALARM else AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
              .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
              .build()
          }
          r?.play()
        } catch (_: Exception) {}
      }
    }

    fun baseUrlForRegion(region: String): String = when (region.uppercase()) {
      "US" -> "https://api-us.libreview.io"
      "EU" -> "https://api-eu.libreview.io"
      "EU2" -> "https://api-eu2.libreview.io"
      "LA" -> "https://api-la.libreview.io"
      "AP" -> "https://api-ap.libreview.io"
      "AE" -> "https://api-ae.libreview.io"
      "AU" -> "https://api-au.libreview.io"
      "CA" -> "https://api-ca.libreview.io"
      "DE" -> "https://api-de.libreview.io"
      "FR" -> "https://api-fr.libreview.io"
      "JP" -> "https://api-jp.libreview.io"
      else -> "https://api.libreview.io"
    }

    fun regionFromString(s: String): String {
      val k = s.trim().uppercase()
      return when (k) {
        "US", "EU", "EU2", "LA", "AP", "AE", "AU", "CA", "DE", "FR", "JP", "GLOBAL" -> k
        else -> "GLOBAL"
      }
    }

    fun sha256Hex(input: String): String {
      val md = java.security.MessageDigest.getInstance("SHA-256")
      val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
      return bytes.joinToString("") { "%02x".format(it) }
    }

    fun trendSymbol(trend: Int): String = when (trend) {
      1 -> "↓"; 2 -> "↘"; 3 -> "→"; 4 -> "↗"; 5 -> "↑"; else -> "•"
    }

    @Volatile var running = false
    @Volatile var lastAlertMs = 0L
    @Volatile var lastBroadcastMs = 0L
    @Volatile var lastNotifiedTitle = ""
    @Volatile var lastStatusNotifTime = 0L
  }

  private var pollThread: Thread? = null
  @Volatile private var stopFlag = false
  private val handler = Handler(Looper.getMainLooper())

  private fun securePrefs(): SharedPreferences {
    return try {
      val masterKey = MasterKey.Builder(this)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
      EncryptedSharedPreferences.create(
        this, "glucose_secure", masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
      )
    } catch (_: Exception) {
      getSharedPreferences("glucose_secure_fallback", Context.MODE_PRIVATE)
    }
  }

  override fun onCreate() {
    super.onCreate()
    createChannels()
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(NotificationManager::class.java)

      // Delete previous legacy channels
      listOf("glucose_live", "glucose_status", "glucose_status_v2", "glucose_alerts", "glucose_alerts_v2").forEach { id ->
        try { mgr?.deleteNotificationChannel(id) } catch (_: Exception) {}
      }

      // Status channel: 100% silent ongoing notification
      val statusCh = NotificationChannel(
        CHANNEL_STATUS, "Readings — status (silent)",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Ongoing silent glucose reading. Always visible."
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setShowBadge(false)
        setSound(null, null)
        enableVibration(false)
      }
      mgr?.createNotificationChannel(statusCh)

      // Low Alert Channel: urgent alarm tone + 3-pulse vibration
      val lowSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      val highSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

      val alarmAttributes = AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .setUsage(AudioAttributes.USAGE_ALARM)
        .build()

      val notifAttributes = AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
        .build()

      val lowAlertCh = NotificationChannel(
        CHANNEL_ALERT_LOW, "Readings — Urgent Low Alerts",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Loud alarm tone & urgent vibration when blood glucose drops below low threshold."
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 600, 250, 600, 250, 600)
        setSound(lowSoundUri, alarmAttributes)
        setBypassDnd(true)
      }
      mgr?.createNotificationChannel(lowAlertCh)

      val highAlertCh = NotificationChannel(
        CHANNEL_ALERT_HIGH, "Readings — High Alerts",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Notification chime & double-pulse vibration when blood glucose exceeds high threshold."
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 400, 200, 400)
        setSound(highSoundUri, notifAttributes)
      }
      mgr?.createNotificationChannel(highAlertCh)

      val broadcastCh = NotificationChannel(
        CHANNEL_BROADCAST, "Readings — Periodic Broadcasts",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Periodic audible reading announcements at configured intervals."
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 250, 150, 250)
        setSound(highSoundUri, notifAttributes)
      }
      mgr?.createNotificationChannel(broadcastCh)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_REFRESH -> {
        thread { pollOnce() }
        return START_STICKY
      }
      ACTION_UPDATE_SETTINGS -> {
        intent.extras?.let { b ->
          val prefs = securePrefs()
          prefs.edit()
            .putInt("pollSeconds", b.getInt("pollSeconds", prefs.getInt("pollSeconds", 60)).coerceIn(30, 900))
            .putString("units", b.getString("units") ?: prefs.getString("units", "mgdl"))
            .putInt("lowMgDl", b.getInt("lowMgDl", prefs.getInt("lowMgDl", 70)))
            .putInt("highMgDl", b.getInt("highMgDl", prefs.getInt("highMgDl", 180)))
            .putBoolean("alertsEnabled", b.getBoolean("alertsEnabled", prefs.getBoolean("alertsEnabled", true)))
            .putInt("silentNotifIntervalMin", b.getInt("silentNotifIntervalMin", prefs.getInt("silentNotifIntervalMin", 10)).coerceIn(1, 60))
            .putBoolean("audibleBroadcastEnabled", b.getBoolean("audibleBroadcastEnabled", prefs.getBoolean("audibleBroadcastEnabled", false)))
            .putInt("audibleBroadcastIntervalMin", b.getInt("audibleBroadcastIntervalMin", prefs.getInt("audibleBroadcastIntervalMin", 15)).coerceIn(5, 120))
            .putString("lowAlertTone", b.getString("lowAlertTone") ?: prefs.getString("lowAlertTone", "alarm"))
            .putString("highAlertTone", b.getString("highAlertTone") ?: prefs.getString("highAlertTone", "notification"))
            .putString("lowVibration", b.getString("lowVibration") ?: prefs.getString("lowVibration", "urgent"))
            .putString("highVibration", b.getString("highVibration") ?: prefs.getString("highVibration", "pulse"))
            .putBoolean("vibrateEnabled", b.getBoolean("vibrateEnabled", prefs.getBoolean("vibrateEnabled", true)))
            .apply()
        }
        return START_STICKY
      }
    }
    // Config from intent extras (JS passes these)
    intent?.extras?.let { b ->
      val prefs = securePrefs()
      prefs.edit()
        .putInt("pollSeconds", b.getInt("pollSeconds", prefs.getInt("pollSeconds", 60)).coerceIn(30, 900))
        .putString("units", b.getString("units") ?: prefs.getString("units", "mgdl"))
        .putInt("lowMgDl", b.getInt("lowMgDl", prefs.getInt("lowMgDl", 70)))
        .putInt("highMgDl", b.getInt("highMgDl", prefs.getInt("highMgDl", 180)))
        .putBoolean("alertsEnabled", b.getBoolean("alertsEnabled", prefs.getBoolean("alertsEnabled", true)))
        .putInt("silentNotifIntervalMin", b.getInt("silentNotifIntervalMin", prefs.getInt("silentNotifIntervalMin", 10)).coerceIn(1, 60))
        .putBoolean("audibleBroadcastEnabled", b.getBoolean("audibleBroadcastEnabled", prefs.getBoolean("audibleBroadcastEnabled", false)))
        .putInt("audibleBroadcastIntervalMin", b.getInt("audibleBroadcastIntervalMin", prefs.getInt("audibleBroadcastIntervalMin", 15)).coerceIn(5, 120))
        .putString("lowAlertTone", b.getString("lowAlertTone") ?: prefs.getString("lowAlertTone", "alarm"))
        .putString("highAlertTone", b.getString("highAlertTone") ?: prefs.getString("highAlertTone", "notification"))
        .putString("lowVibration", b.getString("lowVibration") ?: prefs.getString("lowVibration", "urgent"))
        .putString("highVibration", b.getString("highVibration") ?: prefs.getString("highVibration", "pulse"))
        .putBoolean("vibrateEnabled", b.getBoolean("vibrateEnabled", prefs.getBoolean("vibrateEnabled", true)))
        .apply()
    }

    startForegroundCompat(buildStatusNotification("Starting…", "Connecting to LibreLinkUp"))
    running = true
    stopFlag = false
    if (pollThread?.isAlive != true) {
      pollThread = thread(name = "glucose-poll", isDaemon = true) {
        while (!stopFlag) {
          try {
            pollOnce()
          } catch (_: Exception) {}
          val secs = securePrefs().getInt("pollSeconds", 60).coerceIn(30, 900)
          var waited = 0
          while (waited < secs * 1000 && !stopFlag) {
            try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
            waited += 1000
          }
        }
      }
    }
    return START_STICKY
  }

  private fun startForegroundCompat(notif: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      try {
        startForeground(
          NOTIF_ID, notif,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        )
      } catch (_: Exception) {
        startForeground(NOTIF_ID, notif)
      }
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun httpGet(url: String, token: String, accountId: String = ""): Pair<Int, String> {
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 20000
      readTimeout = 20000
      setRequestProperty("Accept", "application/json")
      setRequestProperty("product", "llu.android")
      setRequestProperty("version", "4.16.0")
      setRequestProperty("Authorization", "Bearer $token")
      if (accountId.isNotEmpty()) {
        try {
          setRequestProperty("account-id", sha256Hex(accountId))
        } catch (_: Exception) {}
      }
    }
    return readResponse(conn)
  }

  private fun httpPost(url: String, body: String): Pair<Int, String> {
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 20000
      readTimeout = 20000
      doOutput = true
      setRequestProperty("Content-Type", "application/json")
      setRequestProperty("Accept", "application/json")
      setRequestProperty("product", "llu.android")
      setRequestProperty("version", "4.16.0")
    }
    OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
    return readResponse(conn)
  }

  private fun readResponse(conn: HttpURLConnection): Pair<Int, String> {
    val code = try { conn.responseCode } catch (e: Exception) { -1 }
    val stream = if (code in 200..299) {
      try { conn.inputStream } catch (_: Exception) { null }
    } else {
      try { conn.errorStream } catch (_: Exception) { null }
    }
    val text = if (stream != null) {
      BufferedReader(InputStreamReader(stream)).use { it.readText() }
    } else ""
    try { conn.disconnect() } catch (_: Exception) {}
    return code to text
  }

  private fun ensureToken(prefs: SharedPreferences): String? {
    val token = prefs.getString("token", "") ?: ""
    val exp = prefs.getLong("tokenExpiresAt", 0)
    if (token.isNotEmpty() && System.currentTimeMillis() < exp - 60_000) {
      return token
    }
    // Re-login with stored credentials (follows regional redirects)
    val email = prefs.getString("email", "") ?: ""
    val password = prefs.getString("password", "") ?: ""
    if (email.isEmpty() || password.isEmpty()) {
      return if (token.isNotEmpty()) token else null
    }
    var region = prefs.getString("region", "GLOBAL") ?: "GLOBAL"
    return try {
      val body = JSONObject().put("email", email).put("password", password).toString()
      var code = -1
      var text = ""
      var data: JSONObject? = null
      repeat(3) {
        val base = baseUrlForRegion(region)
        val r = httpPost("$base/llu/auth/login", body)
        code = r.first
        text = r.second
        if (code != 200 || text.isEmpty()) {
          return null
        }
        val root = try { JSONObject(text) } catch (_: Exception) { return null }
        data = root.optJSONObject("data")
        if (data?.optBoolean("redirect", false) == true) {
          region = regionFromString(data?.optString("region", "GLOBAL") ?: "GLOBAL")
          prefs.edit().putString("region", region).apply()
        } else {
          return loginResult(root)
        }
      }
      null
    } catch (_: Exception) {
      null
    }
  }

  private fun loginResult(root: JSONObject): String? {
    if (root.optInt("status", 0) == 2) {
      updateStatusNotification("Sign-in failed", "Wrong email/password or region — open Readings")
      return null
    }
    val data = root.optJSONObject("data") ?: return null
    val ticket = data.optJSONObject("authTicket") ?: return null
    val newToken = ticket.optString("token", "")
    if (newToken.isEmpty()) {
      return null
    }
    val userId = data.optJSONObject("user")?.optString("id", "") ?: ""
    val dur = ticket.optLong("duration", 2592000L)
    securePrefs().edit()
      .putString("token", newToken)
      .putLong("tokenExpiresAt", System.currentTimeMillis() + dur * 1000 - 60_000)
      .putString("accountId", userId)
      .apply()
    return newToken
  }

  private fun pollOnce() {
    val prefs = securePrefs()
    val patientId = prefs.getString("patientId", "") ?: ""
    if (patientId.isEmpty()) {
      updateStatusNotification("Not signed in", "Open Readings and sign in")
      return
    }
    val token = ensureToken(prefs) ?: return
    val region = prefs.getString("region", "GLOBAL") ?: "GLOBAL"
    val accountId = prefs.getString("accountId", "") ?: ""
    val base = baseUrlForRegion(region)
    try {
      val (code, text) = httpGet("$base/llu/connections/$patientId/graph", token, accountId)
      if (code == 401) {
        prefs.edit().putLong("tokenExpiresAt", 0).apply()
        updateStatusNotification("Session expired", "Open Readings and sign in again")
        return
      }
      if (code == 429) {
        // Back off quietly; keep last reading visible
        return
      }
      if (code != 200 || text.isEmpty()) {
        updateStatusNotificationWithLast("Sync failed", "Will retry automatically")
        return
      }
      val conn = JSONObject(text).optJSONObject("data")?.optJSONObject("connection")
      val m = conn?.optJSONObject("glucoseMeasurement")
      if (m == null) {
        updateStatusNotificationWithLast("No reading", "Sensor may be warming up")
        return
      }
      val value = m.optInt("ValueInMgPerDl", m.optInt("Value", 0))
      if (value <= 0) {
        updateStatusNotificationWithLast("No reading", "Sensor may be warming up")
        return
      }
      val trend = m.optInt("TrendArrow", 0)
      val epoch = parseTimestamp(m.optString("Timestamp", m.optString("FactoryTimestamp", "")))
      val ageMs = if (epoch > 0) System.currentTimeMillis() - epoch else Long.MAX_VALUE
      val isDead = epoch == 0L || ageMs > 30 * 60 * 1000
      val isStale = ageMs > 15 * 60 * 1000

      prefs.edit()
        .putInt("lastValue", value)
        .putInt("lastTrend", trend)
        .putLong("lastEpoch", epoch)
        .putString("latest_json", JSONObject()
          .put("valueMgDl", value)
          .put("trendArrow", trend)
          .put("epochMs", epoch)
          .put("stale", isStale || isDead)
          .toString())
        .apply()
      GlucoseModule.emitUpdate(value, trend, epoch)
      GlucoseWidgetProvider.refresh(this)
      OverlayService.updateReading(this, value, trend, epoch)

      val units = prefs.getString("units", "mgdl") ?: "mgdl"
      val low = prefs.getInt("lowMgDl", 70)
      val high = prefs.getInt("highMgDl", 180)
      val display = if (units == "mmol") String.format(Locale.US, "%.1f mmol/L", value / 18.01559) else "$value mg/dL"
      val arrow = trendSymbol(trend)
      val state = when {
        value < low -> "LOW"
        value > high -> "HIGH"
        else -> "in range"
      }

      val isCritical = isDead || value < low || value > high

      if (isDead) {
        updateStatusNotification(
          "⚠ Sensor ended / No recent data",
          "Last reading was $display ($arrow) · check sensor",
          force = true,
          isCritical = true
        )
      } else {
        val title = if (isStale) "$display $arrow — Stale" else "$display $arrow — $state"
        updateStatusNotification(
          title,
          timeStr(epoch) + " · tap to open",
          force = false,
          isCritical = isCritical
        )
      }

      val now = System.currentTimeMillis()

      // Audible periodic broadcast: announcements at interval set by user (e.g. 10m, 15m, 30m, 60m)
      val audibleBroadcast = prefs.getBoolean("audibleBroadcastEnabled", false)
      val broadcastIntervalMin = prefs.getInt("audibleBroadcastIntervalMin", 15).coerceIn(5, 120)
      val broadcastIntervalMs = broadcastIntervalMin * 60 * 1000L
      if (audibleBroadcast && !isStale && !isDead && (now - lastBroadcastMs >= broadcastIntervalMs)) {
        lastBroadcastMs = now
        fireBroadcastNotification(this, display, arrow, state)
      }

      // Urgent Audible alert: only when fresh + out of range + alerts enabled + throttle check (every 10m max)
      val alerts = prefs.getBoolean("alertsEnabled", true)
      val outOfRange = value < low || value > high
      if (alerts && !isStale && !isDead && outOfRange && (now - lastAlertMs >= ALERT_THROTTLE_MS)) {
        lastAlertMs = now
        fireAlertNotification(this, display, arrow, state, value < low, false)
      }
    } catch (e: Exception) {
      updateStatusNotificationWithLast("Sync error", e.message ?: "Will retry")
    }
  }

  private fun parseTimestamp(ts: String): Long {
    if (ts.isEmpty()) {
      return System.currentTimeMillis()
    }
    // Try epoch seconds
    ts.toLongOrNull()?.let {
      return if (it > 1_000_000_000_000L) it else it * 1000
    }
    val fmts = listOf(
      SimpleDateFormat("M/d/yyyy h:mm:ss a", Locale.US),
      SimpleDateFormat("M/d/yyyy H:mm:ss", Locale.US),
      SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
    )
    for (f in fmts) {
      try {
        val d: Date? = f.parse(ts)
        if (d != null) {
          return d.time
        }
      } catch (_: Exception) {}
    }
    return System.currentTimeMillis()
  }

  private fun timeStr(epoch: Long): String {
    return try {
      SimpleDateFormat("h:mm a", Locale.US).format(Date(epoch))
    } catch (_: Exception) { "" }
  }

  /* ── Status Notification (silent, ongoing) ── */

  private fun updateStatusNotificationWithLast(title: String, text: String) {
    val prefs = securePrefs()
    val last = prefs.getInt("lastValue", 0)
    if (last > 0) {
      val units = prefs.getString("units", "mgdl") ?: "mgdl"
      val display = if (units == "mmol") String.format(Locale.US, "%.1f mmol/L", last / 18.01559) else "$last mg/dL"
      updateStatusNotification("$display · $title", text, force = true, isCritical = true)
    } else {
      updateStatusNotification(title, text, force = true, isCritical = true)
    }
  }

  private fun updateStatusNotification(
    title: String,
    text: String,
    force: Boolean = false,
    isCritical: Boolean = false
  ) {
    val now = System.currentTimeMillis()
    val prefs = securePrefs()
    val silentIntervalMin = prefs.getInt("silentNotifIntervalMin", 10).coerceIn(1, 60)
    val intervalMs = silentIntervalMin * 60 * 1000L

    // If not a forced update or critical state (low/high/ended),
    // respect the user's configured silent update interval
    if (!force && !isCritical && (now - lastStatusNotifTime < intervalMs)) {
      return
    }
    lastNotifiedTitle = title
    lastStatusNotifTime = now
    val notif = buildStatusNotification(title, text)
    try {
      val mgr = getSystemService(NotificationManager::class.java)
      mgr?.notify(NOTIF_ID, notif)
    } catch (_: Exception) {}
  }

  private fun buildStatusNotification(title: String, text: String): Notification {
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(
        this, 0, it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val refreshIntent = PendingIntent.getService(
      this, 1, Intent(this, GlucoseService::class.java).setAction(ACTION_REFRESH),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL_STATUS)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(R.drawable.ic_stat_glucose)
      .setColor(0xFF00E5FF.toInt())
      .setLargeIcon(BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher))
      .setContentIntent(openIntent)
      .setOngoing(true)
      .setSilent(true)                 // purely silent
      .setOnlyAlertOnce(true)          // never buzz or alert
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .addAction(android.R.drawable.ic_menu_rotate, "Refresh", refreshIntent)
      .build()
  }


  override fun onDestroy() {
    stopFlag = true
    running = false
    super.onDestroy()
  }
}
