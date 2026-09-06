import { useState, useRef, useCallback, useEffect } from "react";

// ── Design tokens matching the HSC dashboard ─────────────────────────────
const T = {
  bg:          "#080808",
  surface:     "#111111",
  surface2:    "#181818",
  surface3:    "#1e1e1e",
  border:      "rgba(255,0,255,0.18)",
  borderHover: "rgba(255,0,255,0.45)",
  magenta:     "#FF00FF",
  magentaDim:  "#cc00cc",
  magentaFaint:"rgba(255,0,255,0.07)",
  magentaGlow: "rgba(255,0,255,0.35)",
  text:        "#e0e0e0",
  muted:       "#777",
  danger:      "#c0392b",
  dangerHover: "#e74c3c",
  green:       "#00ff64",
};

const css = (obj) => Object.entries(obj).map(([k,v])=>`${k.replace(/([A-Z])/g,m=>'-'+m.toLowerCase())}:${v}`).join(';');

// ── Component types ───────────────────────────────────────────────────────
const TYPES = {
  text:  { label: "Text",  icon: "✏️" },
  image: { label: "Image", icon: "🖼️" },
};

let _id = 0;
const uid = () => `c${++_id}`;

function makeComp(type) {
  if (type === "text")  return { id: uid(), type: "text",  content: "" };
  if (type === "image") return { id: uid(), type: "image", url: "", alt: "" };
}

// ── Styles ────────────────────────────────────────────────────────────────
const S = {
  root: {
    minHeight: "100vh",
    background: T.bg,
    color: T.text,
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    fontSize: "14px",
    display: "flex",
    flexDirection: "column",
  },
  topbar: {
    background: T.surface,
    borderBottom: `1px solid ${T.border}`,
    padding: "0.65rem 1.25rem",
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  logo: {
    fontFamily: "'Bebas Neue', 'Arial Black', sans-serif",
    fontSize: "1.15rem",
    letterSpacing: "0.1em",
    color: T.magenta,
    textShadow: `0 0 12px ${T.magentaGlow}`,
    marginRight: "auto",
  },
  body: {
    display: "flex",
    flex: 1,
    gap: 0,
    minHeight: 0,
  },
  canvas: {
    flex: 1,
    padding: "1.5rem",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  sidebar: {
    width: "300px",
    flexShrink: 0,
    background: T.surface,
    borderLeft: `1px solid ${T.border}`,
    padding: "1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    overflowY: "auto",
  },
  sideTitle: {
    fontSize: "0.65rem",
    fontWeight: 600,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: T.magenta,
    marginBottom: "0.5rem",
  },
  addRow: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  addBtn: (type) => ({
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    padding: "0.45rem 0.9rem",
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: "4px",
    color: T.text,
    fontSize: "0.82rem",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "border-color 0.15s, color 0.15s",
  }),
  btn: (variant = "ghost") => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.4rem 1rem",
    borderRadius: "4px",
    fontWeight: 600,
    fontSize: "0.8rem",
    cursor: "pointer",
    border: "none",
    fontFamily: "inherit",
    background: variant === "primary" ? T.magenta
              : variant === "danger"  ? T.danger
              : "transparent",
    color:      variant === "primary" ? "#000"
              : variant === "danger"  ? "#fff"
              : T.text,
    borderWidth: variant === "ghost" ? 1 : 0,
    borderStyle: "solid",
    borderColor: T.border,
    boxShadow:   variant === "primary" ? `0 0 14px ${T.magentaGlow}` : "none",
  }),
  compWrap: (dragging, dragOver) => ({
    background: T.surface2,
    border: `1px solid ${dragOver ? T.magenta : dragging ? T.magentaDim : T.border}`,
    borderRadius: "6px",
    transition: "border-color 0.15s, transform 0.1s",
    transform: dragging ? "scale(1.01)" : "scale(1)",
    opacity: dragging ? 0.8 : 1,
  }),
  compHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.55rem 0.85rem",
    borderBottom: `1px solid ${T.border}`,
    cursor: "grab",
    userSelect: "none",
  },
  dragHandle: {
    color: T.muted,
    fontSize: "1rem",
    cursor: "grab",
    flexShrink: 0,
  },
  compBody: {
    padding: "0.85rem",
  },
  input: {
    width: "100%",
    background: T.surface,
    border: `1px solid ${T.border}`,
    color: T.text,
    padding: "0.45rem 0.65rem",
    borderRadius: "4px",
    fontSize: "0.87rem",
    fontFamily: "inherit",
    boxSizing: "border-box",
    outline: "none",
    resize: "vertical",
  },
  label: {
    display: "block",
    fontSize: "0.73rem",
    color: T.muted,
    marginBottom: "0.3rem",
    letterSpacing: "0.03em",
  },
  charCount: (over) => ({
    fontSize: "0.7rem",
    color: over ? T.danger : T.muted,
    textAlign: "right",
    marginTop: "0.2rem",
  }),
  preview: {
    background: "#36393f",
    borderRadius: "8px",
    padding: "1rem 1.25rem",
    border: `1px solid rgba(255,255,255,0.06)`,
  },
  previewText: {
    color: "#dcddde",
    fontSize: "0.92rem",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  previewImg: {
    maxWidth: "100%",
    borderRadius: "4px",
    marginTop: "0.5rem",
    display: "block",
  },
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: T.muted,
    gap: "0.75rem",
    padding: "3rem",
    textAlign: "center",
    border: `2px dashed ${T.border}`,
    borderRadius: "8px",
    minHeight: "220px",
  },
  copyBox: {
    background: T.surface2,
    border: `1px solid ${T.border}`,
    borderRadius: "4px",
    padding: "0.65rem 0.85rem",
    fontSize: "0.78rem",
    fontFamily: "monospace",
    color: T.text,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: "180px",
    overflowY: "auto",
  },
  flash: (ok) => ({
    padding: "0.55rem 0.9rem",
    borderRadius: "4px",
    fontSize: "0.82rem",
    background: ok ? "rgba(0,255,100,0.08)" : "rgba(255,0,0,0.08)",
    border: `1px solid ${ok ? "rgba(0,255,100,0.3)" : "rgba(255,0,0,0.3)"}`,
    color: ok ? T.green : "#ff6464",
  }),
};

