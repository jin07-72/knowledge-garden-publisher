export function App(): React.JSX.Element {
  return (
    <main>
      <header>
        <p>~/Knowledge Garden</p>
      </header>

      <div>
        <nav aria-label="笔记">
          <h1>笔记</h1>
        </nav>

        <section aria-label="Markdown 编辑器" role="region">
          <h2>Markdown 编辑器</h2>
        </section>

        <section aria-label="本地预览" role="region">
          <h2>本地预览</h2>
        </section>
      </div>
    </main>
  )
}
