package com.readingsapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
      intent.action != Intent.ACTION_MY_PACKAGE_REPLACED &&
      intent.action != "android.intent.action.QUICKBOOT_POWERON"
    ) {
      return
    }
    try {
      val prefs = try {
        val masterKey = androidx.security.crypto.MasterKey.Builder(context)
          .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
          .build()
        androidx.security.crypto.EncryptedSharedPreferences.create(
          context, "glucose_secure", masterKey,
          androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
      } catch (_: Exception) {
        context.getSharedPreferences("glucose_secure_fallback", Context.MODE_PRIVATE)
      }
      val patientId = prefs.getString("patientId", "") ?: ""
      val token = prefs.getString("token", "") ?: ""
      if (patientId.isEmpty() || token.isEmpty()) {
        return
      }
      val svc = Intent(context, GlucoseService::class.java)
      ContextCompat.startForegroundService(context, svc)
    } catch (_: Exception) {}
  }
}
