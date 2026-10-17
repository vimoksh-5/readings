package com.readingsapp

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.Locale

class OverlayService : Service() {

  companion object {
    @Volatile var running = false
    @Volatile private var instance: OverlayService? = null

    fun updateReading(context: Context, valueMgDl: Int, trend: Int, epochMs: Long) {
      val svc = instance ?: return
      svc.handler?.post {
        svc.onNewReading(valueMgDl, trend, epochMs)
      }
    }
  }

  private var windowManager: WindowManager? = null
  private var overlayView: View? = null
  private var handler: android.os.Handler? = null
  private var valueTv: TextView? = null
  private var trendTv: TextView? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    running = true
    handler = android.os.Handler(mainLooper)
    showOverlay()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Load latest reading from prefs if available
    try {
      val prefs = securePrefs()
      val value = prefs.getInt("lastValue", 0)
      val trend = prefs.getInt("lastTrend", 0)
      val epoch = prefs.getLong("lastEpoch", 0)
      if (value > 0) {
        onNewReading(value, trend, epoch)
      }
    } catch (_: Exception) {}
    return START_STICKY
  }

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

  @Suppress("ClickableViewAccessibility")
  private fun showOverlay() {
    windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    overlayView = LayoutInflater.from(this).inflate(R.layout.overlay_bubble, null)
    valueTv = overlayView?.findViewById(R.id.overlay_value)
    trendTv = overlayView?.findViewById(R.id.overlay_trend)

    val layoutType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    } else {
      @Suppress("DEPRECATION")
      WindowManager.LayoutParams.TYPE_PHONE
    }

    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      layoutType,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT
    ).apply {
      gravity = Gravity.TOP or Gravity.END
      val prefs = securePrefs()
      x = prefs.getInt("overlayX", 16)
      y = prefs.getInt("overlayY", 120)
    }

    // Make draggable with tap detection and position persistence
    var initialX = 0
    var initialY = 0
    var initialTouchX = 0f
    var initialTouchY = 0f

    overlayView?.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          initialX = params.x
          initialY = params.y
          initialTouchX = event.rawX
          initialTouchY = event.rawY
          true
        }
        MotionEvent.ACTION_MOVE -> {
          // Note: x is measured from right when gravity is END
          params.x = initialX - (event.rawX - initialTouchX).toInt()
          params.y = initialY + (event.rawY - initialTouchY).toInt()
          try {
            windowManager?.updateViewLayout(overlayView, params)
          } catch (_: Exception) {}
          true
        }
        MotionEvent.ACTION_UP -> {
          val diffX = Math.abs(event.rawX - initialTouchX)
          val diffY = Math.abs(event.rawY - initialTouchY)
          if (diffX < 15 && diffY < 15) {
            // Tap! Launch Readings app
            val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            if (launch != null) {
              startActivity(launch)
            }
          } else {
            // Save final position so overlay stays where user places it
            securePrefs().edit()
              .putInt("overlayX", params.x)
              .putInt("overlayY", params.y)
              .apply()
          }
          true
        }
        else -> false
      }
    }

    try {
      windowManager?.addView(overlayView, params)
    } catch (e: Exception) {
      stopSelf()
    }
  }

  fun onNewReading(valueMgDl: Int, trend: Int, epochMs: Long) {
    val prefs = securePrefs()
    val units = prefs.getString("units", "mgdl") ?: "mgdl"
    val low = prefs.getInt("lowMgDl", 70)
    val high = prefs.getInt("highMgDl", 180)

    val ageMs = if (epochMs > 0) System.currentTimeMillis() - epochMs else Long.MAX_VALUE
    val isDead = ageMs > 30 * 60 * 1000
    val isStale = ageMs > 15 * 60 * 1000

    if (isDead) {
      valueTv?.text = "–––"
      trendTv?.text = "⚠"
      overlayView?.findViewById<View>(R.id.overlay_bubble_bg)?.let {
        it.background?.setTint(0xCC484F58.toInt()) // muted grey
      }
      return
    }

    val display = if (units == "mmol") {
      String.format(Locale.US, "%.1f", valueMgDl / 18.01559)
    } else {
      valueMgDl.toString()
    }
    val arrow = when (trend) {
      1 -> "↓"; 2 -> "↘"; 3 -> "→"; 4 -> "↗"; 5 -> "↑"; else -> ""
    }

    valueTv?.text = display
    trendTv?.text = if (isStale) "·" else arrow

    // Color code the bubble based on range
    val bgColor = when {
      isStale -> 0xCC8B949E.toInt() // slate grey for stale data
      valueMgDl < low -> 0xE6F85149.toInt()    // red with alpha
      valueMgDl > high -> 0xE6D29922.toInt()   // orange with alpha
      else -> 0xE63FB950.toInt()                // green with alpha
    }
    overlayView?.findViewById<View>(R.id.overlay_bubble_bg)?.let {
      it.background?.setTint(bgColor)
    }
  }

  override fun onDestroy() {
    try {
      overlayView?.let { windowManager?.removeView(it) }
    } catch (_: Exception) {}
    overlayView = null
    instance = null
    running = false
    super.onDestroy()
  }
}
