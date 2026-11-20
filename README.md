# @kabxx/dsh-shell-permission-compat

面向 DeepSeek Harness（`0.2.2-rc.5`）的 Shell 权限兼容插件。

- 覆盖 `standard`、`ptc` 与 `cordis` 三套内置预设中的 Shell 工具（Linux / macOS / WSL 为 `bash`，原生 Windows 为 `pwsh`），保留原生工具说明、终端卡片、后台任务与审批链路。
- 在 `sandbox_permissions` 枚举中增加 `read-only`；当请求的最低权限已被当前沙箱满足时，自动忽略 `sandbox_permissions` 与 `justification` 并在当前有效权限下直接运行，仅在实际提权时触发审批：

| 当前有效权限 | 直接放行的请求值 |
| --- | --- |
| `danger-full-access` | `danger-full-access`、`workspace-write`、`read-only` |
| `workspace-write` | `workspace-write`、`read-only` |
| `read-only` | `read-only` |

## 安装

需要 Node.js `>= 24.9.0`：

```bash
dsh plugin --profile web add @kabxx/dsh-shell-permission-compat
```

也可在 DSH 插件管理器中选择「添加插件」并输入 `@kabxx/dsh-shell-permission-compat`（若使用其他配置档案，将 `--profile web` 替换为对应档案名）。本地调试源码时，直接填入克隆后的仓库目录绝对路径或执行 `dsh plugin --profile web add .` 即可。

## 开发

运行语法检查与测试（集成测试需将 `DSH_INSTALL_DIR` 指向本机 `@deepseek-ai/dsh` 安装目录）：

```bash
export DSH_INSTALL_DIR="$(npm root -g)/@deepseek-ai/dsh"
npm run check
npm test
npm pack --dry-run
```

## 项目结构

| 路径 | 内容 |
| --- | --- |
| [`src/bash.js`](src/bash.js) | `bash` 兼容子插件入口 |
| [`src/pwsh.js`](src/pwsh.js) | `pwsh` 兼容子插件入口 |
| [`src/permission.js`](src/permission.js) | `sandbox_permissions` 等级判定、参数归一化与轨迹展示适配 |
| [`locale/`](locale/) | 组合包及 `./bash`、`./pwsh` 子插件的中英文元信息 |
| [`test/`](test/) | 权限归一化单测与 DSH 预设装配集成测试 |

插件入口与预设覆盖配置见 [package.json](package.json) 和 [cordis.patch.yml](cordis.patch.yml)，开源许可见 [LICENSE](LICENSE)。
