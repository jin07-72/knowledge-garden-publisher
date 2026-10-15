# Optional Note Description and Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在新建笔记时可以留空“描述”和“标签”，提交时分别写入 `无` 和 `['无']`，并在两个字段旁显示默认行为提示。

**Architecture:** 只在渲染层 `NewNoteDialog` 的提交边界规范化空值，继续让 IPC Schema 和主进程笔记文件服务拒绝真正的空元数据。测试通过真实对话框交互覆盖空值、空白/逗号边界和现有非空值路径；辅助文字使用 `aria-describedby` 与输入框关联，避免改变字段的可访问名称。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、user-event、Electron Vite、CSS

---

## File map

- Modify `apps/publisher/tests/unit/main-layout.test.tsx`: 添加新建笔记选填元数据的渲染层回归测试，并保留现有非空值测试作为兼容性证明。
- Modify `apps/publisher/src/renderer/src/components/NoteSidebar.tsx`: 取消描述和标签的必填限制，在提交边界生成默认值，并渲染辅助说明。
- Modify `apps/publisher/src/renderer/src/app.css`: 为字段容器和辅助说明添加与现有对话框一致的布局、字号与弱化颜色。
- Do not modify `apps/publisher/src/shared/ipcSchemas.ts` or `apps/publisher/src/main/services/noteFiles.ts`: 它们继续执行严格的非空校验。

### Task 1: 用失败测试锁定选填字段和默认元数据

**Files:**
- Modify: `apps/publisher/tests/unit/main-layout.test.tsx:779-816`
- Test: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: 在现有正常创建测试后添加空字段行为测试**

在 `creates a note through the accessible new-note form` 测试之后添加：

```tsx
  it("defaults omitted note description and tags to 无", async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    const description = within(dialog).getByRole("textbox", { name: "描述" })
    const tags = within(dialog).getByRole("textbox", { name: "标签" })
    const create = within(dialog).getByRole("button", { name: "创建" })

    expect(description).not.toBeRequired()
    expect(tags).not.toBeRequired()
    expect(within(dialog).getAllByText("不填写默认为无")).toHaveLength(2)
    expect(create).toBeDisabled()

    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "无元数据笔记")
    expect(create).toBeEnabled()
    await user.click(create)

    await waitFor(() =>
      expect(garden.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "无元数据笔记",
          description: "无",
          tags: ["无"],
        }),
      ),
    )
  })
```

该测试同时证明标题仍为必填项，而描述和标签不会继续禁用创建按钮。

- [ ] **Step 2: 添加空白和逗号边界测试**

紧接着添加：

```tsx
  it("defaults whitespace-only description and comma-only tags to 无", async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "新建笔记" }))
    const dialog = screen.getByRole("dialog", { name: "新建笔记" })
    await user.type(within(dialog).getByRole("textbox", { name: "标题" }), "空白元数据笔记")
    await user.type(within(dialog).getByRole("textbox", { name: "描述" }), "   ")
    await user.type(within(dialog).getByRole("textbox", { name: "标签" }), " , ， ")
    await user.click(within(dialog).getByRole("button", { name: "创建" }))

    await waitFor(() =>
      expect(garden.notes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "空白元数据笔记",
          description: "无",
          tags: ["无"],
        }),
      ),
    )
  })
```

- [ ] **Step 3: 运行聚焦测试并确认以正确原因失败**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "defaults omitted|defaults whitespace"
```

Expected: FAIL。首个测试应报告描述或标签仍带有 `required`、提示不存在或创建按钮仍被禁用；边界测试不应观察到默认的 `description: "无"` 和 `tags: ["无"]`。

### Task 2: 在新建笔记提交边界生成默认值

**Files:**
- Modify: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx:78-99`
- Modify: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx:152-168`
- Modify: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx:214-224`
- Modify: `apps/publisher/src/renderer/src/app.css:1669-1688`
- Test: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: 在提交函数中规范化描述和标签**

在 `setError("")` 后、调用 `onCreate` 前计算严格请求值：

```tsx
    const normalizedDescription = description.trim() || "无"
    const normalizedTags = tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    const requestTags = normalizedTags.length > 0 ? normalizedTags : ["无"]
```

将 `onCreate` 请求中的现有描述和标签字段替换为：

```tsx
        description: normalizedDescription,
        tags: requestTags,
```

不要修改标题、文件名、领域、可见性、日期或正文的现有处理。

- [ ] **Step 2: 把描述和标签改为带可访问提示的选填字段**

用以下两个字段容器替换现有描述和标签 `<label>`：

