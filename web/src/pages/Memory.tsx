import { useEffect, useState } from 'react';
import { Brain, Check, MessagesSquare, Pencil, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { Badge, Button, Card, Empty, ErrorNote, Loading, PageHeader, Tabs } from '../components/ui';
import { api, type Conversation, type Memory, type MemoryStats } from '../lib/api';
import { dateTime, KIND_LABEL, timeAgo } from '../lib/format';
import { useAction, useResource } from '../lib/live';

const KINDS = ['rule', 'preference', 'plan', 'schedule', 'idea', 'project', 'decision', 'procedure', 'fact', 'task_history', 'tool_doc'];
const EDITABLE_KINDS = ['rule', 'preference', 'plan', 'schedule', 'idea', 'project', 'decision', 'procedure', 'fact'];

function sourceLabel(m: Memory): string {
  if (m.source === 'user') return 'You told Jarvis';
  if (m.source === 'user (via conversation)') return 'You said it (as understood by Jarvis)';
  if (m.source === 'jarvis (inferred)') return 'Inferred by Jarvis';
  if (m.source === 'jarvis (digest)') return 'From a conversation digest';
  if (m.source === 'user (chat)') return 'You said it (your words)';
  if (m.source === 'system') return m.kind === 'tool_doc' ? 'Skill registry' : 'Recorded by Jarvis';
  return m.source;
}

function MemoryItem({ memory }: { memory: Memory }) {
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState(memory.kind);
  const readOnly = memory.kind === 'tool_doc';

  const save = async () => {
    const ok = await act(() => api.patch(`/api/memory/${memory.id}`, { content, kind }), 'Memory updated');
    if (ok) setEditing(false);
  };

  return (
    <li className={`memory ${memory.verified ? '' : 'memory--unverified'}`}>
      <div className="memory__top">
        <Badge tone="accent">{KIND_LABEL[memory.kind] ?? memory.kind}</Badge>
        {memory.verified ? (
          <Badge tone="success">verified</Badge>
        ) : (
          <Badge tone="warning" title="An assumption Jarvis made or heard indirectly. Confirm or correct it.">
            unverified
          </Badge>
        )}
        <span className="memory__conf" title="Confidence">
          {Math.round(memory.confidence * 100)}%
        </span>
        <div className="memory__actions">
          {!readOnly && !memory.verified && (
            <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} />} onClick={() => act(() => api.patch(`/api/memory/${memory.id}`, { verified: true }), 'Marked as verified')}>
              Confirm
            </Button>
          )}
          {!readOnly && !editing && <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(true)} aria-label="Edit" />}
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={14} />}
              aria-label="Delete"
              onClick={() => confirm('Delete this memory? Jarvis will forget it.') && act(() => api.del(`/api/memory/${memory.id}`), 'Forgotten')}
            />
          )}
        </div>
      </div>
      {editing ? (
        <div className="memory__edit">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} maxLength={4000} />
          <div className="memory__edit-row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {EDITABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => (setEditing(false), setContent(memory.content), setKind(memory.kind))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={save} disabled={!content.trim()}>
              Save
            </Button>
          </div>
          <p className="muted small">Saving a correction marks the memory as verified.</p>
        </div>
      ) : (
        <p className="memory__content">{memory.content}</p>
      )}
      <div className="memory__meta">
        <span>{sourceLabel(memory)}</span>
        {memory.sources.length > 1 && <span>· {memory.sources.length} sources</span>}
        {memory.mergedCount > 1 && <span>· merged ×{memory.mergedCount}</span>}
        <span>· updated {timeAgo(memory.updatedAt)}</span>
        {memory.accessCount > 0 && <span>· recalled {memory.accessCount}×</span>}
        {memory.sourceRef?.startsWith('task:') && <span>· {memory.sourceRef}</span>}
      </div>
    </li>
  );
}

