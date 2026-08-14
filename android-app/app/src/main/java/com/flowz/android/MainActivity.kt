package com.flowz.android

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 骨架 UI：订阅地址 / 原始 YAML 输入 + 启动停止 + 内核状态滚动展示。
 * 桌面端 FlowZ 的完整 UI（节点列表/规则编辑/测速）后续经 REST API
 * （127.0.0.1:9090，secret=flowz-android）对接——协议与桌面端 mihomo-api-client 一致。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var input: EditText
    private lateinit var toggle: Button
    private lateinit var status: TextView
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val vpnPermission =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                startVpnService()
            } else {
                status.text = "VPN 授权被拒绝"
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("flowz", MODE_PRIVATE)
        input = EditText(this).apply {
            hint = "订阅地址（Clash/mihomo 格式）或完整 YAML"
            setText(prefs.getString("config_input", ""))
            minLines = 5
            gravity = android.view.Gravity.TOP
        }
        toggle = Button(this).apply {
            text = "启动代理"
            setOnClickListener { onToggle() }
        }
        status = TextView(this).apply {
            text = "已停止"
            setPadding(16, 16, 16, 16)
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
            addView(input, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(toggle)
            addView(status)
        }
        setContentView(ScrollView(this).apply { addView(layout) })

        // 内核状态行实时刷新
        scope.launch {
            FlowZVpnService.state.collect { line ->
                status.text = (status.text.toString().lines() + line).takeLast(12).joinToString("\n")
                toggle.text = if (FlowZVpnService.running) "停止代理" else "启动代理"
            }
        }
    }

    private fun onToggle() {
        if (FlowZVpnService.running) {
            ContextCompat.startForegroundService(
                this, Intent(this, FlowZVpnService::class.java).setAction(FlowZVpnService.ACTION_STOP)
            )
            return
        }
        val text = input.text.toString().trim()
        if (text.isEmpty()) {
            status.text = "请先填写订阅地址或 YAML 配置"
            return
        }
        getSharedPreferences("flowz", MODE_PRIVATE).edit()
            .putString("config_input", text).apply()

        // VPN 用户授权（首次弹系统对话框）
        val prepareIntent = VpnService.prepare(this)
        if (prepareIntent != null) {
            vpnPermission.launch(prepareIntent)
        } else {
            startVpnService()
        }
    }

    private fun startVpnService() {
        val intent = Intent(this, FlowZVpnService::class.java)
            .setAction(FlowZVpnService.ACTION_START)
            .putExtra(
                FlowZVpnService.EXTRA_CONFIG_INPUT,
                getSharedPreferences("flowz", MODE_PRIVATE).getString("config_input", "")
            )
        ContextCompat.startForegroundService(this, intent)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
