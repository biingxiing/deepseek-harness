# Agent Note: 运行时本地插件命令

Status: implemented

[English](2026-08-14-runtime-local-plugin-command.md) | 中文

## Problem

Profile 插件管理会安装持久包，并在进程启动时组合它们的 bundle 层。对于已经启动交互式 DSH 进程、希望在不停止进程、不修改 profile 且不运行包管理器的情况下试用一个本地 Host 插件的操作者，该路径无法满足需求。编辑实时用户 patch 可以挂载已经可寻址的模块，但这会暴露 Loader 配置细节、持久化实验，并且无法让命令平面给出有界的信任与生命周期决策。

## Decision

随附 base 组合通过 `@deepseek-ai/dsh-command-add-plugin` 注册 `/add-plugin <directory>`。完整后缀是相对于接收命令 Session workspace 的一个路径。规范 workspace 包含检查会拒绝词法与链接形式的越界。该目录是一个预先构建的 Node 包，其 `package.json.main` 必须解析到目录内的 `.js`、`.mjs` 或 `.cjs` 文件；bundle 与 Client 包格式会明确失败。

该命令通过文件 URL 创建内存 Loader 根条目。规范目录身份让进程内的重复请求保持幂等。加载按顺序执行，激活失败通过 Loader 回滚，取消会撤回延迟完成的条目，而命令插件的 effect 会先等待已接纳工作，再移除它拥有的全部条目。Profile、patch、包 manifest 和依赖树都不会改变。加载的 Host 插件是全进程状态，并在生产方卸载或 DSH 退出时消失。

## 信任与呈现

只有人类命令平面会调用该操作；它不是模型工具。Workspace 包含检查限制命令选择哪个包，但不会在导入后约束所选代码。模块获得普通 Host Cordis context，因此拥有受信任进程内插件代码的权限。命令目录会指出该信任要求，包 README 则说明 effect 可以影响每个 Session。

通用命令生命周期通过 `command/run` 与 `command/done` 记录所提供路径和直接结果。两者都不会成为模型消息。激活后引入的任何提示词、工具、事件或缓存影响都属于所加载插件。

## Alternatives considered

**从命令运行 `dsh plugin ... add`。** 拒绝，因为包管理器执行会修改 profile 和依赖树，可能需要网络或构建批准，并且仍然无法以事务方式把新声明的 bundle 层加入启动时组合。

**改写实时 `cordis.patch.yml`。** 拒绝，因为它会把实验变成持久配置，与用户编辑竞争，需要自行发明条目 id 和 YAML 写入语义，并让清理所有权落在命令调用之外。

**复用动态 Cordis package runner。** 拒绝，因为该 runner 管理模型编写的内存源码、Session 范围的版本定义、可选 Client 批准和受限 context。带有 Node 依赖解析的受信任文件系统包具有不同的身份、权限和生命周期要求。

**允许任意 Host 目录或直接源码文件。** 初始命令拒绝这样做。Session workspace 包含检查把用户当前项目作为选择边界，已构建包入口则为 Node 模块格式与依赖行为提供一个明确来源。更宽的根目录、TypeScript 执行、bundle 重新组合和 Client 发布都需要单独设计。

## Consequences

操作者可以在运行中的 Web 进程激活本地 Host 插件，并立即观察它的普通 Cordis effect。该操作可随生产方拆卸而逆转，不会留下持久 profile 状态。聚焦覆盖会验证路径与包校验、重复身份、激活回滚、取消、串行关闭和经 Loader 组合的 HMR 移除；随附 Web 组合则验证命令发现。

该命令有意不充当包安装器、bundle loader、Client 热部署器、源码编译器或持久插件管理器。即使模块来自 workspace，它仍拥有完整 Host 插件权限，而且全部 Session 会共享其全局 effect。持久化成功实验仍需使用 profile 插件管理并重启。
