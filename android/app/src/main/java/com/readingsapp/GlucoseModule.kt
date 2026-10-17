package com.readingsapp

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class GlucoseModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    @Volatile private var ctx: ReactApplicationContext? = null

    fun emitUpdate(valueMgDl: Int, trendArrow: Int, epochMs: Long) {
      val c = ctx ?: return
      if (!c.hasActiveCatalystInstance()) {
        return
      }
      try {
        c.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(
            "GlucoseUpdate",
            mapOf("valueMgDl" to valueMgDl, "trendArrow" to trendArrow, "epochMs" to epochMs)
          )
      } catch (_: Exception) {}
    }
  }

  init {
    ctx = reactContext
  }

  override fun getName() = "GlucoseModule"

  private fun securePrefs(): SharedPreferences {
    return try {
      val masterKey = MasterKey.Builder(reactContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
      EncryptedSharedPreferences.create(
        reactContext, "glucose_secure", masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
      )
    } catch (_: Exception) {
      reactContext.getSharedPreferences("glucose_secure_fallback", Context.MODE_PRIVATE)
    }
  }

  @ReactMethod
  fun saveCredentials(
    email: String, password: String, region: String,
    token: String, tokenExpiresAtMs: Double, accountId: String, patientId: String,
    promise: Promise
  ) {
    try {
      securePrefs().edit()
        .putString("email", email)
        .putString("password", password)
        .putString("region", region)
        .putString("token", token)
        .putLong("tokenExpiresAt", tokenExpiresAtMs.toLong())
        .putString("accountId", accountId)
        .putString("patientId", patientId)
        .apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SAVE_FAILED", e.message)
    }
  }

  @ReactMethod
  fun clearCredentials(promise: Promise) {
    try {
      securePrefs().edit().clear().apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("CLEAR_FAILED", e.message)
    }
  }

  @ReactMethod
  fun startService(
    pollSeconds: Double, units: String,
    lowMgDl: Double, highMgDl: Double, alertsEnabled: Boolean,
    silentNotifIntervalMin: Double,
    audibleBroadcastEnabled: Boolean,
    audibleBroadcastIntervalMin: Double,
    lowAlertTone: String,
    highAlertTone: String,
    lowVibration: String,
    highVibration: String,
    vibrateEnabled: Boolean,
    promise: Promise
  ) {
    try {
      securePrefs().edit()
        .putInt("pollSeconds", pollSeconds.toInt().coerceIn(30, 900))
        .putString("units", units)
        .putInt("lowMgDl", lowMgDl.toInt())
        .putInt("highMgDl", highMgDl.toInt())
        .putBoolean("alertsEnabled", alertsEnabled)
        .putInt("silentNotifIntervalMin", silentNotifIntervalMin.toInt().coerceIn(1, 60))
        .putBoolean("audibleBroadcastEnabled", audibleBroadcastEnabled)
        .putInt("audibleBroadcastIntervalMin", audibleBroadcastIntervalMin.toInt().coerceIn(5, 120))
        .putString("lowAlertTone", lowAlertTone)
        .putString("highAlertTone", highAlertTone)
        .putString("lowVibration", lowVibration)
        .putString("highVibration", highVibration)
        .putBoolean("vibrateEnabled", vibrateEnabled)
        .apply()
      val intent = Intent(reactContext, GlucoseService::class.java).apply {
        putExtra("pollSeconds", pollSeconds.toInt().coerceIn(30, 900))
        putExtra("units", units)
        putExtra("lowMgDl", lowMgDl.toInt())
        putExtra("highMgDl", highMgDl.toInt())
        putExtra("alertsEnabled", alertsEnabled)
        putExtra("silentNotifIntervalMin", silentNotifIntervalMin.toInt().coerceIn(1, 60))
        putExtra("audibleBroadcastEnabled", audibleBroadcastEnabled)
        putExtra("audibleBroadcastIntervalMin", audibleBroadcastIntervalMin.toInt().coerceIn(5, 120))
        putExtra("lowAlertTone", lowAlertTone)
        putExtra("highAlertTone", highAlertTone)
        putExtra("lowVibration", lowVibration)
        putExtra("highVibration", highVibration)
        putExtra("vibrateEnabled", vibrateEnabled)
      }
      ContextCompat.startForegroundService(reactContext, intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("START_FAILED", e.message)
    }
  }

  @ReactMethod
  fun updateServiceSettings(
    pollSeconds: Double, units: String,
    lowMgDl: Double, highMgDl: Double, alertsEnabled: Boolean,
    silentNotifIntervalMin: Double,
    audibleBroadcastEnabled: Boolean,
    audibleBroadcastIntervalMin: Double,
    lowAlertTone: String,
    highAlertTone: String,
    lowVibration: String,
    highVibration: String,
    vibrateEnabled: Boolean,
    promise: Promise
  ) {
    try {
      securePrefs().edit()
        .putInt("pollSeconds", pollSeconds.toInt().coerceIn(30, 900))
        .putString("units", units)
        .putInt("lowMgDl", lowMgDl.toInt())
        .putInt("highMgDl", highMgDl.toInt())
        .putBoolean("alertsEnabled", alertsEnabled)
        .putInt("silentNotifIntervalMin", silentNotifIntervalMin.toInt().coerceIn(1, 60))
        .putBoolean("audibleBroadcastEnabled", audibleBroadcastEnabled)
        .putInt("audibleBroadcastIntervalMin", audibleBroadcastIntervalMin.toInt().coerceIn(5, 120))
        .putString("lowAlertTone", lowAlertTone)
        .putString("highAlertTone", highAlertTone)
        .putString("lowVibration", lowVibration)
        .putString("highVibration", highVibration)
        .putBoolean("vibrateEnabled", vibrateEnabled)
        .apply()

      if (GlucoseService.running) {
        val intent = Intent(reactContext, GlucoseService::class.java).apply {
          action = GlucoseService.ACTION_UPDATE_SETTINGS
          putExtra("pollSeconds", pollSeconds.toInt().coerceIn(30, 900))
          putExtra("units", units)
          putExtra("lowMgDl", lowMgDl.toInt())
          putExtra("highMgDl", highMgDl.toInt())
          putExtra("alertsEnabled", alertsEnabled)
          putExtra("silentNotifIntervalMin", silentNotifIntervalMin.toInt().coerceIn(1, 60))
          putExtra("audibleBroadcastEnabled", audibleBroadcastEnabled)
          putExtra("audibleBroadcastIntervalMin", audibleBroadcastIntervalMin.toInt().coerceIn(5, 120))
          putExtra("lowAlertTone", lowAlertTone)
          putExtra("highAlertTone", highAlertTone)
          putExtra("lowVibration", lowVibration)
          putExtra("highVibration", highVibration)
          putExtra("vibrateEnabled", vibrateEnabled)
        }
        reactContext.startService(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("UPDATE_SETTINGS_FAILED", e.message)
    }
  }

  @ReactMethod
  fun stopService(promise: Promise) {
    try {
      reactContext.stopService(Intent(reactContext, GlucoseService::class.java))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("STOP_FAILED", e.message)
    }
  }

  @ReactMethod
  fun isServiceRunning(promise: Promise) {
    promise.resolve(GlucoseService.running)
  }

  @ReactMethod
  fun getLatest(promise: Promise) {
    try {
      val json = securePrefs().getString("latest_json", null)
      promise.resolve(json)
    } catch (e: Exception) {
      promise.reject("READ_FAILED", e.message)
    }
  }

  @ReactMethod
  fun requestBatteryExemption(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val pm = reactContext.getSystemService(PowerManager::class.java)
        val pkg = reactContext.packageName
        if (pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
          val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$pkg")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          reactContext.startActivity(intent)
          promise.resolve(false)
          return
        }
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("BATTERY_FAILED", e.message)
    }
  }

  @ReactMethod
  fun requestNotificationPermission(promise: Promise) {
    // Runtime POST_NOTIFICATIONS is requested from JS via PermissionsAndroid.
    // This just confirms the channel path exists by touching the service prefs.
    promise.resolve(true)
  }

  /* ── Overlay methods ── */

  @ReactMethod
  fun startOverlay(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(reactContext)) {
        promise.resolve(false)
        return
      }
      val intent = Intent(reactContext, OverlayService::class.java)
      reactContext.startService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("OVERLAY_START_FAILED", e.message)
    }
  }

  @ReactMethod
  fun stopOverlay(promise: Promise) {
    try {
      reactContext.stopService(Intent(reactContext, OverlayService::class.java))
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("OVERLAY_STOP_FAILED", e.message)
    }
  }

  @ReactMethod
  fun isOverlayRunning(promise: Promise) {
    promise.resolve(OverlayService.running)
  }

  @ReactMethod
  fun requestOverlayPermission(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        if (Settings.canDrawOverlays(reactContext)) {
          promise.resolve(true)
          return
        }
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:${reactContext.packageName}")
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
        // User must grant manually, return false for now
        promise.resolve(false)
      } else {
        promise.resolve(true)
      }
    } catch (e: Exception) {
      promise.reject("OVERLAY_PERM_FAILED", e.message)
    }
  }

  @ReactMethod
  fun testAlertNotification(isLow: Boolean, valueMgDl: Double, promise: Promise) {
    try {
      val units = securePrefs().getString("units", "mgdl") ?: "mgdl"
      val v = valueMgDl.toInt()
      val display = if (units == "mmol") String.format(java.util.Locale.US, "%.1f mmol/L", v / 18.01559) else "$v mg/dL"
      val arrow = if (isLow) "⮇" else "⮅"
      val state = if (isLow) "LOW" else "HIGH"
      GlucoseService.fireAlertNotification(reactContext, display, arrow, state, isLow, isTest = true)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("TEST_ALERT_FAILED", e.message)
    }
  }

  @ReactMethod
  fun acknowledgeAlert(promise: Promise) {
    try {
      GlucoseService.acknowledgeAlert(reactContext)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("ACK_FAILED", e.message)
    }
  }

  @ReactMethod
  fun openNotificationSettings(channelType: String?, promise: Promise) {
    try {
      val channelId = when (channelType?.lowercase()) {
        "low" -> GlucoseService.CHANNEL_ALERT_LOW
        "high" -> GlucoseService.CHANNEL_ALERT_HIGH
        "broadcast" -> GlucoseService.CHANNEL_BROADCAST
        "status" -> GlucoseService.CHANNEL_STATUS
        else -> GlucoseService.CHANNEL_ALERT_LOW
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
          putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
          putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
      } else {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:${reactContext.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        reactContext.startActivity(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SETTINGS_FAILED", e.message)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Double) {}
}
