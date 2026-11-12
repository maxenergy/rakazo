import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

type Entry = { name: string; type: "directory" | "file"; size: number };
type Commit = { sha: string; authoredAt: string; author: string; subject: string };

export function ProjectFiles({ projectId }: { projectId: string }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"files" | "commits">("files");
  const spaceId = selectedSpaceId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      rpc.projects.directory({ projectId, path }, { context: { spaceId } }),
      rpc.projects.commits({ projectId }, { context: { spaceId } }),
    ])
      .then(([treeResult, historyResult]) => {
        if (cancelled) return;
        if (treeResult.status === "rejected") {
          setError(errorMessage(treeResult.reason));
          return;
        }
        setEntries(treeResult.value);
        setCommits(historyResult.status === "fulfilled" ? historyResult.value : []);
        setSelected(null);
        setText(null);
        setImageUrl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, spaceId]);

  async function openFile(entry: Entry) {
    const next = path ? `${path}/${entry.name}` : entry.name;
    if (entry.type === "directory") {
      setPath(next);
      return;
    }
    setSelected(next);
    setText(null);
    setImageUrl(null);
    setError(null);
    try {
      if (/\.(png|jpe?g|gif|webp)$/i.test(next)) {
        const result = await rpc.projects.fileImage(
          { projectId, path: next },
          { context: { spaceId } },
        );
        setImageUrl(`data:${result.mime};base64,${result.dataBase64}`);
      } else {
        const result = await rpc.projects.file({ projectId, path: next }, { context: { spaceId } });
        setText(result.text);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <section className="space-y-3" aria-label="Project files">
      <div className="flex gap-2" role="tablist" aria-label="Project content">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => setTab("files")}
        >
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "commits"}
          onClick={() => setTab("commits")}
        >
          Recent commits
        </button>
      </div>
      {tab === "files" ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(12rem,1fr)_2fr]">
          <nav aria-label="Directory tree" className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                disabled={!path}
                onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
              >
                Up
              </button>
              <span>{path || "/"}</span>
            </div>
            {loading ? <p role="status">Loading files…</p> : null}
            {entries.length === 0 && !loading && !error ? <p>No files in this directory.</p> : null}
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="max-w-full break-all text-left underline"
                    onClick={() => void openFile(entry)}
                  >
                    {entry.type === "directory" ? "▸ " : ""}
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 overflow-auto rounded-md border p-3">
            {selected ? <h3 className="mb-2 font-medium">{selected}</h3> : null}
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={selected ?? "Project image"}
                className="max-h-[32rem] max-w-full object-contain"
              />
            ) : null}
            {selected && text !== null ? (
              selected.toLowerCase().endsWith(".md") ? (
                <article className="prose prose-sm max-w-none">
                  <ChatMarkdown>{text}</ChatMarkdown>
                </article>
              ) : selected.toLowerCase().endsWith(".html") ? (
                <div className="h-[32rem]">
                  <SandboxedHtmlViewer title={selected} html={text} />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-sm">{text}</pre>
              )
            ) : null}
            {!selected ? <p>Select a file to preview it.</p> : null}
          </div>
        </div>
      ) : (
        <div>
          {commits.length ? (
            <ol className="space-y-2">
              {commits.map((commit) => (
                <li key={commit.sha} className="rounded-md border p-3">
                  <p className="break-words">{commit.subject}</p>
                  <p className="text-sm text-muted-foreground">
                    {commit.sha.slice(0, 8)} · {commit.author} ·{" "}
                    {new Date(commit.authoredAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p>This directory has no Git history.</p>
          )}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function errorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/too large|exceed|limit/i.test(message)) return "This item exceeds the preview limit.";
  if (/not found|forbidden|denied|unauthorized/i.test(message))
    return "This item is unavailable or access was denied.";
  return message || "Could not load this item.";
}
