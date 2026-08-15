# @deepseek-ai/dsh-command-add-plugin

[English](README.md) | 中文

面向用户的 `/add-plugin` 命令，用于把一个受信任的本地 Cordis Host 插件加载到正在运行的进程。该命令通过 [`ctx.commands`](../commands/README.md) 注册，并通过 Cordis Loader 创建内存中的根条目，因此兼容的交互式适配器无需重启 DSH 即可激活插件。

## 命令约定

```text
/add-plugin <directory>
```

命令后的完整后缀就是一个目录路径，因此含空格的路径不需要引号。相对路径从接收命令的 Session `header.cwd` 解析；绝对路径只有在规范化目标仍位于该 workspace 内时才会被接受。workspace 与插件目录都会经过 `fs.realpath`，因此 `..`、符号链接和 Windows junction 都不能选中 Session workspace 之外的包。没有 `cwd` 的 Session 无法运行该命令。

所选目录必须包含 JSON 对象形式的 `package.json`，其中 `main` 是非空字符串。规范化入口必须留在所选目录内，是普通文件，并以 `.js`、`.mjs` 或 `.cjs` 结尾。包及其全部依赖必须已经构建且可在本地解析；该命令不执行安装或构建。声明 `dsh.bundle` 或 `dsh.client` 的包会被拒绝，因为这些格式需要重新组合配置或向浏览器交付 bundle，而不是挂载单个 Host 模块。

加载成功时会返回包名、规范目录和生成的 Loader 条目 id。对同一规范目录重复执行命令会返回已有条目，不会重复挂载。操作失败会成为直接命令错误；导入或激活失败不会留下 Loader 条目。

## 生命周期与信任

加载操作按顺序执行，因为 Loader 根树变更是事务性的且不可重入。命令被取消后，如果条目才完成加载，该条目会被移除。卸载本命令插件时会先停止接纳工作，等待已经接纳的加载完成，再按相反顺序移除其条目；重启 DSH 具有相同的进程内结果。它不会写入 `package.json`、`cordis.patch.yml`、profile manifest 或除通用 `command/run` 与 `command/done` 记录以外的 Session 领域事件。

workspace 检查是路径选择策略，不是代码沙箱。所选模块作为受信任 Host 代码执行，获得普通 Cordis context，并可注册对进程内每个 Session 可见的全局服务、工具、命令、事件监听器或其他 effect。输入 `/add-plugin` 就是显式执行决策；只能加载内容及依赖均可信的代码。

## 组合

该插件注入 `commands` 与 `loader`：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-add-plugin
  name: '@deepseek-ai/dsh-command-add-plugin'
```

随附 base bundle 会挂载该生产方。Web 应用提供随附的交互式命令适配器；headless 与自动化表层不会分派斜杠命令。

## 模型体验

### 用户 `/add-plugin` 加载

#### 模型看到的内容

没有直接内容。`/add-plugin` 命令行与直接结果留在人类命令平面，不会作为用户消息提交。加载的插件可以依照自身行为，独立增加模型可见工具、提示词区段或后续 Session 事件。

#### Token 影响

命令自身不增加模型 token。后续任何 token 影响都属于所加载插件注册的贡献。

#### KV Cache 影响

命令发现与直接输出不影响请求缓存。加载的插件如果改变提示词区段或工具 schema，会依照普通注册规则改变后续请求前缀。

## 已知限制与暂缓事项

- **仅限 Host 模块** —— 尚未实现运行时 bundle 层重新组合与 Client bundle 发布；`dsh.bundle` 和 `dsh.client` 目录会明确失败。
- **没有持久化或移除命令** —— 本生产方卸载或 DSH 退出时，已加载条目会消失。需要持久化时，通过 `dsh plugin --profile <name> add <package>` 和 profile 配置加入受信任包，并重启 profile 以激活该持久组合。
- **要求已构建入口** —— TypeScript 源码、包管理器安装、依赖解析修复、编译和源码 HMR 都不属于该命令。
