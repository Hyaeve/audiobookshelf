<br />
<div align="center">
   <img alt="Audiobookshelf Banner" src="https://github.com/advplyr/audiobookshelf/raw/master/images/banner.svg" width="600">

  <p align="center">
    <br />
    <a href="https://audiobookshelf.org/docs">文档</a>
    ·
    <a href="https://audiobookshelf.org/support">支持</a>
    ·
    <a href="https://audiobooks.dev/">在线演示</a>
  </p>
</div>

## ⚠️ 当前 Vue 前端的 Pull Request 暂不审核或合并。前端正在重写并迁移到 React，后续将提供新的版本。

# 本地定制功能说明

本项目在 AudioBookShelf 原有功能基础上增加了 `.strm` 音频文件支持和三套界面主题。以下说明适用于手动扫描媒体库、自动扫描、重新扫描以及实际播放流程。

## `.strm` 扫描规则

`.strm` 文件可以保存远程 HTTP(S) 音频地址，也可以保存本地绝对路径或相对于 `.strm` 文件所在目录的本地路径。

手动扫描媒体库、自动扫描和重新扫描时，服务端只检查库目录中是否存在 `.strm` 文件，并读取 `.strm` 文件自身的文件名、路径和文件系统元数据。`.strm` 指向的真实音频不会在扫描阶段被读取，具体包括：

- 不读取 `.strm` 文件中的目标地址内容。
- 不访问目标远程网盘或 HTTP(S) 地址。
- 不打开 `.strm` 指向的本地音频文件。
- 不对真实目标执行 `ffprobe`。
- 仍沿用原项目按照目录、文件名、标题、曲目编号和章节顺序组织音轨的逻辑。

因此，扫描阶段只是将 `.strm` 文件作为本地占位音频记录假入库，目标音频是否可访问不会影响扫描完成。手动扫描和重新扫描均遵守相同规则。

## `.strm` 播放规则

真正创建播放会话时，服务端根据当前播放进度，从当前章节开始预取最多 10 个 `.strm` 目标：

- 远程目标会发起真实 HTTP(S) 请求，响应缓存在内存中，不写入磁盘。
- 本地目标会打开文件句柄并缓存文件元数据，播放请求复用该句柄。
- 播放章节时优先使用当前会话的预取缓存，缓存未命中时回退到普通代理流程。
- 播放会话关闭、删除或过期时，释放本地文件句柄并清空远程响应缓存。
- 本地目标必须位于当前媒体库配置的目录内，防止通过 `.strm` 读取库目录之外的文件。

## 主题切换

顶部工具栏提供主题切换按钮，支持经典主题、星空夜间主题和 Apple TV 风格冰蓝浅色主题。主题选择保存在浏览器本地，刷新页面后仍然有效。

详细的代码锚点、上游同步方法和验证命令见 [`docs/CUSTOM_FEATURES.md`](docs/CUSTOM_FEATURES.md:1)。

# 项目简介

Audiobookshelf 是一个可自行部署的有声书和播客服务器。

### 主要功能

