package ai.openclaw.app

import ai.openclaw.app.i18n.nativeLocaleChanges
import ai.openclaw.app.i18n.nativeString
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Foreground service that keeps the Android node connection and voice capture visible to the OS. */
class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var voiceCaptureMode = VoiceCaptureMode.Off
  // Always-on wake listening keeps the microphone foreground-service type even when no Activity
  // is visible; the persistent notification is the OS-required disclosure for that capture.
  private var voiceWakeListening = false

  // Derived from the wake toggle plus the mic grant, never from transient recognizer state. The
  // recognizer cannot reach "listening" until it has microphone access, so keying the service type
  // off listening alone deadlocks: no mic type -> no capture -> never listening -> no mic type.
  private var voiceWakeMicHold = false

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    voiceWakeMicHold = computeWakeMicHold()
    val initial =
      buildNotification(
        title = nativeString("OpenClaw Node"),
        text = nativeString("Starting…"),
      )
    startForegroundWithTypes(notification = initial)
  }

  private fun observeRuntime(startId: Int) {
    val app = application as NodeApp
    notificationJob?.cancel()
    notificationJob =
      scope.launch {
        val runtime =
          try {
            withContext(Dispatchers.Default) {
              if (!app.nodeServiceStartAllowed) return@withContext null
              app.ensureBackgroundRuntime()
            }
          } catch (err: CancellationException) {
            throw err
          } catch (err: Throwable) {
            Log.e("OpenClawNodeService", "Failed to restore node runtime", err)
            stopSelfResult(startId)
            return@launch
          } ?: return@launch
        if (app.nodeServiceStartAllowed) collectNotificationState(runtime)
      }
  }

  private suspend fun collectNotificationState(runtime: NodeRuntime) {
    // Keep the connection tuple atomic, then split connection and capture work so notification text
    // can update without restarting runtime-owned connection work.
    val notificationStates =
      combine(
        combine(
          runtime.gatewayConnectionDisplay,
          runtime.serverName,
          runtime.voiceCaptureMode,
          runtime.locationMode,
        ) { connection, server, mode, _ ->
          VoiceNotificationBase(
            status = connection.statusText,
            server = server,
            connected = connection.isConnected,
            mode = mode,
          )
        },
        combine(
          runtime.micEnabled,
          runtime.micIsListening,
          runtime.talkModeListening,
          runtime.talkModeSpeaking,
        ) { micEnabled, micListening, talkListening, talkSpeaking ->
          MicCaptureState(
            micEnabled = micEnabled,
            micListening = micListening,
            talkListening = talkListening,
            talkSpeaking = talkSpeaking,
          )
        },
        combine(
          runtime.voiceWakeIsListening,
          runtime.voiceWakeEnabled,
        ) { wakeListening, wakeEnabled ->
          WakeCaptureState(listening = wakeListening, enabled = wakeEnabled)
        },
      ) { base, mic, wake ->
        VoiceNotificationState(
          base = base,
          capture =
            VoiceNotificationCapture(
              micEnabled = mic.micEnabled,
              micListening = mic.micListening,
              talkListening = mic.talkListening,
              talkSpeaking = mic.talkSpeaking,
              voiceWakeListening = wake.listening,
              voiceWakeEnabled = wake.enabled,
            ),
        )
      }
    refreshNotificationOnLocaleChanges(
      states = notificationStates,
      localeChanges = nativeLocaleChanges,
    ).collect { update ->
      ensureChannelForLocaleRevision(update.localeRevision)
      val state = update.state
      voiceCaptureMode = state.mode
      voiceWakeListening = state.capture.voiceWakeListening
      voiceWakeMicHold =
        wakeMicHoldEnabled(
          voiceWakeEnabled = state.capture.voiceWakeEnabled,
          recordAudioGranted = hasRecordAudioPermission(),
        )
      val title =
        when {
          state.connected && state.mode == VoiceCaptureMode.TalkMode -> {
            nativeString("OpenClaw Node · Talk")
          }

          state.connected -> {
            nativeString("OpenClaw Node · Connected")
          }

          else -> {
            nativeString("OpenClaw Node")
          }
        }
      val displayStatus = gatewayConnectionStatusForDisplay(state.status)
      val text =
        (state.server?.let { nativeString("\$status · \$server", displayStatus, it) } ?: displayStatus) +
          voiceNotificationSuffix(
            mode = state.mode,
            manualMicEnabled = state.capture.micEnabled,
            manualMicListening = state.capture.micListening,
            talkListening = state.capture.talkListening,
            talkSpeaking = state.capture.talkSpeaking,
            voiceWakeListening = state.capture.voiceWakeListening,
          )

      startForegroundWithTypes(
        notification = buildNotification(title = title, text = text),
      )
    }
  }

  private var channelLocaleRevision: Long? = null

  private fun ensureChannelForLocaleRevision(localeRevision: Long) {
    if (channelLocaleRevision == localeRevision) return
    ensureChannel()
    channelLocaleRevision = localeRevision
  }

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    val app = application as NodeApp
    when (intent?.action) {
      ACTION_STOP -> {
        notificationJob?.cancel()
        app.updateNodeServiceIntent(allowStart = false) { stopSelfResult(startId) }
        return START_NOT_STICKY
      }

      ACTION_SET_VOICE_CAPTURE_MODE -> {
        voiceCaptureMode = intent.getStringExtra(EXTRA_VOICE_CAPTURE_MODE).toVoiceCaptureMode()
        startForegroundWithTypes(
          notification =
            buildNotification(
              title = nativeString("OpenClaw Node"),
              text =
                if (voiceCaptureMode == VoiceCaptureMode.TalkMode) {
                  nativeString("Talk mode active")
                } else {
                  nativeString("Connected")
                },
            ),
        )
      }
    }
    if (!app.nodeServiceStartAllowed) {
      // A STOP can lose stopSelfResult to a newer queued start. Let the newest
      // start id close the service instead of leaving a disconnected FGS alive.
      stopSelfResult(startId)
      return START_NOT_STICKY
    }
    // START_STICKY recreates the service in a fresh process and calls this with a null intent.
    observeRuntime(startId)
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private fun ensureChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        nativeString("Connection"),
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = nativeString("OpenClaw node connection status")
        setShowBadge(false)
      }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(
    title: String,
    text: String,
  ): Notification {
    val launchPending = mainActivityPendingIntent(this, requestCode = 1)
    val visibleText = text + backgroundLocationNotificationSuffix(isBackgroundLocationActive())

    val stopIntent = Intent(this, NodeForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending =
      PendingIntent.getService(
        this,
        2,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat
      .Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(visibleText)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, nativeString("Disconnect"), stopPending)
      .build()
  }

  private fun startForegroundWithTypes(notification: Notification) {
    val serviceTypes =
      foregroundServiceTypes(
        voiceMode = voiceCaptureMode,
        backgroundLocationActive = isBackgroundLocationActive(),
        // Hold the microphone type while wake is armed, not merely while a session happens to be
        // live, so recognizer restarts keep microphone access instead of losing it between turns.
        voiceWakeActive = voiceWakeListening || voiceWakeMicHold,
      )
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceTypes)
  }

  private fun computeWakeMicHold(): Boolean {
    val prefs = (application as? NodeApp)?.prefs ?: return false
    return wakeMicHoldEnabled(
      voiceWakeEnabled = prefs.voiceWakeEnabled.value,
      recordAudioGranted = hasRecordAudioPermission(),
    )
  }

  private fun hasRecordAudioPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private fun isBackgroundLocationActive(): Boolean {
    if (!SensitiveFeatureConfig.backgroundLocationEnabled) return false
    if ((application as NodeApp).prefs.locationMode.value != LocationMode.Always) return false
    val fineGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val coarseGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    val backgroundGranted =
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
        PackageManager.PERMISSION_GRANTED
    return (fineGranted || coarseGranted) && backgroundGranted
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1

    private const val ACTION_STOP = "ai.openclaw.app.action.STOP"
    private const val ACTION_RESUME = "ai.openclaw.app.action.RESUME"
    private const val ACTION_SET_VOICE_CAPTURE_MODE = "ai.openclaw.app.action.SET_VOICE_CAPTURE_MODE"
    private const val EXTRA_VOICE_CAPTURE_MODE = "ai.openclaw.app.extra.VOICE_CAPTURE_MODE"

    fun start(context: Context) {
      if (!(context.applicationContext as NodeApp).nodeServiceStartAllowed) return
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      (context.applicationContext as NodeApp).updateNodeServiceIntent(allowStart = false) {
        context.stopService(Intent(context, NodeForegroundService::class.java))
      }
    }

    internal fun resume(
      context: Context,
      startNow: Boolean,
    ): () -> Boolean =
      (context.applicationContext as NodeApp).updateNodeServiceIntent(allowStart = true) {
        if (startNow) {
          val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_RESUME)
          context.startForegroundService(intent)
        }
      }

    fun setVoiceCaptureMode(
      context: Context,
      mode: VoiceCaptureMode,
    ) {
      if (!(context.applicationContext as NodeApp).nodeServiceStartAllowed) return
      val intent =
        Intent(context, NodeForegroundService::class.java)
          .setAction(ACTION_SET_VOICE_CAPTURE_MODE)
          .putExtra(EXTRA_VOICE_CAPTURE_MODE, mode.name)
      if (mode == VoiceCaptureMode.TalkMode) {
        // Microphone foreground service type must be declared before Talk capture starts.
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    }
  }
}

