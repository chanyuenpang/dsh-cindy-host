# 设备管理与身份稳定性

## 删除

设置页的“账号设备”展示 Cindy 账号目录，不只是当前连接。离线设备可以逐项确认删除；本机与在线设备不可删。使用官方 DELETE /api/device-link/devices/:id，复用运行时现有 bearer，不触发登录或清除凭据。只有服务确认同一 ID deleted=true 后才移除；连接身份变化的迟到结果不会改写新连接状态。失败请刷新列表，网络中断可能意味着服务已执行但客户端未收到确认。不会自动按名称合并或批量删除。

## 重复设备的证据与限制（2026-10-20）

只读账号目录里，同名 HOP-AL00 对应五个不同 Android deviceId，另有离线旧 DSH Host。因此不是同一个 ID 被 UI 重复渲染；目录按 ID，而非名称识别设备。

Cindy 手机源码 apps/mobile/src/auth/deviceId.ts 的 ensureDeviceId 在 secure storage 没有 ID **或读取失败被 catch 为 null** 时生成新 UUID，且没有并发 singleflight。重装、清理存储、读取失败、并发初始化都可能导致新身份，旧账号记录仍保留。现有记录本身不能证明每条记录的历史原因。本次没有修改手机源码。

插件原先也把凭据读取失败当作不存在，并在 settings 镜像失败时继续注册新 ID。现已让读取失败终止该登录请求，新生成 ID 必须先成功写入提供的 settings 存储；并发请求复用同一 ID，已有凭据优先，既有身份不会因镜像失败丢失。CLI 显式登录的独立入口仍可能生成新身份，不应把它当作日常重连方式。

## Cindy 兼容版本来源

统一使用 **0.1.82**，来源为本机 G:/Projects/Cindy 的稳定标签 v0.1.82，提交 1d7aaa2fb4456c1ba96ab7f2125567d7c19bbf69，日期 2026-09-14T20:53:42+07:00。这是九月最后一个非 beta 标签；九月十五日另有 v0.1.83-beta，不混作稳定版。源码 desktop/package.json 的 0.0.0 是打包占位，不能用来冒充实际发行版本。

该值是 Cindy 协议 appVersion 的兼容标识，不是本插件发布版本，也不代表插件变成官方桌面端。hello、link-accept、status 均引用 src/host-version.js。本次不擅改插件 package version。

## 回归验证

2026-10-20 运行 `node --test`：698 项，697 通过，1 跳过，0 失败。覆盖删除确认、离线限制、服务失败、身份切换迟到结果、身份持久化失败与并发、版本一致性；未向真实账号发送 DELETE。`git diff --check` 通过。

## 安装状态

工作区 package 为 dsh-cindy-host-demo 0.1.13，当前桌面安装为 dsh-cindy-host 0.1.20。它们并非相同发行源码；不能直接用整份旧工作区覆盖当前安装包。本次先交付源码与测试，未将其覆盖部署到运行中的 DSH，未实际删除账号设备。
