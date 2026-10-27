# 来源与许可

本模组自有代码按仓库 AGPL-3.0 许可发布，ZIP 附根 LICENSE。HQPlayer 是 Signalyst 的独立商业软件，本模组不含 HQPlayer 可执行文件、不附许可证或注册数据、不代表 Signalyst 官方支持。

协议依据 Signalyst HQPlayer Control SDK 6.0.1（Copyright 2011–2026 Jussi Laako，MIT），仅据公开协议独立实现。本模组未直接包含 SDK 源码；官方来源与归档 SHA256 见 README。

主入口打包以下 npm 运行库及其依赖；各自完整许可随 ZIP 的 `licenses/` 目录分发：

- `@xmldom/xmldom` 0.9.12：MIT；严格 XML 解析与序列化。
- `file-type` 21.3.4：MIT；原始文件容器识别，不解码音频。
- `@tokenizer/inflate`、`@tokenizer/token`、`strtok3`、`token-types`、`uint8array-extras`：MIT。
- `ieee754`：BSD-3-Clause。
- 其他实际进入打包图的传递依赖（如 `debug`、`ms`、`@borewit/text-codec`）也自动附许可证；准确版本以 ZIP 中 `runtimeVersions.json` 为准。

打包工具 Rolldown 与 fflate 仅在构建时使用，不作为播放器/音频引擎分发。不使用第三方播放器 UI 或滤波器实现；没有“HQPlayer 音质增强算法”的移植或仿制。