// ── Text Component ────────────────────────────────────────────────────────
function TextComp({ comp, onChange }) {
  const MAX = 4000;
  const len = comp.content.length;
  return (
    <div style={S.compBody}>
      <label style={S.label}>Message content</label>
      <textarea
        rows={4}
        maxLength={MAX}
        value={comp.content}
        onChange={e => onChange({ ...comp, content: e.target.value })}
        placeholder="Content of the text component."
        style={{ ...S.input, minHeight: "90px" }}
      />
      <div style={S.charCount(len > MAX * 0.95)}>{len}/{MAX}</div>
    </div>
  );
}

// ── Image Component ───────────────────────────────────────────────────────
function ImageComp({ comp, onChange }) {
  const [err, setErr] = useState(false);
  return (
    <div style={S.compBody}>
      <label style={S.label}>Image URL</label>
      <input
        type="text"
        value={comp.url}
        onChange={e => { setErr(false); onChange({ ...comp, url: e.target.value }); }}
        placeholder="https://example.com/image.png"
        style={S.input}
      />
      {comp.url && (
        <div style={{ marginTop: "0.65rem", background: T.surface, borderRadius: "6px", overflow: "hidden", border: `1px solid ${T.border}` }}>
          {err ? (
            <div style={{ padding: "1.5rem", textAlign: "center", color: T.muted, fontSize: "0.8rem" }}>
              🖼️ Image failed to load — check the URL
            </div>
          ) : (
            <img
              src={comp.url}
              alt={comp.alt || "preview"}
              onError={() => setErr(true)}
              style={{ display: "block", maxWidth: "100%", maxHeight: "220px", objectFit: "contain", margin: "0 auto" }}
            />
          )}
        </div>
      )}
      {!comp.url && (
        <div style={{ marginTop: "0.65rem", background: T.surface, borderRadius: "6px", padding: "2rem", textAlign: "center", color: T.muted, border: `1px solid ${T.border}` }}>
          🖼️ Add Media
        </div>
      )}
    </div>
  );
}