- 完全**开源**，包括处于测试阶段的 [Android 和 iOS 应用](https://github.com/advplyr/audiobookshelf-app)
- 支持各种音频格式在线播放
- 搜索并添加播客，支持自动下载节目
- 支持多用户和自定义权限
- 按用户保存播放进度，并在多个设备间同步
- 自动检测媒体库更新，通常无需手动重新扫描
- 支持批量拖放上传有声书和播客
- 支持元数据备份和每日自动备份
- 支持渐进式 Web 应用（PWA）
- Web 端和 Android 应用支持 Chromecast
- 从多个来源获取元数据和封面
- 支持章节编辑和章节查询，使用 [Audnexus API](https://audnex.us/)
- 将多个音频文件合并为单个 m4b 文件
- 将元数据和封面嵌入音频文件
- 提供基础电子书和电子阅读器功能
  - 支持 epub、pdf、cbr、cbz
  - 支持将电子书发送到设备，例如 Kindle
- 支持为播客和有声书提供 RSS Feed

如果你有希望加入的功能，可以[提交功能建议](https://github.com/advplyr/audiobookshelf/issues/new/choose)。

也可以加入 [Discord 社区](https://discord.gg/HQgCbd6E75)。

### 在线演示

可以访问 Web 客户端演示：[https://audiobooks.dev/](https://audiobooks.dev/)，感谢 [@Vito0912](https://github.com/Vito0912) 提供服务。

普通用户账号：用户名 `demo`，密码 `demo`。

### Android 应用（测试版）

可在 [Google Play 商店](https://play.google.com/store/apps/details?id=com.audiobookshelf.app)体验。

### iOS 应用（测试版）

**目前测试名额已满。Apple 将测试人数限制为 1 万人，后续更新会在 Discord 发布。**

[TestFlight 地址](https://testflight.apple.com/join/wiic7QIW)，目前测试名额已满。

<br />

<img alt="Library Screenshot" src="https://github.com/advplyr/audiobookshelf/raw/master/images/DemoLibrary.png" />

<br />

# 媒体整理

#### Audiobookshelf 非常依赖目录结构和文件夹命名。

支持的目录结构、文件夹命名约定以及音频文件元数据用法，请参阅[媒体库文档](https://audiobookshelf.org/docs/category/libraries)。

<br />

# 安装

请参阅[安装文档](https://audiobookshelf.org/docs/category/installation)。

<br />

# 反向代理配置

#### 重要：Audiobookshelf 需要 WebSocket 连接。

#### 注意：支持使用子目录部署，无需额外修改，但路径必须是 `/audiobookshelf`，该路径不可更改。详情请参阅[相关讨论](https://github.com/advplyr/audiobookshelf/discussions/3535)。

请参阅[反向代理文档](https://audiobookshelf.org/docs/category/reverse-proxy)。

<br />

# 参与贡献

请参阅[贡献指南](https://audiobookshelf.org/docs/contributing/general/)。

### 本地化

感谢 [Weblate](https://hosted.weblate.org/engage/audiobookshelf/) 免费提供本地化平台。如果你希望 Audiobookshelf 支持更多语言，欢迎参与翻译。关于如何参与翻译，请参阅[翻译帮助说明](https://www.audiobookshelf.org/faq#how-do-i-help-with-translations)。

<a href="https://hosted.weblate.org/engage/audiobookshelf/"> <img src="https://hosted.weblate.org/widget/audiobookshelf/abs-web-client/multi-auto.svg" alt="翻译状态" /> </a>

<br />

# 从源码运行

本项目基于 [Node.js](https://nodejs.org/) 构建。

## 使用开发容器

使用开发容器是开始开发本项目最简单的方式。关于 VS Code 开发容器的介绍，请参阅[官方文档](https://code.visualstudio.com/docs/devcontainers/containers)。

所需软件：

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [VS Code](https://code.visualstudio.com/download)

_注意：也可以使用 Docker 之外的容器软件和 VS Code 之外的 IDE，但配置过程会更复杂，本文不作说明。_

<details>
<summary>在 Windows 上使用 winget 安装所需软件</summary>

需要在已安装 winget 的 PowerShell 中执行：

```powershell
winget install -e --id Docker.DockerDesktop
winget install -e --id Microsoft.VisualStudioCode
```

</details>

<details>
<summary>在 macOS 上使用 Homebrew 安装所需软件</summary>

```sh
brew install --cask docker visual-studio-code
```

</details>

<details>
<summary>在 Linux 上使用 Snap 安装所需软件</summary>

```sh
sudo snap install docker
sudo snap install code --classic
```

</details>

安装上述软件后，请为 VS Code 安装 [Remote Development 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.vscode-remote-extensionpack)。安装完成后，打开命令面板（`Ctrl+Shift+P` 或 `Cmd+Shift+P`），执行 `>Dev Containers: Rebuild and Reopen in Container`。这会构建并启动开发环境容器。

完成后即可开始开发。

## 手动配置开发环境

如果不使用开发容器，也可以手动配置环境。首先安装 [Node.js 20](https://nodejs.org/) 和 [FFmpeg](https://ffmpeg.org/)。

然后在项目根目录创建 `dev.js` 文件，用于保存本地开发环境的配置和路径。可以参考 `.devcontainer/dev.js` 示例文件。

接下来构建客户端：

```sh
npm ci
cd client
npm ci
npm run generate
cd ..
```

## 开发命令

运行服务端：

```sh
npm run dev
```

该命令会使用在 `client` 目录执行 `npm run generate` 或由开发容器生成的客户端文件。修改服务端代码后需要重启服务；修改客户端代码后，需要重新执行 `(cd client; npm run generate)` 并重启服务。默认地址为 `localhost:3333`，端口可以在 `dev.js` 中配置。

运行支持热更新的客户端：

```sh
cd client
npm run dev
```

客户端默认运行在 `localhost:3000`，修改代码后会自动更新。

如果使用 VS Code，项目提供了预设调试任务：

- `Debug server`：运行服务端。
- `Debug client (nuxt)`：运行支持热更新的客户端。
- `Debug server and client (nuxt)`：同时运行服务端和客户端。
