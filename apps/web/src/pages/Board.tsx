import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  Milestone,
  Project,
  Ticket,
  TicketComment,
  TicketPriority,
  TicketStatus,
} from "@rakazo/contracts";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { useTicketPriorityLabels } from "../lib/ticket-priority";
import { useTicketStatusLabels } from "../lib/ticket-status";
import { useBoardRefresh } from "../lib/use-board-refresh";
import { errorText } from "../lib/user-error";
import { TicketDependencies } from "./TicketDependencies";
import { WindowChrome } from "./WindowChrome";

export function BoardPage() {
  const filterId = useId();
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 767px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 767px)");
    if (!media) return;
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const listView = narrow || location.pathname === "/app/tickets";
  const projectFilter = params.get("projectId");
  const milestoneFilter = params.get("milestoneId");
  const statusFilter = params.get("status");
  const filters = useCallback(
    () => ({
      ...(projectFilter !== null
        ? { projectId: projectFilter === "none" ? null : projectFilter }
        : {}),
      ...(milestoneFilter !== null
        ? { milestoneId: milestoneFilter === "none" ? null : milestoneFilter }
        : {}),
      ...(TICKET_STATUSES.includes(statusFilter as TicketStatus)
        ? { status: statusFilter as TicketStatus }
        : {}),
    }),
    [projectFilter, milestoneFilter, statusFilter],
  );
  const [selected, setSelected] = useState<Ticket | "new" | null>(null);
  const [savedRevision, setSavedRevision] = useState(0);
  const load = useCallback(
    async (spaceId: string | null) => {
      const options = { context: { spaceId } };
      const [result, bots, projects] = await Promise.all([
        rpc.tickets.list(filters(), options),
        rpc.bots.list(undefined, options),
        rpc.projects.list({ archived: false }, options),
      ]);
      const milestones =
        projectFilter && projectFilter !== "none"
          ? await rpc.milestones.list({ projectId: projectFilter, archived: false }, options)
          : [];
      return { tickets: result.tickets, bots, projects, milestones, savedRevision };
    },
    [filters, projectFilter, savedRevision],
  );
  const { data, error: loadError } = useBoardRefresh(load);
  const tickets = data?.tickets ?? [];
  const bots = data?.bots ?? [];
  const error = loadError ? errorText(loadError) : "";
  const reload = useCallback(async () => setSavedRevision((value) => value + 1), []);
  function changeFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "projectId") next.delete("milestoneId");
    setParams(next);
  }

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" render={<Link to="/app" />} aria-label={t`Back`}>
          <ChevronLeft />
        </Button>
        <h1 className="flex-1 font-medium">
          {listView ? <Trans>Tickets</Trans> : <Trans>Board</Trans>}
        </h1>
        <Button variant="outline" render={<Link to="/app/projects" />}>
          <Trans>Projects</Trans>
        </Button>
        {!narrow ? (
          <Button
            variant="outline"
            render={<Link to={`${listView ? "/app/board" : "/app/tickets"}${location.search}`} />}
          >
            {listView ? <Trans>Board</Trans> : <Trans>List</Trans>}
          </Button>
        ) : null}
        <Button onClick={() => setSelected("new")} disabled={bots.length === 0}>
          <Trans>New ticket</Trans>
        </Button>
      </header>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1 text-sm">
          <label htmlFor={`${filterId}-project`}>
            <Trans>Project</Trans>
          </label>
          <NativeSelect
            id={`${filterId}-project`}
            className="w-full"
            value={projectFilter ?? ""}
            onChange={(event) => changeFilter("projectId", event.target.value)}
          >
            <NativeSelectOption value="">{t`All`}</NativeSelectOption>
            <NativeSelectOption value="none">{t`Unassociated`}</NativeSelectOption>
            {data?.projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <label htmlFor={`${filterId}-milestone`}>
            <Trans>Milestone</Trans>
          </label>
          <NativeSelect
            id={`${filterId}-milestone`}
            className="w-full"
            value={milestoneFilter ?? ""}
            onChange={(event) => changeFilter("milestoneId", event.target.value)}
          >
            <NativeSelectOption value="">{t`All`}</NativeSelectOption>
            <NativeSelectOption value="none">{t`Unassociated`}</NativeSelectOption>
            {data?.milestones.map((milestone) => (
              <NativeSelectOption key={milestone.id} value={milestone.id}>
                {milestone.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="min-w-0 text-sm">
          <label htmlFor={`${filterId}-status`}>
            <Trans>Status</Trans>
          </label>
          <NativeSelect
            id={`${filterId}-status`}
            className="w-full"
            value={statusFilter ?? ""}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value) next.set("status", event.target.value);
              else next.delete("status");
              setParams(next);
            }}
          >
            <NativeSelectOption value="">{t`All`}</NativeSelectOption>
            {TICKET_STATUSES.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {statuses[status]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-auto p-4">
        {listView ? (
          <ul data-testid="ticket-list" className="min-w-0 space-y-2">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="min-w-0">
                <Button
                  variant="outline"
                  data-testid={`board-card-${ticket.id}`}
                  className="h-auto w-full min-w-0 flex-col items-start whitespace-normal break-words p-3 text-left"
                  onClick={() => setSelected(ticket)}
                >
                  <span className="text-xs text-muted-foreground">
                    {ticket.ref} · {statuses[ticket.status]}
                  </span>
                  <span className="max-w-full break-words">{ticket.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div data-testid="board-columns" className="flex min-h-full gap-3">
            {TICKET_STATUSES.map((status) => (
              <section key={status} className="min-w-40 flex-1 space-y-2">
                <h2 className="px-1 text-sm font-medium">{statuses[status]}</h2>
                {tickets
                  .filter((ticket) => ticket.status === status)
                  .map((ticket) => (
                    <Button
                      key={ticket.id}
                      data-testid={`board-card-${ticket.id}`}
                      variant="outline"
                      className="h-auto w-full flex-col items-start gap-1 whitespace-normal p-3 text-left font-normal"
                      onClick={() => setSelected(ticket)}
                    >
                      <span className="text-xs text-muted-foreground">{ticket.ref}</span>
                      <span>{ticket.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {bots.find((bot) => bot.id === ticket.assigneeBotId)?.name}
                      </span>
                    </Button>
                  ))}
              </section>
            ))}
          </div>
        )}
        {tickets.length === 0 && !error ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            <Trans>No tickets yet</Trans>
          </p>
        ) : null}
      </main>
      {selected ? (
        <TicketDialog
          key={selected === "new" ? "new" : selected.id}
          ticket={selected === "new" ? null : selected}
          bots={bots}
          projects={data?.projects ?? []}
          commentRevision={data}
          onClose={() => setSelected(null)}
          onSaved={reload}
        />
      ) : null}
    </div>
  );
}

function TicketDialog({
  ticket,
  bots,
  onClose,
  onSaved,
  commentRevision,
  projects,
}: {
  projects: Project[];
  commentRevision?: unknown;
  ticket: Ticket | null;
  bots: Bot[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const formId = useId();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [owner, setOwner] = useState(ticket?.assigneeBotId ?? bots[0]?.id ?? "");
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "todo");
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? "normal");
  const [projectId, setProjectId] = useState(ticket?.projectId ?? "");
  const [milestoneId, setMilestoneId] = useState(ticket?.milestoneId ?? "");
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  useEffect(() => {
    let active = true;
    setMilestones([]);
    if (projectId && projects.some((project) => project.id === projectId && !project.archived)) {
      void rpc.milestones
        .list({ projectId, archived: false })
        .then((rows) => {
          if (active) setMilestones(rows.filter((row) => !row.archived));
        })
        .catch((cause) => {
          if (active) setError(errorText(cause));
        });
    }
    return () => {
      active = false;
    };
  }, [projectId, projects]);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ticket) return;
    let active = true;
    void rpc.tickets
      .comments({ ticketId: ticket.id })
      .then((rows) => {
        if (active) setComments(rows);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [ticket, commentRevision]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (ticket)
        await rpc.tickets.update({
          id: ticket.id,
          ...(title !== ticket.title ? { title } : {}),
          ...(description !== (ticket.description ?? "") ? { description } : {}),
          ...(owner !== (ticket.assigneeBotId ?? bots[0]?.id ?? "")
            ? { assigneeBotId: owner }
            : {}),
          ...(status !== ticket.status ? { status } : {}),
          ...(priority !== ticket.priority ? { priority } : {}),
          ...(projectId !== (ticket.projectId ?? "")
            ? { projectId: projectId || null, milestoneId: milestoneId || null }
            : milestoneId !== (ticket.milestoneId ?? "")
              ? { milestoneId: milestoneId || null }
              : {}),
        });
      else
        await rpc.tickets.create({
          title,
          description,
          assigneeBotId: owner,
          priority,
          ...(projectId ? { projectId } : {}),
          ...(milestoneId ? { milestoneId } : {}),
        });
      await onSaved();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function comment() {
    if (!ticket) return;
    setBusy(true);
    setError("");
    try {
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body });
      setComments((previous) => [...previous, row]);
      setBody("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ticket?.title ?? t`New ticket`}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={`${formId}-title`} className="block space-y-1 text-sm">
            <span>
              <Trans>Title</Trans>
            </span>
            <Input
              id={`${formId}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={TICKET_TITLE_MAX_LENGTH}
              required
            />
          </label>
          <label htmlFor={`${formId}-description`} className="block space-y-1 text-sm">
            <span>
              <Trans>Description</Trans>
            </span>
            <Textarea
              id={`${formId}-description`}
              data-testid="ticket-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
            />
          </label>
          <label htmlFor={`${formId}-owner`} className="block space-y-1 text-sm">
            <span>
              <Trans>Owner</Trans>
            </span>
            <NativeSelect
              className="w-full"
              id={`${formId}-owner`}
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              required
            >
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {ticket ? (
            <label htmlFor={`${formId}-status`} className="block space-y-1 text-sm">
              <span>
                <Trans>Status</Trans>
              </span>
              <NativeSelect
                className="w-full"
                id={`${formId}-status`}
                value={status}
                onChange={(event) => setStatus(event.target.value as TicketStatus)}
              >
                {TICKET_STATUSES.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {statuses[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <div className="block space-y-1 text-sm">
            <label htmlFor={`${formId}-project`}>
              <span>
                <Trans>Project</Trans>
              </span>
            </label>
            <NativeSelect
              id={`${formId}-project`}
              className="w-full"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setMilestoneId("");
              }}
            >
              <NativeSelectOption value="">{t`Unassociated`}</NativeSelectOption>
              {projects
                .filter((project) => !project.archived)
                .map((project) => (
                  <NativeSelectOption key={project.id} value={project.id}>
                    {project.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
          <div className="block space-y-1 text-sm">
            <label htmlFor={`${formId}-milestone`}>
              <span>
                <Trans>Milestone</Trans>
              </span>
            </label>
            <NativeSelect
              id={`${formId}-milestone`}
              className="w-full"
              value={milestoneId}
              onChange={(event) => setMilestoneId(event.target.value)}
            >
              <NativeSelectOption value="">{t`Unassociated`}</NativeSelectOption>
              {milestones.map((milestone) => (
                <NativeSelectOption key={milestone.id} value={milestone.id}>
                  {milestone.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <label htmlFor={`${formId}-priority`} className="block space-y-1 text-sm">
            <span>
              <Trans>Priority</Trans>
            </span>
            <NativeSelect
              className="w-full"
              id={`${formId}-priority`}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
            >
              {TICKET_PRIORITIES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {priorities[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !title.trim() || !owner}>
              {ticket ? t`Save` : t`Create`}
            </Button>
          </div>
        </form>
        {ticket ? <TicketDependencies ticketId={ticket.id} revision={commentRevision} onSaved={onSaved} /> : null}
        {ticket ? (
          <div data-testid="ticket-comments" className="space-y-3 border-t pt-3">
            {comments.map((row) => (
              <div key={row.id} className="text-sm">
                <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{row.authorName}</span>
                  <time dateTime={row.createdAt}>{formatRelativeTime(row.createdAt)}</time>
                </div>
                <ChatMarkdown>{row.body}</ChatMarkdown>
              </div>
            ))}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void comment();
              }}
            >
              <Textarea
                aria-label={t`Comment`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={TICKET_COMMENT_MAX_LENGTH}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !body.trim()}>
                  <Trans>Comment</Trans>
                </Button>
              </div>
            </form>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