// ── Single draggable component card ──────────────────────────────────────
function CompCard({ comp, index, total, onChange, onRemove, onMove, onDuplicate }) {
  const [dragging, setDragging] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragRef = useRef(null);

  return (
    <div
      ref={dragRef}
      style={S.compWrap(dragging, dragOver)}
      draggable
      onDragStart={e => { setDragging(true); e.dataTransfer.setData("text/plain", String(index)); }}
      onDragEnd={() => { setDragging(false); setDragOver(false); }}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false);
        const from = parseInt(e.dataTransfer.getData("text/plain"));
        if (!isNaN(from) && from !== index) onMove(from, index);
      }}
    >
      {/* header */}
      <div style={S.compHeader}>
        <span style={S.dragHandle} title="Drag to reorder">⠿</span>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: T.magenta, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {TYPES[comp.type]?.icon} {TYPES[comp.type]?.label}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "0.35rem" }}>
          <button
            style={{ ...S.btn("ghost"), padding: "0.2rem 0.5rem", fontSize: "0.72rem" }}
            title="Move up"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >▲</button>
          <button
            style={{ ...S.btn("ghost"), padding: "0.2rem 0.5rem", fontSize: "0.72rem" }}
            title="Move down"
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
          >▼</button>
          <button
            style={{ ...S.btn("ghost"), padding: "0.2rem 0.5rem", fontSize: "0.72rem" }}
            title="Duplicate"
            onClick={() => onDuplicate(index)}
          >⧉</button>
          <button
            style={{ ...S.btn("danger"), padding: "0.2rem 0.5rem", fontSize: "0.72rem" }}
            title="Remove component"
            onClick={() => onRemove(index)}
          >🗑</button>
        </span>
      </div>

      {/* body */}
      {comp.type === "text"  && <TextComp  comp={comp} onChange={onChange} />}
      {comp.type === "image" && <ImageComp comp={comp} onChange={onChange} />}
    </div>
  );
}

