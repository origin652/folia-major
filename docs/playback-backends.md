# 播放后端与独立模组

## 自维护分支与上游同步

`personal/playback-backends` 保留上游 mpv HiFi 和通用模组接口。统一入口在「播放控制 → 播放引擎」；`selection.ts` 先暂停并等待旧输出释放，再选择并准备新引擎，保留进度且不自动播放。主线 mpv 的来源限制、满音量确认和设备设置不变，显式选择模组时不再进入主线 mpv 路线。

主线信号链路面板只适用于 Web Audio / 内置 mpv，使用模组时隐藏该入口，不把外部播放器误标成 Web Audio 或已确认直通。模组输出的设备 / 格式以模组遥测和播放器自身显示为准；HQPlayer 的真实 SDM 输出仍需单独验证。

日常同步在这个长期分支上合并 `origin/main`（本地远程 `origin` 是上游，`fork` 是个人 GitHub 仓库），不强推或反复改写已发布历史。宿主适配与两个模组分别提交；合并前保留快照。重点回归引擎互斥、旧会话事件隔离、静音、暂停 / seek、连续结束换曲和歌词时钟；模拟测试不证明真实 DAC 的独占或 SDM 能力。本分支的检查更新固定到个人发布源，不消费官方包；首次启用、版本标识和发布流程见 [个人版更新](personal-updates.md)。

宿主改造入口是 `src/services/playbackBackend/`，不依赖具体引擎。Folium 边界在 `src/mods/folium/playbackBackends.ts`；模组声明 `playback.backend` 权限和 `playback.backends` 实验 opt-in 后，在主窗口通过 `folium.experimental['playback.backends'].register` 注册。完整结构类型来自 `contract.ts`，编辑后运行 `npm run folium:types` / `npm run folium:api`，不手改生成文件。

契约：`create(report)` 创建会话，`open` 准备暂停输出，`play/pause/seek/setVolume/dispose` 操作它；事件带每次加载唯一的 `sourceId`。实际输出遥测将 `exclusiveRequested` 与 `exclusiveActive` 分开；模组应依据设备确认，而不是照抄开关。宿主过滤退休会话/音源的事件，序列化准备与清理，使用原生时钟驱动既有 MotionValue 帧循环。

注册不等于启用后端。用户在播放控制中显式选择；默认保持 Web Audio，选择不持久化。选中模组被撤销时暂停并保留“不可用”选择，不能偷偷换输出。外部输出期间不挂浏览器音源，并旁路宿主 EQ、ReplayGain、automix 与淡入淡出。切换输出会暂停，释放前一个设备后才允许新会话初始化。

HTTP 能力后端可直接接收宿主已经解析的地址；其他源通过 `playbackSources` preload 服务暂存原始字节（不经过浏览器解码）。IPC 仅允许受信任主窗口主 frame，释放仅接受当前 store 铸造的 ID，不接受任意路径。文件上限 512 MiB，暂不流式送入原生引擎；大型文件和在线地址过期仍需改进。模组安装容许原生引擎，ZIP 最大 128 MiB、单文件 128 MiB、展开总量 256 MiB、文件数 2000，解压和内容摘要仍执行上限与路径校验。

独立实现放在 `extensions/native-audio/`，不在官方签名示例 `mods/` 中。源码与可安装 ZIP 分开；引擎下载、校验、离线 SoXR 探针、运行库与许可打包由模组自身的 `package.mjs` 负责，不往宿主塞播放器或 DSP 实现。

## HQPlayer 独立模组

`extensions/hqplayer/` 通过同一契约实现 Signalyst Control API，本机程序发现、按需启动和传输逻辑都留在模组里，无须给宿主增加 HQPlayer 分支。使用限制和验证记录见模组 README。官方 [Embedded 产品页](https://signalyst.com/hqplayer-embedded/) 与 [下载 / SDK 入口](https://signalyst.com/downloads/) 是接入依据。

0.1.4 的 `extensions/hqplayer/displayClock.mjs` 在模组客户端去重重复位置，并按旧宿主的一秒插值规则回报连续时间，避免原始状态把字幕时钟拉回。小幅前向校准有单次上限；领先过多时暂缓回报，让旧宿主停止外推并等待原生时钟追上。明确 seek、暂停、切歌与错误单独处理。不增加 HQPlayer 查询频率、定时器或逐帧 RPC，不访问宿主私有状态，也不需要修改或重新安装已有支持播放后端接口的主程序。

适配时仍需处理服务发现/认证、版本能力、播放时钟/seek、错误和断线恢复。远端 HQPlayer 不能读取 Folia 的 blob 或本机暂存路径，需后续设计可访问的媒体服务及访问控制，不能把本地路径直接交给远端。HQPlayer 自己负责滤波/设备输出，宿主不替它宣称独占或 bit-perfect，也不未经用户选择同时启用两条 DSP 链。
