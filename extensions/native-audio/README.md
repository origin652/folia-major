# Native Audio 0.1.1（实验版）

独立安装的 Folium 模组；宿主只提供通用播放后端接口，不依赖 mpv、SoXR 或本目录。Windows x64 打包版自带 mpv/FFmpeg/SoXR 引擎，不需要安装系统播放器。仅依赖 Folium 公共 API 与模组自己的 JSON RPC，不导入宿主内部代码。

## 安装与开关

1. 使用包含本次后端接口改造的 Folia（旧版 0.7.21 没有 `playback.backends`）。
2. 在仓库根运行 `node extensions/native-audio/package.mjs`，或加一个已下载的锁定版本 `.7z` 路径；脚本先验证 SHA-256，再生成 `test-results/native-audio-package/native-audio-0.1.1-win32-x64.zip`。打包会获取并校验引擎和 GPL/LGPL 许可证文本；网络下载只发生在开发打包阶段，播放时不联网安装组件。
3. 设置 → 模组 → 安装 ZIP，审阅未签名模组警告并启用。模组不会自动接管输出。
4. 设置 → 播放控制 → 播放后端，显式选择 Native Audio。后端选择只对本次会话有效。
5. 模组设置 → 原生音频与 DSP：独占、DSP 总开关、SoXR 升频、余量与 EQ 分别控制；独占、DSP、升频默认关闭。引擎路径默认 `bundled`，可改成自选 `mpv.exe` 的完整路径；不用 `mpv.com` 包装器。

音频输出设备使用下拉列表，启用模组时从引擎查询真实 WASAPI 设备，不播放音频。插拔 DAC 或更换引擎后执行“刷新音频设备”；不会自动改变已选设备，失联的已保存设备也会保留。三个切换命令现在显示开关结果；未选择 Native Audio 后端、或 DSP 总开关关闭导致 SoXR 旁路时，会明确提示。开关状态不是独占成功或升频成功的证明，实际状态以播放后的设备报告为准。

改设置暂停并重新打开输出，不自动恢复发声。播放设置显示实际采样率、容器格式和独占确认状态。独占失败、请求格式/采样率未获设备接受、缺少 SoXR、DSP 初始化失败都停止，界面显示错误，不回退共享/null 输出或旁路失败滤镜。关闭独占后才会明确重新以共享模式打开。

## 音频处理

- FFmpeg 解码包括 24 位 PCM、32 位整数 PCM 与 32 位浮点 PCM；不经浏览器 AudioContext 解码。本次增加的是播放路径，不是新的导出编码器。
- 自动协商、`s32` 整数容器、`float` 浮点容器可选。24 位有效样本通常装在 32 位容器中；容器位数不代表 DAC 有效位数。不能据此承诺全链路 32 位整数 bit-perfect。
- DSP：双精度余量增益、SoXR precision=33 重采样、双精度低/高频搁架 EQ。文本顺序 `headroom,resample,eq` 可重排，每个模块可旁路。DSP 总开关关闭时不安装滤镜；没有“自动音质增强”。
- 升频目标 88.2–768 kHz，低于源采样率时拒绝；设备必须接受目标输出采样率。共享模式仍受 Windows 混音格式约束，通常应选择独占后升频。更高采样率不增加原始信息，也不保证更好听。EQ 正增益可能削波，固定余量不是限幅器。
- 独占不等于 bit-perfect：音量、DSP 和格式转换都可能改变样本；共享模式明确可能被系统重采样。

## 当前边界

无 gapless/跨曲混音、宿主 ReplayGain/EQ/淡入淡出、原生 FFT 频谱、Stage/视频导出适配、ASIO、DSD 输出、HQPlayer 控制或任意第三方 DSP 插件 ABI。浏览器音效不作用于本后端；须在本模组调 DSP。每曲一个原生进程，暂停可能继续占用独占设备，切回浏览器/停用模组释放设备。远端 HTTP 地址沿用宿主已解析地址，暂不额外提供凭据/Headers 或在线失败自动重取；本地 blob 由宿主暂存原始字节，单文件上限 512 MiB。

## 验证

仓库根运行 `npm run test:unit -- test/unit/playback-backend`。静音硬件探针：`node test/manual/nativeAudioSmoke.cjs <mpv.exe完整路径>`，包括共享/独占、PCM24/int32/float32、seek/重复 EOF 与 SoXR；样本全零且音量为零，不做听感结论。设备矩阵不能由一台机器推断。来源与许可见 `THIRD_PARTY_NOTICES.md`；研究依据见 `docs/audio-dsp-research.md`。
