package com.flowz.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.system.Os
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

/**
 * FlowZ Android VPN 服务：VpnService 建虚拟网卡 → fd 交给 mihomo 子进程。
 *
 * 环路规避：Builder.addDisallowedApplication(packageName) 把本应用（含其子进程，
 * 同 UID）整体排除出 VPN 路由 → mihomo 的上行连接直连物理网络，无需跨进程 protect()。
 */
class FlowZVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.flowz.android.START"
        const val ACTION_STOP = "com.flowz.android.STOP"
        const val EXTRA_CONFIG_INPUT = "config_input"

        /** 运行状态（MainActivity 轮询展示）。 */
        val state = MutableStateFlow("已停止")
        @Volatile var running = false
            private set
    }

    private var tunInterface: ParcelFileDescriptor? = null
    private var coreProcess: Process? = null
    private var logThread: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdown("已停止")
                return START_NOT_STICKY
            }
            else -> {
                val configInput = intent?.getStringExtra(EXTRA_CONFIG_INPUT).orEmpty()
                startVpn(configInput)
                return START_STICKY
            }
        }
    }

    private fun startVpn(configInput: String) {
        if (running) return
        state.value = "正在建立虚拟网卡…"

        // 1) 建 TUN：地址/路由/DNS 由 VpnService 承担（mihomo 侧 auto-route=false）
        val builder = Builder()
            .setSession("FlowZ Clash")
            .setMtu(1500)
            .addAddress("172.19.0.1", 30)
            .addDnsServer("172.19.0.2")
            // 0.0.0.0/1 + 128.0.0.0/1 等价全覆盖，但不替换系统默认路由（更不容易踩 ROM 兼容坑）
            .addRoute("0.0.0.0", 1)
            .addRoute("128.0.0.0", 1)
            .setBlocking(false)
        try {
            // 本应用（含 mihomo 子进程）绕过 VPN —— 防代理回环的关键
            builder.addDisallowedApplication(packageName)
        } catch (e: Exception) {
            shutdown("排除本应用失败：${e.message}")
            return
        }

        val pfd = builder.establish()
        if (pfd == null) {
            shutdown("虚拟网卡建立失败（未授权？）")
            return
        }
        tunInterface = pfd
        val tunFd = pfd.detachFd()

        // 2) 落配置（注入 fd）→ 拉起内核
        val workDir = filesDir
        val configFile = File(workDir, "mihomo_config.yaml")
        configFile.writeText(MihomoConfigGen.build(configInput, tunFd))

        val coreBin = File(applicationInfo.nativeLibraryDir, "libmihomo.so")
        if (!coreBin.exists()) {
            shutdown("内核缺失：${coreBin.absolutePath}（该 ABI 未打包 mihomo）")
            return
        }
        try {
            Os.chmod(coreBin.absolutePath, 493) // 0755
        } catch (_: Exception) { /* nativeLibraryDir 通常已可执行 */ }

        state.value = "正在启动 mihomo 内核…"
        try {
            coreProcess = ProcessBuilder(
                coreBin.absolutePath, "-d", workDir.absolutePath, "-f", configFile.absolutePath
            ).redirectErrorStream(true).start()
        } catch (e: Exception) {
            shutdown("内核启动失败：${e.message}")
            return
        }

        // 3) 内核日志 → logcat + 状态流（取最后一行做通知）
        logThread = Thread {
            try {
                coreProcess!!.inputStream.bufferedReader().forEachLine { line ->
                    android.util.Log.i("mihomo", line)
                    state.value = line
                }
            } catch (_: Exception) {
            }
            if (running) shutdown("内核已退出")
        }.also { it.isDaemon = true; it.start() }

        running = true
        state.value = "运行中（mixed-port 7890）"
        startForeground(1, buildNotification("FlowZ Clash 代理运行中"))
    }

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel("vpn", "代理服务", NotificationManager.IMPORTANCE_LOW)
        )
        val openIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, "vpn")
            .setContentTitle("FlowZ Clash")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun shutdown(status: String) {
        running = false
        state.value = status
        try {
            coreProcess?.destroy()
        } catch (_: Exception) {
        }
        coreProcess = null
        try {
            tunInterface?.close()
        } catch (_: Exception) {
        }
        tunInterface = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        shutdown("已停止")
        super.onDestroy()
    }

    override fun onRevoke() {
        shutdown("VPN 权限被收回")
        super.onRevoke()
    }
}
