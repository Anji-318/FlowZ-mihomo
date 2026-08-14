package com.flowz.android

/**
 * 生成 mihomo 运行配置。
 *
 * 与桌面端共用同一份配置语义（mihomo-config-builder.ts 的产物同样是标准 YAML），
 * 区别只在接管方式：桌面端 TUN 由内核自建（auto-route），Android 端虚拟网卡由
 * VpnService 创建、经 `tun.file-descriptor` 把 fd 交给内核（mihomo 官方支持，见
 * listener/config.Tun.FileDescriptor，Android/iOS 移动端的标准接法）。
 *
 * 两种输入：
 *  - http(s):// 订阅地址（须返回 Clash/mihomo 格式 proxies）→ proxy-providers 模式；
 *  - 其余视为完整 mihomo YAML 原文 → 原样落盘，仅强制覆盖 external-controller/tun 接管段。
 */
object MihomoConfigGen {

    const val CONTROL_PORT = 9090
    const val SECRET = "flowz-android"

    fun build(input: String, tunFd: Int): String {
        val trimmed = input.trim()
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            fromSubscription(trimmed, tunFd)
        } else {
            fromRawYaml(trimmed, tunFd)
        }
    }

    private fun tunBlock(tunFd: Int) = """
tun:
  enable: true
  file-descriptor: $tunFd
  stack: gvisor
  dns-hijack:
    - any:53
  auto-route: false
  auto-detect-interface: false
  mtu: 1500
""".trimIndent()

    private fun fromSubscription(url: String, tunFd: Int) = """
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:$CONTROL_PORT
secret: $SECRET
# 与桌面端/FlClash 默认一致：延迟按去除握手差异口径计时（false 会把握手计入、数值虚高）
unified-delay: true

dns:
  enable: true
  ipv6: false
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://doh.pub/dns-query
    - https://dns.google/dns-query
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.0/15
  fake-ip-filter:
    - lan
    - localhost
    - '*.lan'
    - '*.local'
    - time.*.com
    - ntp.*.com

${tunBlock(tunFd)}

proxy-providers:
  sub:
    type: http
    url: $url
    path: ./providers/sub.yaml
    interval: 86400
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

proxy-groups:
  - name: proxy-selector
    type: select
    use:
      - sub
    proxies:
      - auto
      - DIRECT
  - name: auto
    type: url-test
    use:
      - sub
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 100

rule-providers:
  geosite-cn:
    type: http
    behavior: domain
    format: mrs
    url: https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs
    path: ./rulesets/geosite-cn.mrs
    interval: 86400
  geoip-cn:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/cn.mrs
    path: ./rulesets/geoip-cn.mrs
    interval: 86400

rules:
  - RULE-SET,geosite-cn,DIRECT
  - RULE-SET,geoip-cn,DIRECT
  - MATCH,proxy-selector
""".trimIndent()

    /**
     * 原始 YAML 模式：强制接管 external-controller 与 tun（fd 只能由本服务产生）。
     * 若用户 YAML 已含同名片段，简单起见不解析合并——直接前置覆盖段，mihomo 解析后者生效。
     */
    private fun fromRawYaml(yaml: String, tunFd: Int): String {
        val header = """
external-controller: 127.0.0.1:$CONTROL_PORT
secret: $SECRET
${tunBlock(tunFd)}
""".trimIndent()
        return header + "\n" + yaml + "\n"
    }
}