/**
 * Whether the microphone foreground-service type must be held for always-on wake listening.
 *
 * Android grants microphone as "while in use" only; a foreground service holding the microphone
 * type is what extends that capture past Activity visibility. Gating the type on the wake toggle
 * rather than on a live recognition session avoids the restart deadlock described in the service.
 */
internal fun wakeMicHoldEnabled(
  voiceWakeEnabled: Boolean,
  recordAudioGranted: Boolean,
): Boolean = voiceWakeEnabled && recordAudioGranted

internal fun foregroundServiceTypes(
  voiceMode: VoiceCaptureMode,
  backgroundLocationActive: Boolean,
  voiceWakeActive: Boolean = false,
): Int {
  val base = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
  val voiceTypes =
    when (voiceMode) {
      VoiceCaptureMode.Off -> base

      VoiceCaptureMode.ManualMic,
      VoiceCaptureMode.TalkMode,
      -> base or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
  // Always-on wake capture outlives the Activity, so it needs the microphone type on its own.
  val wakeTypes =
    if (voiceWakeActive) voiceTypes or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else voiceTypes
  return if (backgroundLocationActive) {
    wakeTypes or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
  } else {
    wakeTypes
  }
}

internal fun backgroundLocationNotificationSuffix(active: Boolean): String =
  if (active) {
    nativeString(" · Location: Always")
  } else {
    ""
  }

internal fun voiceNotificationSuffix(
  mode: VoiceCaptureMode,
  manualMicEnabled: Boolean,
  manualMicListening: Boolean,
  talkListening: Boolean,
  talkSpeaking: Boolean,
  voiceWakeListening: Boolean = false,
): String =
  when (mode) {
    VoiceCaptureMode.TalkMode -> {
      when {
        talkSpeaking -> nativeString(" · Talk: Speaking")
        talkListening -> nativeString(" · Talk: Listening")
        else -> nativeString(" · Talk: On")
      }
    }

    VoiceCaptureMode.ManualMic -> {
      if (manualMicEnabled) {
        if (manualMicListening) {
          nativeString(" · Mic: Listening")
        } else {
          nativeString(" · Mic: Pending")
        }
      } else {
        ""
      }
    }

    VoiceCaptureMode.Off -> {
      if (voiceWakeListening) nativeString(" · Wake: Listening") else ""
    }
  }

private fun String?.toVoiceCaptureMode(): VoiceCaptureMode =
  VoiceCaptureMode.entries.firstOrNull {
    it.name == this
  } ?: VoiceCaptureMode.Off

/** Connection fields that drive foreground notification title/body text. */
private data class VoiceNotificationBase(
  val status: String,
  val server: String?,
  val connected: Boolean,
  val mode: VoiceCaptureMode,
)

/** Manual mic and Talk capture fields. */
private data class MicCaptureState(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val talkListening: Boolean,
  val talkSpeaking: Boolean,
)

/** Wake-word fields: live listening drives copy, the toggle drives the held service type. */
private data class WakeCaptureState(
  val listening: Boolean,
  val enabled: Boolean,
)

/** Voice capture fields that affect foreground-service type and suffix. */
private data class VoiceNotificationCapture(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val talkListening: Boolean,
  val talkSpeaking: Boolean,
  val voiceWakeListening: Boolean,
  val voiceWakeEnabled: Boolean = false,
)

/** Aggregated notification state from runtime flows. */
private data class VoiceNotificationState(
  val base: VoiceNotificationBase,
  val capture: VoiceNotificationCapture,
) {
  val status: String
    get() = base.status
  val server: String?
    get() = base.server
  val connected: Boolean
    get() = base.connected
  val mode: VoiceCaptureMode
    get() = base.mode
}

/** Re-emits stable runtime state when app-owned notification copy changes locale. */
internal data class LocaleAwareNotificationState<T>(
  val state: T,
  val localeRevision: Long,
)

internal fun <T> refreshNotificationOnLocaleChanges(
  states: Flow<T>,
  localeChanges: Flow<Long>,
): Flow<LocaleAwareNotificationState<T>> =
  combine(states, localeChanges) { state, localeRevision ->
    LocaleAwareNotificationState(state = state, localeRevision = localeRevision)
  }
