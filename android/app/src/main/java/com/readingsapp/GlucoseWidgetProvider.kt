package com.readingsapp

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.widget.RemoteViews
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class GlucoseWidgetProvider : AppWidgetProvider() {

  companion object {
    fun refresh(context: Context) {
      try {
        val mgr = AppWidgetManager.getInstance(context)
        val ids = mgr.getAppWidgetIds(
          ComponentName(context, GlucoseWidgetProvider::class.java)
        )
        if (ids.isEmpty()) {
          return
        }
        val intent = Intent(context, GlucoseWidgetProvider::class.java).apply {
          action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
          putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
        }
        context.sendBroadcast(intent)
      } catch (_: Exception) {}
    }
  }

  private fun prefs(context: Context): SharedPreferences {
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

  override fun onUpdate(
    context: Context, mgr: AppWidgetManager, ids: IntArray
  ) {
    val p = prefs(context)
    val value = p.getInt("lastValue", 0)
    val trend = p.getInt("lastTrend", 0)
    val epoch = p.getLong("lastEpoch", 0)
    val units = p.getString("units", "mgdl") ?: "mgdl"
    val low = p.getInt("lowMgDl", 70)
    val high = p.getInt("highMgDl", 180)

    val ageMs = if (epoch > 0) System.currentTimeMillis() - epoch else Long.MAX_VALUE
    val isDead = epoch == 0L || ageMs > 30 * 60 * 1000
    val isStale = ageMs > 15 * 60 * 1000

    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.widget_glucose)
      if (value > 0 && !isDead) {
        val display = if (units == "mmol") {
          String.format(Locale.US, "%.1f", value / 18.01559)
        } else {
          value.toString()
        }
        val arrow = when (trend) {
          1 -> "↓"; 2 -> "↘"; 3 -> "→"; 4 -> "↗"; 5 -> "↑"; else -> ""
        }
        val time = try {
          SimpleDateFormat("h:mm a", Locale.US).format(Date(epoch))
        } catch (_: Exception) { "" }
        val unitLabel = if (units == "mmol") "mmol/L" else "mg/dL"

        if (isStale) {
          views.setTextViewText(R.id.widget_value, "$display $arrow (Stale)")
          views.setTextViewText(R.id.widget_sub, "Stale · $unitLabel · $time")
          views.setTextColor(R.id.widget_value, 0xFFD29922.toInt()) // amber
        } else {
          views.setTextViewText(R.id.widget_value, "$display $arrow")
          views.setTextViewText(R.id.widget_sub, "$unitLabel · $time")
          val color = when {
            value < low -> 0xFFF85149.toInt()  // red
            value > high -> 0xFFD29922.toInt() // amber
            else -> 0xFF3FB950.toInt()         // green
          }
          views.setTextColor(R.id.widget_value, color)
        }
      } else {
        views.setTextViewText(R.id.widget_value, "–––")
        views.setTextColor(R.id.widget_value, 0xFF8B949E.toInt())
        val msg = if (epoch > 0L) "Sensor ended / No recent data" else "Open Readings to sign in"
        views.setTextViewText(R.id.widget_sub, msg)
      }
      try {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val pi = android.app.PendingIntent.getActivity(
          context, 0, launch,
          android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        views.setOnClickPendingIntent(R.id.widget_root, pi)
      } catch (_: Exception) {}
      try {
        mgr.updateAppWidget(id, views)
      } catch (_: Exception) {}
    }
  }
}
