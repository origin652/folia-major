# DSP / 升频选型记录（2026-10-23）

## 工程结论

首版使用成熟的 FFmpeg + SoXR，不自行发明插值器，也不复制 foobar2000 核心或 HQPlayer 私有算法。SoXR precision=33 是计算精度目标，不是“33 位可听分辨率”。滤波器优先考虑混叠/镜像抑制与稳定性，代价是计算量与延迟；不能把最高采样率当成最佳听感。默认 DSP 和升频关闭，支持受控比较和完全旁路。

升频是在已有带限信号上插值，不会恢复录音中不存在的信息；真实效果取决于原始母带、DAC 内部滤波、模拟输出级、听音条件与个人偏好。独占避免 Windows 共享混音路径，不自动意味着样本不变。EQ 可能有比升频更明显的听感影响，但必须控制增益和削波。

## 本次检索与证据边界

核对了下列论文的题名、作者、年份与 DOI（Crossref 元数据）；**未取得全文，不将题名当作实验结论**，也不宣称穷尽了截至 2026 年的文献。

| 文献 | 与本功能的关系 / 不应推导的结论 |
| --- | --- |
| Vesa Välimäki, Stefan Bilbao. *Giant FFTs for Sample-Rate Conversion*. JAES, 2023. [DOI](https://doi.org/10.17743/jaes.2022.0061) | 可进一步评估的高质量 SRC 实现方向；尚未复现，不据此替换成熟 SoXR 或声称更好听。 |
| Alistair Carson, Alec Wright, Stefan Bilbao. *Interpolation Filter Design for Sample Rate Independent Audio Effect RNNs*. ICASSP, 2025. [DOI](https://doi.org/10.1109/ICASSP49660.2025.10889121) | 主题是神经音效模型的采样率适配，不是普通播放器升频带来听感提升的证据。 |
| Arlen Card, Daniel Hatch. *The Sample Rate Battle: Opposing Approaches As to Sample Rates When Digitizing Audio*. IETC, 2024. [DOI](https://doi.org/10.1109/IETC61393.2024.10564372) | 相关讨论入口；不凭题名判定高采样率优劣。 |
| Joshua Reiss. *A Meta-Analysis of High Resolution Audio Perceptual Evaluation*. JAES, 2016. [DOI](https://doi.org/10.17743/jaes.2016.0015) | 高解析音频与感知评估的历史证据入口；不等同于对同一低采样率源做升频的实验。未在本次读取全文，未引用其效应大小。 |

接口/实现依据：[FFmpeg 重采样参数](https://ffmpeg.org/ffmpeg-resampler.html)、[SoXR 上游](https://sourceforge.net/projects/soxr/)、[mpv 音频选项](https://mpv.io/manual/master/#audio)。本机原有 mpv MSVC 构建实际不含 SoXR，已实测能触发拒绝而非旁路。模组打包改为锁定便携构建，并用静音离线升频探针验证实际具备 SoXR；不能只因为参数列表出现 `soxr` 就认为引擎编进了它。

## 质量验证与下一步研究

自动测试负责开关/旁路、滤镜次序、参数限制、实际输出率/格式检查与失败关闭；静音设备探针负责设备初始化、seek/EOF 和进程释放。这些都不能验证“更好听”。

公开发布前还应补充完整工程测量矩阵：44.1↔48 kHz 与整数倍率的通带纹波、阻带抑制、相位/群时延、脉冲响应、intersample peak、CPU/实时欠载与功耗；区分重采样器算法误差与设备输出转换。听感比较需相同源、音量匹配、隐藏条件的 ABX/随机化重复测试，并报告不确定性。没有这些测量，不声称“最好”、HQPlayer 等效或提升所有人的听感。