// ── Discord preview ───────────────────────────────────────────────────────
function DiscordPreview({ components }) {
  if (!components.length) return (
    <div style={{ ...S.preview, color: T.muted, fontSize: "0.85rem", textAlign: "center" }}>No components yet</div>
  );
  return (
    <div style={S.preview}>
      {components.map((c, i) => (
        <div key={c.id} style={{ marginBottom: i < components.length - 1 ? "0.75rem" : 0 }}>
          {c.type === "text" && (
            <div style={S.previewText}>{c.content || <span style={{ color: "#4f545c", fontStyle: "italic" }}>Empty text component</span>}</div>
          )}
          {c.type === "image" && c.url && (
            <img src={c.url} alt={c.alt || ""} style={S.previewImg} onError={e => { e.target.style.display="none"; }} />
          )}
          {c.type === "image" && !c.url && (
            <div style={{ color: "#4f545c", fontSize: "0.82rem", fontStyle: "italic" }}>🖼️ Image placeholder</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Output builder ────────────────────────────────────────────────────────
function buildOutput(components) {
  const parts = components.map(c => {
    if (c.type === "text")  return c.content;
    if (c.type === "image") return c.url || "";
    return "";
  }).filter(Boolean);
  return parts.join("\n\n");
}

// ── Main editor ───────────────────────────────────────────────────────────
export default function ComponentEditor() {
  const [components, setComponents] = useState([]);
  const [preview, setPreview]       = useState(false);
  const [flash, setFlash]           = useState(null); // {msg, ok}
  const [copied, setCopied]         = useState(false);

  const showFlash = (msg, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3000);
  };

  const addComp = (type) => setComponents(c => [...c, makeComp(type)]);

  const updateComp = useCallback((updated) => {
    setComponents(c => c.map(x => x.id === updated.id ? updated : x));
  }, []);

  const removeComp = (idx) => setComponents(c => c.filter((_, i) => i !== idx));

  const duplicateComp = (idx) => {
    setComponents(c => {
      const clone = { ...c[idx], id: uid() };
      const next = [...c];
      next.splice(idx + 1, 0, clone);
      return next;
    });
  };

  const moveComp = (from, to) => {
    setComponents(c => {
      const next = [...c];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const clearAll = () => {
    if (components.length === 0) return;
    setComponents([]);
    showFlash("Cleared all components.");
  };

  const copyOutput = () => {
    const out = buildOutput(components);
    if (!out) { showFlash("Nothing to copy — add some components first.", false); return; }
    navigator.clipboard.writeText(out).then(() => {
      setCopied(true);
      showFlash("Copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => showFlash("Copy failed — try manually.", false));
  };

  const output = buildOutput(components);

  return (
    <div style={S.root}>
      {/* Topbar */}
      <div style={S.topbar}>
        <span style={S.logo}>HSC — Component Editor</span>
        <button
          style={{ ...S.btn(preview ? "primary" : "ghost"), fontSize: "0.8rem" }}
          onClick={() => setPreview(p => !p)}
        >
          {preview ? "✏️ Edit" : "👁 Preview"}
        </button>
        <button
          style={{ ...S.btn("ghost"), fontSize: "0.8rem" }}
          onClick={clearAll}
        >
          🗑 Clear all
        </button>
      </div>

      {/* Flash */}
      {flash && (
        <div style={{ padding: "0.5rem 1.25rem" }}>
          <div style={S.flash(flash.ok)}>{flash.msg}</div>
        </div>
      )}

      {/* Body */}
      <div style={S.body}>

        {/* Canvas / Preview */}
        <div style={S.canvas}>
          {preview ? (
            <div>
              <div style={{ ...S.sideTitle, marginBottom: "0.75rem" }}>Discord Preview</div>
              <DiscordPreview components={components} />
            </div>
          ) : (
            <>
              {components.length === 0 ? (
                <div style={S.emptyState}>
                  <div style={{ fontSize: "2rem" }}>📭</div>
                  <div style={{ fontWeight: 600, color: T.text }}>No components yet</div>
                  <div style={{ fontSize: "0.82rem" }}>Use the panel on the right to add text or image components.<br/>Drag the ⠿ handle to reorder them.</div>
                </div>
              ) : (
                components.map((c, i) => (
                  <CompCard
                    key={c.id}
                    comp={c}
                    index={i}
                    total={components.length}
                    onChange={updateComp}
                    onRemove={removeComp}
                    onDuplicate={duplicateComp}
                    onMove={moveComp}
                  />
                ))
              )}
            </>
          )}
        </div>

        {/* Sidebar */}
        <div style={S.sidebar}>

          {/* Add components */}
          <div>
            <div style={S.sideTitle}>Add Component</div>
            <div style={S.addRow}>
              {Object.entries(TYPES).map(([type, { label, icon }]) => (
                <button
                  key={type}
                  style={S.addBtn(type)}
                  onClick={() => addComp(type)}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.magenta; e.currentTarget.style.color = T.magenta; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.text; }}
                >
                  {icon} {label}
                </button>
              ))}
            </div>
          </div>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: 0 }} />

          {/* Component list (mini overview) */}
          <div>
            <div style={S.sideTitle}>Order ({components.length})</div>
            {components.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "0.8rem" }}>No components</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {components.map((c, i) => (
                  <div key={c.id} style={{
                    display: "flex", alignItems: "center", gap: "0.5rem",
                    padding: "0.3rem 0.6rem", background: T.surface2,
                    borderRadius: "4px", border: `1px solid ${T.border}`,
                    fontSize: "0.78rem",
                  }}>
                    <span style={{ color: T.muted, minWidth: "18px" }}>{i + 1}</span>
                    <span>{TYPES[c.type]?.icon}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: T.muted }}>
                      {c.type === "text" ? (c.content || "—") : (c.url || "No URL")}
                    </span>
                    <button
                      style={{ background: "none", border: "none", color: T.danger, cursor: "pointer", fontSize: "0.75rem", padding: 0 }}
                      onClick={() => removeComp(i)}
                      title="Remove"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: 0 }} />

          {/* Discord preview (mini) */}
          <div>
            <div style={S.sideTitle}>Discord Preview</div>
            <DiscordPreview components={components} />
          </div>

          <hr style={{ border: "none", borderTop: `1px solid ${T.border}`, margin: 0 }} />

          {/* Output */}
          <div>
            <div style={S.sideTitle}>Output</div>
            {output ? (
              <>
                <div style={S.copyBox}>{output}</div>
                <div style={{ marginTop: "0.6rem" }}>
                  <button style={S.btn("primary")} onClick={copyOutput}>
                    {copied ? "✅ Copied!" : "📋 Copy to clipboard"}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ color: T.muted, fontSize: "0.8rem" }}>Add components to see output.</div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
