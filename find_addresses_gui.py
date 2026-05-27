#!/usr/bin/env python3
"""
find_addresses_gui.py  —  Desktop window for find_addresses.py
==============================================================
A simple Windows desktop app (Tkinter, no extra install) that wraps the
token-optimized address-finder engine in find_addresses.py.

Just double-click this file (or run `python find_addresses_gui.py`).
Keep it in the SAME folder as find_addresses.py.

Features
--------
  • Browse buttons to pick the input .xlsx and choose where to save the output
  • Mode dropdown (heuristic / llm) + model box
  • API key field (only needed for llm mode; can also use the ANTHROPIC_API_KEY env var)
  • Limit / Start / Sleep / cache toggle controls
  • Live progress bar + percentage
  • Scrolling colored log (one line per row, with CACHED / JSON-LD tags)
  • Live token panel: total tokens, API calls, cache hits, JSON-LD hits,
    zero-token rows, and an estimated cost
  • Start / Stop buttons (Stop aborts gracefully and still saves what's done)
  • "Open output folder" when finished
"""

import os
import queue
import sys
import threading
import traceback
import webbrowser
from pathlib import Path

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# Import the engine that lives next to this file.
try:
    import find_addresses as engine
except Exception as e:  # pragma: no cover
    # Show a clear error if the engine file is missing, then exit.
    root = tk.Tk(); root.withdraw()
    messagebox.showerror(
        "Engine not found",
        "Could not import find_addresses.py.\n\n"
        "Make sure find_addresses_gui.py is in the SAME folder as "
        "find_addresses.py.\n\nDetails: " + str(e))
    sys.exit(1)


# ----------------------------------------------------------------------------- #
# Theme
# ----------------------------------------------------------------------------- #

