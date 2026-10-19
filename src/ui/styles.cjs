"use strict";
/**
 * The panel stylesheet.
 *
 * Everything is expressed in DSH's own `--dsw-*` tokens with a fallback, which
 * buys two things at once:
 *
 *   - inside DSH the panel automatically follows the active theme (including a
 *     third-party theme from another plugin), so it never looks bolted on;
 *   - in the standalone preview the same file renders correctly against the
 *     fallbacks, with no second stylesheet to keep in sync.
 *
 * Every class is prefixed `lumen-`. The panel is injected into a settings
 * section the host owns, so an unprefixed `.row` or `.card` would be a
 * collision waiting to happen.
 */

const PANEL_CSS = `
.lumen-root{
  --lumen-text:var(--dsw-alias-label-primary,#e8e9ee);
  --lumen-text-2:var(--dsw-alias-label-secondary,#a6a9b8);
  --lumen-text-3:var(--dsw-alias-label-tertiary,#7c8093);
  --lumen-surface:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.045));
  --lumen-surface-2:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));
  --lumen-border:var(--dsw-alias-border-l1,rgba(255,255,255,.1));
  --lumen-border-2:var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  --lumen-accent:var(--dsw-alias-brand-primary,#6ea8fe);
  --lumen-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));
  /* Text and glyphs drawn ON an accent fill. The theme contract has no token
     for 'label on brand', so the value is stated once here rather than at the
     four call sites that need it — which is the only reason it is not a
     --dsw-* lookup. */
  --lumen-on-accent:#fff;
  /* The confirmation toast, which is the one surface that is deliberately
     opaque: it has to be readable over the wallpaper it is announcing. */
  --lumen-toast-bg:var(--dsw-alias-toast-bg,rgba(24,24,27,.92));
  --lumen-toast-text:var(--dsw-alias-toast-label,#fff);
  --lumen-toast-shadow:0 6px 24px rgba(0,0,0,.28);
  /* Depths and hairlines. Also untokenised, and also stated once. */
  --lumen-shadow:0 1px 3px rgba(0,0,0,.35);
  --lumen-shadow-soft:0 1px 3px rgba(0,0,0,.3);
  --lumen-hairline:inset 0 0 0 1px rgba(255,255,255,.03);
  --lumen-radius:10px;
  color:var(--lumen-text);
  font-size:13px;
  line-height:1.55;
  display:flex;
  flex-direction:column;
  gap:14px;
  padding:2px 0 12px;
}
.lumen-group{display:flex;align-items:baseline;gap:8px;margin-top:6px;}
.lumen-group:first-child{margin-top:0;}
.lumen-group-title{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--lumen-text-2);}
.lumen-group-hint{font-size:11.5px;color:var(--lumen-text-3);}
.lumen-card{
  border:1px solid var(--lumen-border);
  border-radius:var(--lumen-radius);
  background:var(--lumen-surface);
  padding:10px 12px;
  display:flex;
  flex-direction:column;
  gap:9px;
}
.lumen-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:26px;}
.lumen-row-label{display:flex;flex-direction:column;gap:1px;min-width:0;}
.lumen-row-title{font-size:12.5px;color:var(--lumen-text);}
.lumen-row-hint{font-size:11px;color:var(--lumen-text-3);}
.lumen-row-control{display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.lumen-row.is-stack{flex-direction:column;align-items:stretch;}
.lumen-row.is-stack .lumen-row-control{flex:1 1 auto;}
/* Drop target highlight. Drawn with an inset ring and a negative margin rather
   than a real border, so the row does not grow by 2px the moment a file is
   dragged over it — a highlight that reflows the thing it is highlighting
   reads as a glitch. */
.lumen-row.is-drop{
  background:var(--lumen-hover);
  border-radius:8px;
  box-shadow:inset 0 0 0 1px var(--lumen-accent);
  margin:0 -6px;
  padding:0 6px;
}

.lumen-hero{display:flex;gap:12px;align-items:stretch;}
.lumen-hero-preview{
  flex:0 0 148px;height:88px;border-radius:8px;border:1px solid var(--lumen-border-2);
  background-size:cover;background-position:center;overflow:hidden;position:relative;
}
.lumen-hero-meta{display:flex;flex-direction:column;justify-content:center;gap:5px;min-width:0;flex:1 1 auto;}
.lumen-hero-name{font-size:14px;font-weight:600;}
.lumen-hero-sub{font-size:11.5px;color:var(--lumen-text-3);}
.lumen-hero-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;}

.lumen-btn{
  font:inherit;font-size:12px;color:var(--lumen-text);
  background:var(--lumen-surface-2);border:1px solid var(--lumen-border);
  border-radius:8px;padding:5px 10px;cursor:pointer;
  transition:background .14s ease,border-color .14s ease,opacity .14s ease;
  white-space:nowrap;
}
.lumen-btn:hover{background:var(--lumen-hover);border-color:var(--lumen-border-2);}
.lumen-btn:disabled{opacity:.45;cursor:not-allowed;}
.lumen-btn.is-small{padding:3px 7px;font-size:11px;}
.lumen-btn-primary{background:var(--lumen-accent);border-color:transparent;color:var(--lumen-on-accent);}
.lumen-btn-primary:hover{background:var(--lumen-accent);opacity:.88;}
.lumen-btn-ghost{background:transparent;border-color:transparent;color:var(--lumen-text-2);}
.lumen-btn-ghost:hover{color:var(--lumen-text);background:var(--lumen-hover);}

.lumen-chips{display:flex;flex-wrap:wrap;gap:7px;}
.lumen-chip{
  position:relative;display:flex;flex-direction:column;gap:4px;align-items:center;
  background:transparent;border:1px solid transparent;border-radius:9px;padding:5px;
  cursor:pointer;font:inherit;color:var(--lumen-text-3);
  transition:border-color .14s ease,color .14s ease,background .14s ease;
}
.lumen-chip:hover{border-color:var(--lumen-border);color:var(--lumen-text-2);}
.lumen-chip.is-on{border-color:var(--lumen-accent);color:var(--lumen-text);background:var(--lumen-hover);}
.lumen-chip-label{font-size:10.5px;letter-spacing:.02em;}
.lumen-swatch{
  display:block;width:52px;height:34px;border-radius:6px;
  border:1px solid var(--lumen-border);
  box-shadow:var(--lumen-hairline);
}
.lumen-swatch.is-large{width:100%;height:100%;border-radius:0;border:none;box-shadow:none;}

.lumen-slider{display:flex;align-items:center;gap:9px;min-width:170px;}
.lumen-slider-input{
  -webkit-appearance:none;appearance:none;height:3px;border-radius:2px;
  background:var(--lumen-border-2);outline:none;flex:1 1 auto;min-width:96px;cursor:pointer;
}
.lumen-slider-input::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:13px;height:13px;border-radius:50%;
  background:var(--lumen-accent);border:none;cursor:pointer;
  box-shadow:var(--lumen-shadow);
}
.lumen-slider-input::-moz-range-thumb{
  width:13px;height:13px;border-radius:50%;background:var(--lumen-accent);border:none;cursor:pointer;
}
.lumen-slider-value{font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--lumen-text-2);min-width:52px;text-align:right;}

.lumen-segmented{display:inline-flex;border:1px solid var(--lumen-border);border-radius:8px;overflow:hidden;background:var(--lumen-surface);}
.lumen-seg{
  font:inherit;font-size:11.5px;color:var(--lumen-text-2);background:transparent;border:none;
  padding:5px 11px;cursor:pointer;transition:background .14s ease,color .14s ease;
}
.lumen-seg + .lumen-seg{border-left:1px solid var(--lumen-border);}
.lumen-seg:hover{background:var(--lumen-hover);color:var(--lumen-text);}
.lumen-seg.is-on{background:var(--lumen-accent);color:var(--lumen-on-accent);}

.lumen-toggle{position:relative;display:inline-flex;cursor:pointer;}
.lumen-toggle-input{position:absolute;opacity:0;width:0;height:0;}
.lumen-toggle-track{
  width:34px;height:19px;border-radius:10px;background:var(--lumen-border-2);
  display:inline-flex;align-items:center;padding:2px;transition:background .16s ease;
}
.lumen-toggle-knob{
  width:15px;height:15px;border-radius:50%;background:var(--lumen-on-accent);
  transform:translateX(0);transition:transform .16s ease;
  box-shadow:var(--lumen-shadow-soft);
}
.lumen-toggle-input:checked + .lumen-toggle-track{background:var(--lumen-accent);}
.lumen-toggle-input:checked + .lumen-toggle-track .lumen-toggle-knob{transform:translateX(15px);}
.lumen-toggle-input:focus-visible + .lumen-toggle-track{outline:2px solid var(--lumen-accent);outline-offset:2px;}

/* 3x3 position grid. Fixed 18px tracks instead of 1fr + aspect-ratio: the
   control is a fixed-size square by definition, and explicit tracks keep it
   from being stretched by the flex row it sits in. */
.lumen-grid9{
  display:grid;grid-template-columns:repeat(3,18px);grid-auto-rows:18px;gap:3px;
  padding:4px;border:1px solid var(--lumen-border);border-radius:9px;
  background:var(--lumen-surface);flex:0 0 auto;
}
.lumen-grid9-cell{
  padding:0;cursor:pointer;
  border:1px solid transparent;border-radius:5px;
  background:var(--lumen-surface-2);
  transition:background .14s ease,border-color .14s ease;
}
.lumen-grid9-cell:hover{background:var(--lumen-hover);border-color:var(--lumen-border-2);}
.lumen-grid9-cell:focus-visible{outline:2px solid var(--lumen-accent);outline-offset:1px;}
.lumen-grid9-cell.is-on{background:var(--lumen-accent);border-color:transparent;}
/* The selected cell carries a dot, so the state reads as "the subject is
   anchored here" rather than as a generic pressed button. */
.lumen-grid9-cell.is-on::after{
  content:"";display:block;width:6px;height:6px;border-radius:50%;
  margin:auto;background:var(--lumen-on-accent);
}

.lumen-list{display:flex;flex-direction:column;gap:5px;}
.lumen-list-item{
  display:flex;align-items:center;gap:9px;padding:5px 7px;border-radius:8px;
  border:1px solid var(--lumen-border);background:var(--lumen-surface);
}
.lumen-list-item.is-current{border-color:var(--lumen-accent);}
.lumen-list-index{font-size:10.5px;color:var(--lumen-text-3);font-variant-numeric:tabular-nums;min-width:16px;}
.lumen-list-name{flex:1 1 auto;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lumen-list-actions{display:flex;gap:3px;flex:0 0 auto;}
.lumen-list-item .lumen-swatch{width:44px;height:27px;flex:0 0 auto;}
.lumen-empty{font-size:12px;color:var(--lumen-text-3);padding:9px 2px;}

.lumen-upcoming{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.lumen-pill{
  font-size:11px;font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:999px;
  background:var(--lumen-surface-2);border:1px solid var(--lumen-border);color:var(--lumen-text-2);
}
.lumen-pill.is-next{background:var(--lumen-accent);color:var(--lumen-on-accent);border-color:transparent;}
.lumen-note{font-size:11px;color:var(--lumen-text-3);}
.lumen-note.is-warn{color:var(--dsw-alias-state-warn-primary,#e0a34a);}
/* The single message line. Sticky, because the panel is far taller than the
   settings viewport: a refusal reported at the top of the panel while the user
   is looking at the rotation switch is a refusal nobody reads. "top:0" resolves
   against whatever scrolls the section, so this works inside DSH and in the
   preview page without a second rule. */
.lumen-banner{
  position:sticky;top:0;z-index:6;
  padding:6px 9px;border:1px solid var(--lumen-border);border-radius:8px;
  background:var(--lumen-surface-2);
  box-shadow:var(--lumen-shadow-soft);
}
.lumen-empty-state{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.lumen-empty-state .lumen-empty{padding:7px 2px;}
/* The confirmation toast. Fixed to the viewport on purpose: the panel scrolls,
   and the thing being confirmed is the page behind it. */
.lumen-toast{
  position:fixed;left:50%;bottom:28px;z-index:2147483000;
  transform:translate(-50%,10px);opacity:0;
  max-width:min(360px,80vw);padding:8px 14px;border-radius:999px;
  font-size:12px;line-height:1.4;
  color:var(--lumen-toast-text);
  background:var(--lumen-toast-bg);
  box-shadow:var(--lumen-toast-shadow);
  pointer-events:none;transition:opacity .18s ease,transform .18s ease;
}
.lumen-toast.is-on{opacity:1;transform:translate(-50%,0);}
.lumen-advanced{border-top:1px solid var(--lumen-border);padding-top:2px;}
.lumen-advanced-summary{
  cursor:pointer;list-style:none;padding:4px 0;
  font-size:11.5px;color:var(--lumen-text-3);
}
.lumen-advanced-summary::-webkit-details-marker{display:none;}
.lumen-advanced-summary::after{content:"▾";float:right;transition:transform .16s ease;}
.lumen-advanced[open] .lumen-advanced-summary{color:var(--lumen-text-2);}
.lumen-advanced[open] .lumen-advanced-summary::after{transform:rotate(180deg);}
.lumen-advanced > *:not(summary){margin-top:9px;}
.lumen-source-body{display:flex;flex-direction:column;gap:9px;}
/* Set when the rotation switch was refused for an empty playlist: the answer
   has to appear where the switch is, not only in the banner above. */
.lumen-empty-state.is-refused{
  padding:0 9px;margin:0 -9px;border-radius:8px;
  background:var(--lumen-hover);
}
.lumen-empty-state.is-refused .lumen-empty{color:var(--dsw-alias-state-warn-primary,#e0a34a);}
.lumen-inline-input{
  font:inherit;font-size:11.5px;color:var(--lumen-text);background:var(--lumen-surface);
  border:1px solid var(--lumen-border);border-radius:7px;padding:4px 7px;width:74px;
}
.lumen-inline-input.is-wide{width:100%;}
.lumen-inline-input:focus{outline:none;border-color:var(--lumen-accent);}
.lumen-file-input{display:none;}
.lumen-divider{height:1px;background:var(--lumen-border);margin:1px 0;}
.lumen-kv{display:flex;justify-content:space-between;font-size:11.5px;color:var(--lumen-text-3);gap:10px;}
.lumen-kv b{color:var(--lumen-text-2);font-weight:500;font-variant-numeric:tabular-nums;}
`;

/** The style element id, so the panel can find and reuse its own sheet. */
const PANEL_STYLE_ID = "dsh-lumen-panel-style";

/**
 * Install the panel stylesheet once per document.
 *
 * Probes for the two document methods it needs rather than assuming them: this
 * runs during panel construction, and a construction that throws takes the
 * whole settings section down with it. A missing stylesheet costs some
 * cosmetics; a thrown error costs the section.
 */
function ensurePanelStyle(doc) {
	const target = doc || (typeof document !== "undefined" ? document : null);
	if (target === null || target === undefined) return;
	if (typeof target.getElementById !== "function" || typeof target.createElement !== "function") return;
	if (target.getElementById(PANEL_STYLE_ID) !== null && target.getElementById(PANEL_STYLE_ID) !== undefined) return;
	const el = target.createElement("style");
	el.id = PANEL_STYLE_ID;
	el.textContent = PANEL_CSS;
	const parent = target.head || target.documentElement;
	if (parent === null || parent === undefined || typeof parent.appendChild !== "function") return;
	parent.appendChild(el);
}

module.exports = { PANEL_CSS, PANEL_STYLE_ID, ensurePanelStyle };
