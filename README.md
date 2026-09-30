# Knowledge Garden

Knowledge Garden 是一个公开的、由 Markdown 驱动的 Quartz 知识花园（a public, Markdown-powered Quartz site），用来发布相互连接的个人笔记。

## Requirements / 环境要求

- Node.js 22+
- npm 10.9.2+
- Git

## Start locally / 本地启动

在项目目录安装依赖和 Quartz 配置的插件，然后启动本地预览服务器：

```sh
npm ci
npx quartz plugin install
npx quartz build --serve
```

在浏览器打开 <http://localhost:8080>。`npx quartz build --serve` 会持续运行并占用当前终端；需要执行其他命令时请打开第二个终端，回到运行窗口按 Ctrl+C 才能停止预览服务器。

## Write a public note / 编写公开笔记

把模板复制到 `content/` 下已有的子文件夹，并使用全小写文件名。Windows PowerShell 示例：

```powershell
Copy-Item templates/note-template.md content/technology/my-first-note.md
```

上例把模板复制为 `content/technology/my-first-note.md`；`my-first-note.md` 是可按主题改名的全小写文件名，`technology` 也可以换成其他 `content/` 子文件夹。然后更新顶部 `---` 之间的 frontmatter（笔记的元数据）：`title`、`date`、`description`、`tags` 每一项都要填写；在正文中使用 `[[wiki links]]` 格式（例如 `[[css-grid|CSS Grid 的二维布局心智模型]]`）添加 wiki link。`|` 前是目标文件名（不含 `.md`），`|` 后是页面显示的标签；跨文件夹或主题域链接时，在 `|` 前写相应的文件夹路径。先验证内容，再预览：

```sh
npm run validate:content
npx quartz build --serve
```

预览服务器启动后会一直运行；请在第二个终端执行验证等其他命令，完成后在运行预览的终端按 Ctrl+C 停止。`content/` 下的 Markdown 笔记、图片等附件以及其他非 Markdown 文件都可能被发布到网站。

## Keep a note private / 保持笔记私密

所有私密材料（包括草稿、附件和其他文件）只放在被忽略的 `private/` 下。该目录只有 `private/.gitkeep` 被跟踪；不要使用 `git add -f` 强制添加私密文件。Quartz 的内容输入目录是 `content/`，也就是说 Quartz only builds `content/`；因此 `private/` 不会被构建进网站。但公开 GitHub 仓库中任何已经提交的文件（无论位于哪个目录）都对仓库访问者可见，不能把密钥或其他敏感材料提交到仓库。

每次提交前检查工作区，确认没有私密笔记或附件出现在列表中：

```sh
git status --short
```

## Verify changes / 验证改动

发布前运行完整的网站验证：

```sh
npm run verify:site
```

该命令会运行网站工具测试、验证 Markdown 元数据、检查 Quartz 源码和格式、构建网站，并检查生成页面中的内部链接。

## Publish with GitHub Pages / 发布到 GitHub Pages

将 `main` 分支推送到 GitHub，然后在仓库中打开 **Settings → Pages**，将发布来源设为 **GitHub Actions**。Pages 工作流会先运行验证，再部署网站；之后推送到 `main` 也只有在这些检查成功后才会发布。

## Update Quartz / 更新 Quartz

目标是 Quartz 的 `v5` 分支。全新 clone 后先检查远程仓库；如果输出中还没有 `quartz-upstream`，只在缺少时添加：

```sh
git remote -v
```

如果输出中还没有 `quartz-upstream`，再执行一次添加命令（已有该 remote 时不要重复添加）：

```sh
git remote add quartz-upstream https://github.com/jackyzha0/quartz.git
```

然后获取并检查目标 `v5` 分支：

```sh
git fetch quartz-upstream v5
git log --oneline HEAD..quartz-upstream/v5
```

如果 `quartz-upstream` 已存在，不要重复执行 `git remote add`；保留这个 remote，直接执行 fetch 和 log。逐条检查 `HEAD..quartz-upstream/v5` 中的上游改动，确认影响后再手动合并或挑选需要的提交，不要盲目 merge。每次更新 Quartz 后都重新运行 `npm run verify:site`。

## Windows desktop publisher / Windows 桌面发布器

`apps/publisher` 提供 Electron 桌面界面，用于打开、编辑、预览和选择性发布这个知识花园。开发环境先分别安装根项目和应用依赖，再启动应用：

```powershell
npm ci
npm --prefix apps/publisher ci
npm --prefix apps/publisher run dev
```

运行应用测试与网站验证：

```powershell
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run test:run
npm --prefix apps/publisher run build
npm --prefix apps/publisher run test:e2e
npm run verify:site
```

E2E 测试会打开开发版 Electron，但不会安装发布包。首次运行测试时 Electron 自身的开发二进制需要已由 `npm ci` 正确下载。

### Build the Windows installer / 构建 Windows 安装包

```powershell
npm --prefix apps/publisher run package:win
```

构建前脚本从 Node.js 官方站点下载固定的 Windows x64 Node `22.16.0` 与 `SHASUMS256.txt`，严格匹配文件名并验证 SHA-256 后，才原子地安装到被 Git 忽略的 `apps/publisher/vendor/node/`。安装包输出到 `apps/publisher/release/`；这是可选择安装目录、无需管理员权限的每用户 NSIS 安装程序。请勿提交 `vendor/node/` 或 `release/` 中的生成文件。

### Daily workflow / 日常工作流

1. 从左侧选择公开或私密笔记，在中间编辑 Markdown；等待底部显示“已保存”。
2. 用编辑器顶部的“公开 / 私密”菜单移动笔记。私密笔记物理存放在 `private/`，不会作为发布候选。
3. 在右侧查看本地 Quartz 预览；构建错误时先修正笔记，再继续。
4. 点击“检查并发布”，逐项检查变化。公开变化默认勾选，私密变化锁定且不能选择；只勾选本次确实要上线的内容。
5. 点击“验证并发布”。应用在隔离的 Git 树中验证所选内容，验证成功后才创建提交并推送到 `origin/main`。未选择的本地编辑会继续保留。

将已发布的公开笔记改为私密只能阻止当前版本继续发布，并在下一次发布中下线网页；旧内容仍可能保留在 Git 历史、他人的 clone 或缓存中。应用不会自动重写共享历史。密钥和真正敏感的信息从一开始就不要放进公开提交。

### Git credentials and recovery / Git 凭据与恢复

发布需要系统中可用的 Git、`origin/main`，以及已有的 Windows Git Credential Manager 凭据。应用沿用 Git 的凭据流程，不读取、保存或要求粘贴 GitHub 密码/token；远程分支发生分歧、真实索引已有暂存内容或推送失败时会停止，不会强制推送、重置或丢弃工作区修改。

编辑会自动保存，并在 `.garden-publisher/` 中维护恢复状态。意外关闭后按启动提示恢复；删除操作进入 Windows 回收站。若启动或发布失败：

- 在启动检查中确认固定花园目录、Git、`origin/main`、依赖与预览端口；
- 关闭占用 `8080` 的程序，或重启应用让预览选择可用端口；
- 用 Git Credential Manager 修复远程认证，不要把凭据写进配置文件；
- 依赖不匹配时使用应用提供的依赖修复，或在项目根目录重新运行 `npm ci`；
- 推送失败但本地提交已创建时，先检查 `git status` 和远程变化，再安全重试，不要使用强制推送。