BG      = "#0f1419"
PANEL   = "#1a2029"
FG      = "#e6e6e6"
MUTED   = "#8a93a0"
ACCENT  = "#4ea1ff"
GREEN   = "#5dd47e"
YELLOW  = "#ffcf5c"
RED     = "#ff6b6b"
GREY    = "#6b7480"
FONT    = ("Segoe UI", 10)
FONT_B  = ("Segoe UI", 10, "bold")
MONO    = ("Consolas", 9)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Address Finder — token-optimized")
        self.configure(bg=BG)
        self.geometry("980x720")
        self.minsize(880, 640)

        self.q = queue.Queue()          # thread -> UI messages
        self.worker = None
        self.stop_flag = threading.Event()
        self.meta = {}

        self._build_styles()
        self._build_ui()
        self.after(80, self._drain_queue)

    # ------------------------------------------------------------------ styles
    def _build_styles(self):
        s = ttk.Style(self)
        try:
            s.theme_use("clam")
        except Exception:
            pass
        s.configure("TFrame", background=BG)
        s.configure("Panel.TFrame", background=PANEL)
        s.configure("TLabel", background=BG, foreground=FG, font=FONT)
        s.configure("Muted.TLabel", background=BG, foreground=MUTED, font=FONT)
        s.configure("Panel.TLabel", background=PANEL, foreground=FG, font=FONT)
        s.configure("PanelMuted.TLabel", background=PANEL, foreground=MUTED, font=FONT)
        s.configure("Head.TLabel", background=BG, foreground=ACCENT, font=("Segoe UI", 15, "bold"))
        s.configure("TButton", font=FONT_B, padding=6)
        s.configure("Accent.TButton", font=FONT_B, padding=8)
        s.map("Accent.TButton",
              background=[("!disabled", ACCENT), ("disabled", "#33424f")],
              foreground=[("!disabled", "#08111c")])
        s.configure("TEntry", fieldbackground=PANEL, foreground=FG, font=FONT)
        s.configure("TCombobox", fieldbackground=PANEL, foreground=FG)
        s.configure("TCheckbutton", background=BG, foreground=FG, font=FONT)
        s.configure("Horizontal.TProgressbar", troughcolor=PANEL,
                    background=ACCENT, thickness=18)

    # ---------------------------------------------------------------------- ui
    def _build_ui(self):
        pad = {"padx": 10, "pady": 6}

        ttk.Label(self, text="Address Finder", style="Head.TLabel").pack(
            anchor="w", padx=16, pady=(14, 0))
        ttk.Label(self, text="Find street addresses from a spreadsheet — "
                             "with link-cache, address-windowing, and live token tracking.",
                  style="Muted.TLabel").pack(anchor="w", padx=16, pady=(0, 8))

        # ---- file row
        files = ttk.Frame(self); files.pack(fill="x", padx=16)
        self.in_var  = tk.StringVar()
        self.out_var = tk.StringVar(value=str(Path.cwd() / "addresses_output.xlsx"))

        self._file_row(files, "Input .xlsx:", self.in_var, self._pick_input, 0)
        self._file_row(files, "Save output to:", self.out_var, self._pick_output, 1)
        files.columnconfigure(1, weight=1)

        # ---- options row
        opt = ttk.Frame(self); opt.pack(fill="x", padx=16, pady=(4, 0))

        ttk.Label(opt, text="Mode:").grid(row=0, column=0, sticky="w", **pad)
        self.mode_var = tk.StringVar(value="heuristic")
        mode_cb = ttk.Combobox(opt, textvariable=self.mode_var, width=12,
                               state="readonly", values=["heuristic", "llm"])
        mode_cb.grid(row=0, column=1, sticky="w", **pad)
        mode_cb.bind("<<ComboboxSelected>>", lambda e: self._toggle_llm_fields())

        # Endpoint picker — switch per machine without editing code or env vars.
        #   "Direct Anthropic API"  -> personal laptop (your Claude key)
        #   "Straive gateway"       -> office laptop
        ttk.Label(opt, text="Endpoint:").grid(row=0, column=2, sticky="w", **pad)
        self.endpoint_var = tk.StringVar(value="Direct Anthropic API")
        self.endpoint_cb = ttk.Combobox(
            opt, textvariable=self.endpoint_var, width=22, state="readonly",
            values=["Direct Anthropic API", "Straive gateway"])
        self.endpoint_cb.grid(row=0, column=3, sticky="w", **pad)
        self.endpoint_cb.bind("<<ComboboxSelected>>", lambda e: self._on_endpoint())

        ttk.Label(opt, text="Model:").grid(row=0, column=4, sticky="w", **pad)
        self.model_var = tk.StringVar(value="claude-opus-4-6")
        self.model_entry = ttk.Entry(opt, textvariable=self.model_var, width=30)
        self.model_entry.grid(row=0, column=5, sticky="w", **pad)

        ttk.Label(opt, text="API key:").grid(row=1, column=0, sticky="w", **pad)
        self.key_var = tk.StringVar(value=os.environ.get("ANTHROPIC_API_KEY", ""))
        self.key_entry = ttk.Entry(opt, textvariable=self.key_var, width=46, show="•")
        self.key_entry.grid(row=1, column=1, columnspan=3, sticky="we", **pad)
        self.show_key = tk.BooleanVar(value=False)
        ttk.Checkbutton(opt, text="show", variable=self.show_key,
                        command=self._toggle_key).grid(row=1, column=4, sticky="w")

        # numeric options
        nums = ttk.Frame(self); nums.pack(fill="x", padx=16)
        self.limit_var = tk.StringVar()
        self.start_var = tk.StringVar(value="0")
        self.sleep_var = tk.StringVar(value="1.0")
        self.cache_var = tk.BooleanVar(value=True)

        self._num(nums, "Limit (blank = all):", self.limit_var, 0)
        self._num(nums, "Start row:", self.start_var, 2)
        self._num(nums, "Sleep (s):", self.sleep_var, 4)
        ttk.Checkbutton(nums, text="Reuse cache for duplicate links (recommended)",
                        variable=self.cache_var).grid(row=0, column=6, padx=14)

        # Extraction mode. By DEFAULT only the address paragraph(s) are sent
        # (first 3 locations, ~6,000 chars, HTML tags stripped) to save tokens.
        # Tick this to send the whole cleaned page instead (uses more tokens).
        self.fullpage_var = tk.BooleanVar(value=False)
        savers = ttk.Frame(self); savers.pack(fill="x", padx=16)
        ttk.Label(savers, text="Extraction (default: send only the address paragraphs — fewer tokens):",
                  style="Muted.TLabel").grid(row=0, column=0, sticky="w", padx=10, pady=(0, 2))
        ttk.Checkbutton(savers, text="Send full page instead (more tokens)",
                        variable=self.fullpage_var).grid(row=1, column=0, sticky="w", padx=14)

        # ---- buttons
        btns = ttk.Frame(self); btns.pack(fill="x", padx=16, pady=8)
        self.start_btn = ttk.Button(btns, text="▶  Start", style="Accent.TButton",
                                    command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(btns, text="■  Stop", command=self._stop,
                                   state="disabled")
        self.stop_btn.pack(side="left", padx=8)
        self.open_btn = ttk.Button(btns, text="📂  Open output folder",
                                   command=self._open_folder, state="disabled")
        self.open_btn.pack(side="left", padx=8)

        # ---- progress
        prog = ttk.Frame(self); prog.pack(fill="x", padx=16)
        self.pbar = ttk.Progressbar(prog, style="Horizontal.TProgressbar",
                                    mode="determinate")
        self.pbar.pack(side="left", fill="x", expand=True)
        self.pct_lbl = ttk.Label(prog, text="0%", style="Muted.TLabel", width=6)
        self.pct_lbl.pack(side="left", padx=8)

        # ---- token / status panel
        panel = ttk.Frame(self, style="Panel.TFrame"); panel.pack(fill="x", padx=16, pady=8)
        self.stat_vars = {}
        cells = [("Verified", GREEN), ("Partial", YELLOW), ("Not Found", RED),
                 ("Total tokens", ACCENT), ("API calls", FG),
                 ("Cache hits", GREEN),
                 ("Zero-token rows", GREEN), ("Est. cost", YELLOW)]
        for i, (name, color) in enumerate(cells):
            cell = ttk.Frame(panel, style="Panel.TFrame")
            cell.grid(row=0, column=i, padx=10, pady=8, sticky="w")
            v = tk.StringVar(value="0")
            self.stat_vars[name] = v
            tk.Label(cell, textvariable=v, bg=PANEL, fg=color,
                     font=("Segoe UI", 14, "bold")).pack(anchor="w")
            tk.Label(cell, text=name, bg=PANEL, fg=MUTED, font=("Segoe UI", 8)).pack(anchor="w")

        # ---- log
        logf = ttk.Frame(self); logf.pack(fill="both", expand=True, padx=16, pady=(0, 12))
        self.log = tk.Text(logf, bg="#0b0f14", fg=FG, font=MONO, height=14,
                           wrap="none", relief="flat", padx=10, pady=8)
        self.log.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(logf, command=self.log.yview)
        sb.pack(side="right", fill="y")
        self.log.config(yscrollcommand=sb.set, state="disabled")
        for tag, col in (("green", GREEN), ("yellow", YELLOW), ("red", RED),
                         ("muted", MUTED), ("accent", ACCENT), ("grey", GREY)):
            self.log.tag_config(tag, foreground=col)

        self._toggle_llm_fields()

    # -------------------------------------------------------------- ui helpers
    def _file_row(self, parent, label, var, cmd, row):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=10, pady=6)
        ttk.Entry(parent, textvariable=var).grid(row=row, column=1, sticky="we", padx=6)
        ttk.Button(parent, text="Browse…", command=cmd).grid(row=row, column=2, padx=6)

    def _num(self, parent, label, var, col):
        ttk.Label(parent, text=label).grid(row=0, column=col, sticky="w", padx=(10, 4), pady=6)
        ttk.Entry(parent, textvariable=var, width=8).grid(row=0, column=col+1, sticky="w")

    def _toggle_key(self):
        self.key_entry.config(show="" if self.show_key.get() else "•")

    def _toggle_llm_fields(self):
        is_llm = self.mode_var.get() == "llm"
        state = "normal" if is_llm else "disabled"
        self.model_entry.config(state=state)
        self.key_entry.config(state=state)
        self.endpoint_cb.config(state="readonly" if is_llm else "disabled")

    # Endpoint -> (base_url, suggested default model). base_url None = direct API.
    ENDPOINTS = {
        "Direct Anthropic API": (None, "claude-opus-4-6"),
        "Straive gateway":      ("https://chatapi.straive.com",
                                 "global.anthropic.claude-opus-4-7"),
    }

    def _on_endpoint(self):
        choice = self.endpoint_var.get()
        _base, suggested_model = self.ENDPOINTS.get(choice, (None, ""))
        # Auto-fill the model with the endpoint's usual default. The box stays
        # editable, so if your endpoint expects a different name just type it.
        if suggested_model:
            self.model_var.set(suggested_model)
        self._log(f"Endpoint set to: {choice}"
                  + (" (api.anthropic.com)" if _base is None else f" ({_base})"),
                  "muted")

    def _pick_input(self):
        p = filedialog.askopenfilename(
            title="Choose input spreadsheet",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")])
        if p:
            self.in_var.set(p)
            # default output next to input
            ip = Path(p)
            self.out_var.set(str(ip.with_name(ip.stem + "_addresses.xlsx")))

    def _pick_output(self):
        p = filedialog.asksaveasfilename(
            title="Save output as", defaultextension=".xlsx",
            filetypes=[("Excel files", "*.xlsx")])
        if p:
            self.out_var.set(p)

    def _log(self, text, tag=None):
        self.log.config(state="normal")
        self.log.insert("end", text + "\n", (tag,) if tag else ())
        self.log.see("end")
        self.log.config(state="disabled")

    # ------------------------------------------------------------------- start
    def _start(self):
        inp = self.in_var.get().strip()
        out = self.out_var.get().strip()
        if not inp or not Path(inp).exists():
            messagebox.showerror("Missing input", "Please choose a valid input .xlsx file.")
            return
        if not out:
            messagebox.showerror("Missing output", "Please choose where to save the output.")
            return

        mode = self.mode_var.get()
        if mode == "llm":
            key = self.key_var.get().strip()
            if not key:
                messagebox.showerror("API key needed",
                                     "LLM mode needs an ANTHROPIC_API_KEY.\n"
                                     "Enter it in the API key box (or set the env var).")
                return
            os.environ["ANTHROPIC_API_KEY"] = key
            # Apply the selected endpoint (base URL) to the engine and rebuild client.
            base, _ = self.ENDPOINTS.get(self.endpoint_var.get(), (None, ""))
            engine.API_BASE_URL = base
            engine._ANTHROPIC_CLIENT = None  # force client rebuild with new key/endpoint

        def _int(v, d=None):
            v = (v or "").strip()
            return int(v) if v else d
        def _float(v, d):
            v = (v or "").strip()
            return float(v) if v else d

        try:
            limit = _int(self.limit_var.get(), None)
            start = _int(self.start_var.get(), 0) or 0
            sleep = _float(self.sleep_var.get(), 1.0)
        except ValueError:
            messagebox.showerror("Bad number",
                                 "Limit / Start / Sleep must be numbers.")
            return

        # reset state + UI
        engine.USAGE = engine.Usage()
        self.stop_flag.clear()
        self.pbar["value"] = 0
        self.pct_lbl.config(text="0%")
        for v in self.stat_vars.values():
            v.set("0")
        self.log.config(state="normal"); self.log.delete("1.0", "end"); self.log.config(state="disabled")
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.open_btn.config(state="disabled")

        params = dict(input_path=inp, output_path=out, mode=mode,
                      model=self.model_var.get().strip(), limit=limit,
                      start=start, sleep=sleep, use_cache=self.cache_var.get(),
                      window=not self.fullpage_var.get())

        self.worker = threading.Thread(target=self._run_worker, args=(params,), daemon=True)
        self.worker.start()

    def _stop(self):
        self.stop_flag.set()
        self.stop_btn.config(state="disabled")
        self._log("Stopping after the current row…", "yellow")

    # ----------------------------------------------------- worker thread body
    def _run_worker(self, params):
        try:
            engine.run_job(
                **params,
                on_start=lambda m: self.q.put(("start", m)),
                on_row=lambda i: self.q.put(("row", i)),
                on_done=lambda s: self.q.put(("done", s)),
                should_stop=lambda: self.stop_flag.is_set(),
            )
        except SystemExit as e:
            self.q.put(("error", str(e)))
        except Exception:
            self.q.put(("error", traceback.format_exc()))

    # ----------------------------------------------------- UI-thread consumer
    def _drain_queue(self):
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "start":
                    self._on_start(payload)
                elif kind == "row":
                    self._on_row(payload)
                elif kind == "done":
                    self._on_done(payload)
                elif kind == "error":
                    self._on_error(payload)
        except queue.Empty:
            pass
        self.after(80, self._drain_queue)

    def _on_start(self, m):
        self.meta = m
        self.pbar["maximum"] = max(1, m["total"])
        self._log(f"Mode: {m['mode']}   |   {m['total']} rows   |   "
                  f"{m['unique_links']} unique links   |   "
                  f"{m['duplicates']} duplicate links (cacheable)", "accent")
        if m["mode"] == "llm":
            self._log("Token tracking is live. Duplicate links cost 0 tokens; "
                      "Claude decides every other row.", "muted")
        self._log("─" * 90, "grey")

    def _on_row(self, info):
        done = info["idx"] - self.meta.get("total_abs", info["idx"]) + self.meta.get("total", 1)
        # progress is simply how many rows we've emitted
        self.pbar["value"] = self.pbar["value"] + 1
        pct = int(100 * self.pbar["value"] / max(1, self.pbar["maximum"]))
        self.pct_lbl.config(text=f"{pct}%")

        tag = {"Verified": "green", "Partial": "yellow",
               "Not Found": "red"}.get(info["status"], None)
        rt = info["row_tokens"]
        extra = ""
        if rt and (rt[0] or rt[1]):
            extra = f"  +{rt[0]+rt[1]:,} tok"
        elif info["source_tag"]:
            extra = f"  [{info['source_tag']}]"
        line = (f"[{info['idx']}/{info['total_abs']}] "
                f"{(info['company'][:36]).ljust(36)} "
                f"{info['status']:<10} ∑{info['usage_total']:,} tok{extra}")
        self._log(line, tag)

        # live stat panel
        u = engine.USAGE
        self.stat_vars["Total tokens"].set(f"{u.total:,}")
        self.stat_vars["API calls"].set(str(u.api_calls))
        self.stat_vars["Cache hits"].set(str(u.cache_hits))
        self.stat_vars["Zero-token rows"].set(str(u.cache_hits))
        cur = self.stat_vars.get(info["status"])
        if cur is not None:
            try:
                cur.set(str(int(cur.get()) + 1))
            except ValueError:
                cur.set("1")

    def _on_done(self, s):
        self._log("─" * 90, "grey")
        c = s["counts"]
        self._log(f"Done. Wrote {s['rows']} rows to {s['output_path']}  "
                  f"({s['elapsed']:.1f}s)"
                  + ("  [STOPPED EARLY]" if s["stopped"] else ""),
                  "accent")
        self._log(f"Results — Verified {c.get('Verified',0)} | "
                  f"Partial {c.get('Partial',0)} | Not Found {c.get('Not Found',0)}")
        if s["mode"] == "llm":
            self.stat_vars["Est. cost"].set(f"${s['cost']:.4f}")
            self._log(f"Tokens — total {s['total_tokens']:,} "
                      f"(in {s['in_tokens']:,} / out {s['out_tokens']:,}) over "
                      f"{s['api_calls']} API calls", "accent")
            self._log(f"Saved — {s['cache_hits']} duplicate links reused = "
                      f"{s['cache_hits']} rows at ZERO tokens. "
                      f"Est. cost ${s['cost']:.4f}", "green")
        self._finish()

    def _on_error(self, msg):
        self._log("ERROR:\n" + msg, "red")
        messagebox.showerror("Run failed", msg.splitlines()[-1] if msg else "Unknown error")
        self._finish()

    def _finish(self):
        self.start_btn.config(state="normal")
        self.stop_btn.config(state="disabled")
        self.open_btn.config(state="normal")

    def _open_folder(self):
        out = Path(self.out_var.get())
        folder = out.parent if out.parent.exists() else Path.cwd()
        try:
            if sys.platform.startswith("win"):
                os.startfile(folder)  # noqa
            elif sys.platform == "darwin":
                os.system(f'open "{folder}"')
            else:
                webbrowser.open(folder.as_uri())
        except Exception as e:
            messagebox.showinfo("Output folder", f"Saved in:\n{folder}\n\n({e})")


if __name__ == "__main__":
    App().mainloop()