function AddMemory({ onClose }: { onClose: () => void }) {
  const act = useAction();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('preference');
  return (
    <Card title="Add memory" icon={<Plus size={18} />}>
      <div className="form">
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} placeholder="Something Jarvis should always remember" autoFocus maxLength={4000} />
        <div className="form__actions">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {EDITABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!content.trim()} onClick={async () => (await act(() => api.post('/api/memory', { content, kind }), 'Remembered')) && onClose()}>
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Conversations() {
  const act = useAction();
  const { data } = useResource<{ conversations: Conversation[] }>('/api/conversations', ['conversation.updated']);
  const list = data?.conversations ?? [];
  return (
    <Card title="Conversations" icon={<MessagesSquare size={18} />}>
      <p className="muted small">Short-term context. Long conversations are summarised in the background; old ones are removed after the retention period set in Settings.</p>
      {list.length === 0 ? (
        <p className="muted">No conversations yet.</p>
      ) : (
        <ul className="conv-list">
          {list.map((c) => (
            <li key={c.id}>
              <div>
                <div className="conv-list__title">{c.title}</div>
                <div className="muted small">
                  {c.messageCount ?? 0} messages · {dateTime(c.updatedAt)}
                  {c.summary ? ' · summarised' : ''}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} aria-label="Delete conversation" onClick={() => confirm('Delete this conversation?') && act(() => api.del(`/api/conversations/${c.id}`), 'Conversation deleted')} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MemoryPage() {
  const [kind, setKind] = useState<string>('all');
  const [verified, setVerified] = useState<'all' | 'true' | 'false'>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const params = new URLSearchParams();
  if (debounced.trim()) params.set('q', debounced.trim());
  if (kind !== 'all') params.set('kind', kind);
  if (verified !== 'all') params.set('verified', verified);
  const { data, error } = useResource<{ memories: Memory[]; stats: MemoryStats }>(`/api/memory?${params}`, ['memory.changed']);
  const stats = data?.stats;

  return (
    <div className="page">
      <PageHeader
        title="Memory"
        subtitle={
          stats
            ? `${stats.total - (stats.byKind.tool_doc ?? 0)} memories · ${stats.unverified} unverified · ${stats.byKind.tool_doc ?? 0} tool docs${stats.embedded ? ` · ${stats.embedded} with semantic embeddings` : ''}`
            : 'Loading…'
        }
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            Add memory
          </Button>
        }
      />
      {adding && <AddMemory onClose={() => setAdding(false)} />}
      <div className="memory-layout">
        <Card pad={false}>
          <div className="card__toolbar card__toolbar--stack">
            <label className="search">
              <Search size={16} />
              <input
                value={query}
                placeholder="Search memories"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search memories"
              />
            </label>
            <Tabs
              value={kind}
              onChange={setKind}
              tabs={[{ id: 'all', label: 'All memories' }, ...KINDS.map((k) => ({ id: k, label: KIND_LABEL[k], count: k === 'tool_doc' ? undefined : stats?.byKind[k] }))]}
            />
            <Tabs
              value={verified}
              onChange={setVerified}
              tabs={[
                { id: 'all', label: 'Any status' },
                { id: 'true', label: 'Verified' },
                { id: 'false', label: 'Unverified', count: stats?.unverified },
              ]}
            />
          </div>
          {error && <ErrorNote message={error} />}
          {!data && !error && <Loading />}
          {data && data.memories.length === 0 && (
            <Empty icon={<Brain size={32} strokeWidth={1.5} />} title={debounced ? 'No matching memories' : 'No memories yet'}>
              Tell Jarvis “remember that …”, or add one here.
            </Empty>
          )}
          <ul className="memories">
            {(data?.memories ?? []).map((m) => (
              <MemoryItem key={`${m.id}-${m.updatedAt}`} memory={m} />
            ))}
          </ul>
        </Card>
        <Conversations />
      </div>
    </div>
  );
}
