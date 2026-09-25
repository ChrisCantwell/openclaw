package ai.openclaw.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restores the always-on node service after a device reboot.
 *
 * Wake-word satellites stay plugged in and are rarely touched, so a reboot must not leave a room
 * silently unlistened. Only reconnects when the user already enabled wake words; nothing is
 * revived on a device where the feature is off.
 */
class BootCompletedReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val app = context.applicationContext as? NodeApp ?: return
    if (!app.prefs.voiceWakeEnabled.value) return
    NodeForegroundService.resume(context, startNow = true)
  }
}
