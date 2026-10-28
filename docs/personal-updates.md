# 个人分支更新

更新源固定为 `origin652/folia-major` 的 `personal/playback-backends` 分支。中央配置在 `shared/personalUpdates.cjs`，发布资产入口是专用的 `personal-playback-backends` prerelease；不查询官方仓库、GitHub latest 或其他 fork 通道。旧设置中的 Realeco / Limo / Cielo 不会覆盖此来源。

## 使用

先手动安装一次包含本功能的个人版安装包。旧版程序不会因为推送了源码而自动拥有新更新源。

- 设置 → 通用 → 更新检查 → **检查更新**：主动检查已发布的包，即使启动检查开关已关闭也可使用。
- 发现新版本后点击 **立即更新**：Windows 下载并校验安装包，显示下载进度；完成后再点击 **重启安装**。不会在后台静默退出播放器。
- 自动更新开关仅自动下载，不自动安装。macOS / Linux 沿用手动下载完整安装包。
- 命令面板也有「检查更新」「立即更新」（后者限 Windows）；安装重启没有一键执行快捷键。
- 没有个人发布或 `personal.yml` 时显示暂无更新包；网络、校验、元数据错误可重试，不回退到官方源。

更新的是宿主程序，不会自动安装、覆盖或升级独立的 HQPlayer / Native Audio 模组；已有用户配置和模组目录不因更新源切换而迁移。

通用鉴权媒体桥从 `0.7.22-personal.0.4` 的个人安装包提供。HQPlayer 流式播放还需单独导入 `hqplayer-0.2.3.zip` 并开启模组设置中的流式开关；仅升级主程序不会把旧模组改成流式模式。模组在旧宿主上保持完整文件暂存。

## 构建和发布

`.github/workflows/personal-release.yml` 只有手动触发，不随普通推送发布。不触发工作流、不创建 Release、不修改默认分支，是此次源码改动的边界。

工作流需在 GitHub 默认分支注册后才可 `workflow_dispatch`；若默认分支还没有该文件，仅推送个人分支不会让手动按钮可用。注册工作流、调整默认分支或首次发布需维护者另行安排，不需要为使用个人更新源改变上游 `main` 的同步策略。

工作流默认仅构建并保存 Actions artifacts。显式选择 `personal/playback-backends`、勾选 `publish` 后才发布更新；仓库与 ref 均有白名单保护。三平台构建全部成功后才进入发布阶段。

- `packaging/personal/stamp.cjs` 写入来源分支、完整 commit，以及 `上游版本-personal.<run_number>.<run_attempt>`。同一上游版本下的个人提交仍能升级，重跑会增加 attempt。仓库中的 `-personal.0` 是本地基线；常规发布请使用工作流生成的版本，不能反复分发同版本不同内容。
- electron-builder 只生成 personal 通道元数据；Windows 使用 `personal.yml`、macOS 构建保留 `personal-mac.yml`。跨平台检查沿用 Windows 元数据里的共同版本号。
- `packaging/personal/publish.cjs` 先校验版本和资产，再上传带版本名的安装包和 blockmap，最后替换通道 YAML。旧资产保留，避免正在下载旧版本的客户端遇到 404；首次发布先暂存为 draft，资产上传完成后才公开。
- 已公开版本不得被相同或更低版本替换；客户端也显式禁止降级。个人版本必须包含 `-personal.`，其他通道的元数据和安装包事件会被拒绝。
- 发布页正文记录源分支和 commit。滚动 tag 本身保留首次创建位置，不把它当作当前构建 commit；当前构建身份以正文和包内 `foliaUpdateSource` 为准。

安装包沿用项目现有签名策略和 electron-updater 的 SHA-512 校验；哈希能校验下载完整性，不等于新增代码签名或独立的供应链证明。GitHub 仓库和发布权限仍是信任边界。

## 验证范围

安装包生成后，`build/afterPack.cjs` 通过 `packaging/verifyProductionDependencies.cjs` 递归核对 ASAR 中的生产依赖（含已安装的可选依赖）。缺失必需传递依赖时立即失败，不再仅确认顶层包存在。打包目录使用独立的、按锁文件安装的生产依赖，不使用指向其他 worktree 的 `node_modules` junction；一次 `npm ci --omit=dev --ignore-scripts` 只应在独立构建目录执行，不能用于正在开发的共用依赖目录。

`0.7.22-personal.0.1` 本地安装包漏收了 `electron-store` 的 `conf` 等传递依赖，不能启动，请勿分发。修正版使用新的版本号，不能用相同文件名覆盖已交付包。

`test/unit/electron/personalUpdates.test.ts` 用内存 updater 执行主进程的实际更新接线，覆盖固定来源、旧通道偏好、重复请求、失败重试、无发布、关闭启动检查时的手动操作、下载状态保留和版本拒绝。`test/unit/settings/personalUpdatesPage.test.ts` 验证按钮启用条件、下载回调和显式重启安装。测试不会运行真实安装器或改动用户 profile。

这些测试不代替 GitHub 三平台打包，也不证明真实旧安装版 → 新安装版的升级。首次发布后仍需用隔离安装目录验证下载安装、签名提示、重启和配置保留。