```tsx
        <div className="new-note-field">
          <label htmlFor="new-note-description">描述</label>
          <input
            id="new-note-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-describedby="new-note-description-hint"
          />
          <small id="new-note-description-hint" className="form-hint">
            不填写默认为无
          </small>
        </div>
        <div className="new-note-field">
          <label htmlFor="new-note-tags">标签</label>
          <input
            id="new-note-tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="用逗号分隔"
            aria-describedby="new-note-tags-hint"
          />
          <small id="new-note-tags-hint" className="form-hint">
            不填写默认为无
          </small>
        </div>
```

显式 `htmlFor` 保持输入框的可访问名称仍分别是“描述”和“标签”；`aria-describedby` 让辅助说明也可被辅助技术读取。

- [ ] **Step 3: 只保留真正必填字段的按钮禁用条件**

把创建按钮的 `disabled` 表达式改为：

```tsx
            disabled={busy || !title.trim() || !slug.trim() || !domain}
```

标题、文件名、领域和忙碌状态继续阻止提交，描述与标签不再参与。

- [ ] **Step 4: 添加字段容器与提示样式**

把现有 `.new-note-dialog form > label` 规则扩展为：

```css
.new-note-dialog form > label,
.new-note-field {
  display: grid;
  gap: 6px;
  color: #aeb7c2;
  font-size: 11px;
}

.new-note-field > label {
  color: inherit;
}

.form-hint {
  color: #8d98a5;
  font-size: 10px;
}
```

保留紧随其后的输入框和下拉框样式不变。

- [ ] **Step 5: 运行新测试并确认通过**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "defaults omitted|defaults whitespace"
```

Expected: 2 tests PASS。请求分别包含 `description: "无"` 和 `tags: ["无"]`，且字段提示与可访问名称可查询。

- [ ] **Step 6: 运行整个新建笔记测试组，证明非空路径和错误路径未回归**

Run:

```powershell
npm --prefix apps/publisher run test:run -- tests/unit/main-layout.test.tsx -t "new-note|creates a note|defaults omitted|defaults whitespace"
```

Expected: 匹配的测试全部 PASS，包括现有非空描述/多标签拆分、忙碌状态、Strict Mode、失败重试和焦点管理测试。

- [ ] **Step 7: 提交功能和回归测试**

```powershell
git add -- apps/publisher/src/renderer/src/components/NoteSidebar.tsx apps/publisher/src/renderer/src/app.css apps/publisher/tests/unit/main-layout.test.tsx
git commit -m "feat: make note description and tags optional"
```

Expected: 新提交只包含上述三个文件。

### Task 3: 完整验证并准备交付

**Files:**
- Verify: `apps/publisher/src/renderer/src/components/NoteSidebar.tsx`
- Verify: `apps/publisher/src/renderer/src/app.css`
- Verify: `apps/publisher/tests/unit/main-layout.test.tsx`

- [ ] **Step 1: 检查格式和意外空白**

Run:

```powershell
git diff HEAD^ --check
npx prettier --check apps/publisher/src/renderer/src/components/NoteSidebar.tsx apps/publisher/src/renderer/src/app.css apps/publisher/tests/unit/main-layout.test.tsx
```

Expected: 两条命令均以退出码 0 完成，且 Prettier 报告所有文件格式正确。

- [ ] **Step 2: 运行 Publisher 全量单元与集成测试**

Run:

```powershell
npm --prefix apps/publisher run test:run -- --maxWorkers=2
```

Expected: 所有测试文件和测试用例 PASS；现有显式跳过项可以保持 SKIP，但不得出现失败。

- [ ] **Step 3: 运行类型检查和生产构建**

Run:

```powershell
npm --prefix apps/publisher run typecheck
npm --prefix apps/publisher run build
```

Expected: TypeScript 无错误；Electron Vite 的 main、preload 和 renderer 三个生产构建全部成功。

- [ ] **Step 4: 核对范围和提交状态**

Run:

```powershell
git status --short
git show --stat --oneline HEAD
```

Expected: 工作树干净；最新功能提交只修改 `NoteSidebar.tsx`、`app.css` 和 `main-layout.test.tsx`。如果格式工具产生修改，先检查差异，再追加一个仅含格式修复的提交，不要改写已验证的提交。

- [ ] **Step 5: 报告可复核证据**

最终交付说明应列出：默认值行为、两处提示、严格 IPC/服务校验未修改、聚焦测试与全量测试结果、类型检查结果、构建结果，以及功能提交 SHA。只有实际运行并观察到的结果才能表述为通过。
