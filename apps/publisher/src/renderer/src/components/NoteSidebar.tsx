import { useEffect, useMemo, useRef, useState } from "react"
import { FilePlus2, Search, X } from "lucide-react"
import type {
  DomainSummary,
  NoteCreateRequest,
  NoteSummary,
  Visibility,
} from "../../../shared/contracts"
import { ModalShell } from "./ModalShell"

type DomainFilter = NoteSummary["domain"] | null
type VisibilityFilter = Visibility | "all"

const visibilityFilters: readonly { value: VisibilityFilter; label: string }[] = [
  { value: "all", label: "全部可见性" },
  { value: "public", label: "公开" },
  { value: "private", label: "私密" },
]

interface NoteSidebarProps {
  readonly notes: readonly NoteSummary[]
  readonly domains: readonly DomainSummary[]
  readonly loadState: "loading" | "ready" | "error"
  readonly message: string
  readonly selectedPath?: string
  readonly onSelect: (path: string) => void
  readonly onCreate: (request: NoteCreateRequest) => Promise<string | undefined>
  readonly onRetry: () => void
  readonly focusTarget?: React.RefObject<HTMLButtonElement | null>
  readonly separator?: React.ReactNode
}

export function shanghaiCalendarDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

function NewNoteDialog({
  onClose,
  onCreate,
  domains,
}: {
  readonly onClose: () => void
  readonly onCreate: NoteSidebarProps["onCreate"]
  readonly domains: readonly DomainSummary[]
}): React.JSX.Element {
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("new-note")
  const [description, setDescription] = useState("")
  const [tags, setTags] = useState("")
  const [domain, setDomain] = useState<NoteSummary["domain"]>(domains[0]?.slug ?? "")
  const [visibility, setVisibility] = useState<Visibility>("public")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const titleInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setDomain((current) =>
      domains.some((candidate) => candidate.slug === current) ? current : (domains[0]?.slug ?? ""),
    )
  }, [domains])

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    if (!title.trim() || !slug.trim()) return
    setBusy(true)
    setError("")
    let result: string | undefined
    try {
      result = await onCreate({
        title: title.trim(),
        slug: slug.trim(),
        domain,
        visibility,
        date: shanghaiCalendarDate(),
        description: description.trim(),
        tags: tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        body: `# ${title.trim()}\n`,
      })
    } catch (caught) {
      if (!mounted.current) return
      setBusy(false)
      setError(caught instanceof Error ? caught.message : "无法创建笔记，请稍后重试。")
      return
    }
    if (!mounted.current) return
    setBusy(false)
    if (result) setError(result)
    else onClose()
  }

  return (
    <ModalShell
      labelId="new-note-title"
      className="new-note-dialog"
      initialFocus={titleInput}
      closeDisabled={busy}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <header>
        <h2 id="new-note-title">新建笔记</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
          disabled={busy}
        >
          <X size={18} />
        </button>
      </header>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          标题
          <input
            ref={titleInput}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </label>
        <label>
          文件名
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            required
            pattern="[a-z0-9][a-z0-9-]*"
          />
        </label>
        <label>
          描述
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            required
          />
        </label>
        <label>
          标签
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="用逗号分隔"
            required
          />
        </label>
        <label>
          领域
          <select
            value={domain}
            onChange={(event) => setDomain(event.target.value as NoteSummary["domain"])}
          >
            {domains.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>可见性</legend>
          <label>
            <input
              type="radio"
              name="visibility"
              value="public"
              checked={visibility === "public"}
              onChange={() => setVisibility("public")}
            />
            公开
          </label>
          <label>
            <input
              type="radio"
              name="visibility"
              value="private"
              checked={visibility === "private"}
              onChange={() => setVisibility("private")}
            />
            私密
          </label>
        </fieldset>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={
              busy ||
              !title.trim() ||
              !slug.trim() ||
              !description.trim() ||
              !tags.trim() ||
              !domain
            }
          >
            创建
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

export function NoteSidebar(props: NoteSidebarProps): React.JSX.Element {
  const [domain, setDomain] = useState<DomainFilter>(null)
  const [visibility, setVisibility] = useState<VisibilityFilter>("all")
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const createButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (domain !== null && !props.domains.some((item) => item.slug === domain)) {
      setDomain(null)
    }
  }, [domain, props.domains])

  const closeCreate = (): void => {
    setCreating(false)
    queueMicrotask(() => createButton.current?.focus())
  }

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN")
    return props.notes.filter((note) => {
      if (domain !== null && note.domain !== domain) return false
      if (visibility !== "all" && note.visibility !== visibility) return false
      return (
        !needle ||
        [note.title, note.description, note.path, ...note.tags]
          .join(" ")
          .toLocaleLowerCase("zh-CN")
          .includes(needle)
      )
    })
  }, [domain, props.notes, query, visibility])

  return (
    <nav className="sidebar pane" aria-label="笔记">
      {props.separator}
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">资料库</span>
          <h2>笔记</h2>
        </div>
        <button
          ref={(node) => {
            createButton.current = node
            if (props.focusTarget) props.focusTarget.current = node
          }}
          className="new-note-button"
          type="button"
          onClick={() => setCreating(true)}
        >
          <FilePlus2 size={16} aria-hidden="true" />
          新建笔记
        </button>
      </div>
      {props.loadState === "error" ? (
        <div className="list-error" role="alert" aria-live="assertive">
          <span>{props.message || "无法读取笔记列表"}</span>
          <button type="button" onClick={props.onRetry}>
            重试
          </button>
        </div>
      ) : null}
      <label className="search-field">
        <span className="sr-only">搜索笔记</span>
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索笔记"
          placeholder="搜索标题、标签或路径"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <section className="filter-section" aria-labelledby="domain-filter-title">
        <h3 id="domain-filter-title">领域</h3>
        <div className="filter-list">
          {[
            { value: null, label: "全部领域" },
            ...props.domains.map((item) => ({ value: item.slug, label: item.name })),
          ].map((item) => (
            <button
              key={item.value === null ? "all-filter" : `domain-${item.value}`}
              type="button"
              className={domain === item.value ? "active" : ""}
              aria-pressed={domain === item.value}
              onClick={() => setDomain(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <section className="filter-section" aria-labelledby="visibility-filter-title">
        <h3 id="visibility-filter-title">可见性</h3>
        <div className="filter-list compact">
          {visibilityFilters.map((item) => (
            <button
              key={item.value}
              type="button"
              className={visibility === item.value ? "active" : ""}
              aria-pressed={visibility === item.value}
              onClick={() => setVisibility(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <div className="note-list-heading">
        <span>笔记列表</span>
        <span>{filteredNotes.length}</span>
      </div>
      <ul className="note-list" aria-label="笔记列表">
        {filteredNotes.map((note) => (
          <li key={note.path}>
            <button
              type="button"
              className={`note-row ${props.selectedPath === note.path ? "selected" : ""}`}
              aria-current={props.selectedPath === note.path ? "page" : undefined}
              aria-label={`${note.title}，${note.visibility === "public" ? "公开" : "私密"}`}
              onClick={() => props.onSelect(note.path)}
            >
              <span className={`note-dot ${note.visibility}`} aria-hidden="true" />
              <span className="note-copy">
                <strong>{note.title}</strong>
                <small>
                  {(props.domains.find((item) => item.slug === note.domain)?.name ?? note.domain) +
                    " · " +
                    note.updatedAt.slice(0, 10)}
                </small>
              </span>
            </button>
          </li>
        ))}
        {props.loadState === "loading" ? <li className="list-message">正在读取笔记…</li> : null}
        {props.loadState === "ready" && filteredNotes.length === 0 ? (
          <li className="list-message">{props.message || "没有符合筛选条件的笔记"}</li>
        ) : null}
      </ul>
      {creating ? (
        <NewNoteDialog onClose={closeCreate} onCreate={props.onCreate} domains={props.domains} />
      ) : null}
    </nav>
  )
}
