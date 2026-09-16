package expo.modules.familycirclebridge

import android.os.Handler
import android.os.PowerManager
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

/** Service-owned, bounded JS work; never uses HeadlessJsTaskService's static lock. */
internal class LocationTasks(
  private val service: LocationSharingService,
  private val handler: Handler,
  private val idle: () -> Unit,
) : HeadlessJsTaskEventListener {
  private val host get() = (service.application as ReactApplication).reactHost!!
  private var startup: RuntimeStartup<ReactContext>? = null
  private var listener: ReactInstanceEventListener? = null
  private var context: HeadlessJsTaskContext? = null
  private var task: Int? = null
  private var active = false
  private var pending = false
  private var closed = false
  private var lock: PowerManager.WakeLock? = null
  private val timeout = Runnable { finish(true) }
  fun request() {
    if (closed) return
    if (active) { pending = true; return }
    active = true
    lock = service.getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilyCircle:location-sync").apply { acquire(35_000) }
    handler.postDelayed(timeout, 30_000)
    try {
      startup = RuntimeStartup(
        current = { host.currentReactContext }, ready = { it.hasActiveReactInstance() },
        listen = { initialized ->
          listener = object : ReactInstanceEventListener {
            override fun onReactContextInitialized(context: ReactContext) { handler.post { initialized() } }
          }.also { host.addReactInstanceEventListener(it) }
        },
        unlisten = { listener?.let { host.removeReactInstanceEventListener(it) }; listener = null },
        startRuntime = { host.start(); Unit },
        startTask = { react ->
          try {
            context = HeadlessJsTaskContext.getInstance(react).also { it.addTaskEventListener(this) }
            task = context!!.startTask(HeadlessJsTaskConfig("FamilyCircleLocationSync", Arguments.createMap(), 25_000, true))
          } catch (_: Exception) { finish(true) }
        },
      )
      startup!!.begin()
    } catch (_: Exception) { finish(true) }
  }
  override fun onHeadlessJsTaskStart(taskId: Int) { }
  override fun onHeadlessJsTaskFinish(taskId: Int) { handler.post { if (task == taskId) finish(false) } }
  private fun finish(cancel: Boolean) {
    if (!active) return
    handler.removeCallbacks(timeout)
    startup?.cancel(); startup = null
    context?.removeTaskEventListener(this)
    if (cancel) task?.let { if (context?.isTaskRunning(it) == true) context?.finishTask(it) }
    task = null; context = null; active = false
    lock?.let { if (it.isHeld) it.release() }; lock = null
    if (pending && !closed) { pending = false; request() } else idle()
  }
  fun close() { closed = true; pending = false; finish(true) }
}
