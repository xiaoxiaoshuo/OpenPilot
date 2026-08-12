import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../core/chassis/src/errors";
import { fieldSelect } from "./ui";
import { t } from "./i18n";

export const BOT_MODES = ["ignore", "rollup", "action", "user"] as const;
export type BotMode = (typeof BOT_MODES)[number];
export interface BotPolicyView {
  name: string;
  mode: BotMode;
  rollupHours?: number;
}
interface PolicyWire {
  policy: {
    orders: string;
    bots: Record<string, { mode: BotMode; rollupHours?: number }>;
    ambientEnabled?: boolean | null;
    updatedAt: number;
  };
}

export const ambientPolicyState = {
  scope: null as string | null,
  loading: false,
  orders: "",
  ambientEnabled: null as boolean | null,
  bots: [] as BotPolicyView[],
  baseUpdatedAt: 0,
  dirty: false,
  saving: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
  newBotName: "",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function ambientPolicyApplies(scopeId: string): boolean {
  return scopeId.startsWith("channel:") || scopeId.startsWith("group:");
}

export function resetAmbientPolicy(): void {
  loadSeq += 1;
  ambientPolicyState.scope = null;
  ambientPolicyState.loading = false;
  ambientPolicyState.orders = "";
  ambientPolicyState.ambientEnabled = null;
  ambientPolicyState.bots = [];
  ambientPolicyState.baseUpdatedAt = 0;
  ambientPolicyState.dirty = false;
  ambientPolicyState.saving = false;
  ambientPolicyState.notice = "";
  ambientPolicyState.noticeKind = "";
  ambientPolicyState.newBotName = "";
}

export async function loadAmbientPolicy(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (!ambientPolicyApplies(scopeId) || ambientPolicyState.scope === scopeId) return;
  resetAmbientPolicy();
  const seq = ++loadSeq;
  ambientPolicyState.scope = scopeId;
  ambientPolicyState.loading = true;
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scopeId)}/ambient-policy`);
    if (seq !== loadSeq) return;
    ambientPolicyState.orders = r.policy.orders;
    ambientPolicyState.ambientEnabled = r.policy.ambientEnabled ?? null;
    ambientPolicyState.bots = Object.entries(r.policy.bots).map(([name, p]) => ({
      name,
      mode: p.mode,
      ...(p.rollupHours !== undefined ? { rollupHours: p.rollupHours } : {}),
    }));
    ambientPolicyState.baseUpdatedAt = r.policy.updatedAt;
  } catch (e) {
    if (seq !== loadSeq) return;
    ambientPolicyState.notice = errMessage(e, t("ambient.loadFailed"));
    ambientPolicyState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      ambientPolicyState.loading = false;
      redraw();
    }
  }
}

function markDirty(): void {
  ambientPolicyState.dirty = true;
  ambientPolicyState.notice = "";
  ambientPolicyState.noticeKind = "";
  redraw();
}

async function save(): Promise<void> {
  const scope = ambientPolicyState.scope;
  if (!scope || ambientPolicyState.saving) return;
  const bots: Record<string, { mode: BotMode; rollupHours?: number }> = {};
  for (const b of ambientPolicyState.bots) {
    const name = b.name.trim();
    if (!name) continue;
    bots[name] = { mode: b.mode, ...(b.mode === "rollup" && b.rollupHours ? { rollupHours: b.rollupHours } : {}) };
  }
  ambientPolicyState.saving = true;
  redraw();
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scope)}/ambient-policy`, {
      method: "PUT",
      body: JSON.stringify({
        orders: ambientPolicyState.orders,
        bots,
        ambientEnabled: ambientPolicyState.ambientEnabled,
        baseUpdatedAt: ambientPolicyState.baseUpdatedAt,
      }),
    });
    ambientPolicyState.orders = r.policy.orders;
    ambientPolicyState.ambientEnabled = r.policy.ambientEnabled ?? null;
    ambientPolicyState.bots = Object.entries(r.policy.bots).map(([name, p]) => ({
      name,
      mode: p.mode,
      ...(p.rollupHours !== undefined ? { rollupHours: p.rollupHours } : {}),
    }));
    ambientPolicyState.baseUpdatedAt = r.policy.updatedAt;
    ambientPolicyState.dirty = false;
    ambientPolicyState.notice = t("ambient.saved");
    ambientPolicyState.noticeKind = "saved";
  } catch (e) {
    ambientPolicyState.notice = errMessage(e, t("ambient.saveFailed"));
    ambientPolicyState.noticeKind = "error";
  } finally {
    ambientPolicyState.saving = false;
    redraw();
  }
}

function addBot(): void {
  const name = ambientPolicyState.newBotName.trim();
  if (!name) return;
  if (ambientPolicyState.bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    ambientPolicyState.notice = t("ambient.alreadyInLedger", { name });
    ambientPolicyState.noticeKind = "error";
    redraw();
    return;
  }
  ambientPolicyState.bots = [...ambientPolicyState.bots, { name, mode: "ignore" }];
  ambientPolicyState.newBotName = "";
  markDirty();
}

const BOT_MODE_LABELS: Record<BotMode, string> = {
  ignore: t("ambient.mode.ignore"),
  rollup: t("ambient.mode.rollup"),
  action: t("ambient.mode.action"),
  user: t("ambient.mode.user"),
};

function ambientValue(enabled: boolean | null): string {
  if (enabled === null) return "default";
  return enabled ? "on" : "off";
}

function botRow(b: BotPolicyView, i: number): TemplateResult {
  return html`
    <div class="ambient-bot-row">
      <span class="ambient-bot-name">${b.name}</span>
      ${fieldSelect({
        className: "ambient-bot-mode",
        compact: true,
        ariaLabel: t("ambient.handlingFor", { name: b.name }),
        disabled: ambientPolicyState.saving,
        value: b.mode,
        onChange: (value) => {
          const mode = value as BotMode;
          ambientPolicyState.bots = ambientPolicyState.bots.map((x, j) => (j === i ? { ...x, mode } : x));
          markDirty();
        },
        options: BOT_MODES.map((m) => html`<option value=${m}>${BOT_MODE_LABELS[m]}</option>`),
      })}
      ${
        b.mode === "rollup"
          ? html`<label class="ambient-bot-hours"
              >${t("ambient.every")}
              <input
                type="number"
                min="1"
                step="1"
                data-focus-key=${`ambient-hours-${i}`}
                aria-label=${t("ambient.batchInterval", { name: b.name })}
                .value=${String(b.rollupHours ?? 24)}
                ?disabled=${ambientPolicyState.saving}
                @input=${(e: InputEvent) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  ambientPolicyState.bots = ambientPolicyState.bots.map((x, j) =>
                    j === i ? { ...x, rollupHours: Number.isFinite(v) && v > 0 ? v : undefined } : x,
                  );
                  markDirty();
                }}
              />
              ${t("ambient.hours")}</label
            >`
          : nothing
      }
      <button
        class="project-icon-button danger"
        type="button"
        aria-label=${t("ambient.removeFromLedger", { name: b.name })}
        title=${t("ambient.remove")}
        ?disabled=${ambientPolicyState.saving}
        @click=${() => {
          ambientPolicyState.bots = ambientPolicyState.bots.filter((_, j) => j !== i);
          markDirty();
        }}
      >
        ✕
      </button>
    </div>
  `;
}

export function ambientPolicySection(scopeId: string): TemplateResult | typeof nothing {
  if (!ambientPolicyApplies(scopeId)) return nothing;
  if (ambientPolicyState.scope !== scopeId) return nothing;
  if (ambientPolicyState.loading)
    return html`<section class="context-panel ambient-policy" aria-labelledby="ambient-policy-title">
      <h2 class="context-panel-title" id="ambient-policy-title">${t("ambient.title")}</h2>
      <div class="context-panel-loading">${t("common.loading")}</div>
    </section>`;
  return html`
    <section class="context-panel ambient-policy" aria-labelledby="ambient-policy-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="ambient-policy-title">${t("ambient.title")}</h2>
          <p class="context-panel-copy">${t("ambient.titleCopy")}</p>
        </div>
      </div>
      <div class="ambient-group">
        <label class="ambient-field-label" for="ambient-enabled">${t("ambient.ambientBehavior")}</label>
        ${fieldSelect({
          id: "ambient-enabled",
          className: "ambient-enabled-select",
          focusKey: "ambient-enabled",
          describedBy: "ambient-enabled-hint",
          disabled: ambientPolicyState.saving,
          value: ambientValue(ambientPolicyState.ambientEnabled),
          onChange: (v) => {
            ambientPolicyState.ambientEnabled = v === "default" ? null : v === "on";
            markDirty();
          },
          options: [
            html`<option value="default">${t("ambient.default")}</option>`,
            html`<option value="on">${t("ambient.on")}</option>`,
            html`<option value="off">${t("ambient.off")}</option>`,
          ],
        })}
        <p class="ambient-policy-hint" id="ambient-enabled-hint">${t("ambient.hint")}</p>
      </div>
      <div class="ambient-group">
        <label class="ambient-field-label" for="ambient-orders">${t("ambient.standingOrders")}</label>
        <textarea
          id="ambient-orders"
          data-focus-key="ambient-orders"
          class="ambient-orders"
          rows="4"
          aria-describedby="ambient-orders-hint"
          placeholder=${t("ambient.ordersPlaceholder")}
          .value=${ambientPolicyState.orders}
          ?disabled=${ambientPolicyState.saving}
          @input=${(e: InputEvent) => {
            ambientPolicyState.orders = (e.currentTarget as HTMLTextAreaElement).value;
            markDirty();
          }}
        ></textarea>
        <p class="ambient-policy-hint" id="ambient-orders-hint">${t("ambient.ordersHint")}</p>
      </div>
      <div class="ambient-group">
        <h3 class="ambient-field-label">${t("ambient.automatedPosters")}</h3>
        <p class="ambient-policy-hint">${t("ambient.automatedPostersHint")}</p>
        ${ambientPolicyState.bots.length ? html`<div class="ambient-bot-list">${ambientPolicyState.bots.map((b, i) => botRow(b, i))}</div>` : html`<div class="empty compact">${t("ambient.noBots")}</div>`}
        <form
          class="ambient-bot-add"
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            addBot();
          }}
        >
          <input
            data-focus-key="ambient-bot-name"
            type="text"
            maxlength="120"
            aria-label=${t("ambient.botName")}
            required
            placeholder=${t("ambient.botName")}
            .value=${ambientPolicyState.newBotName}
            ?disabled=${ambientPolicyState.saving}
            @input=${(e: InputEvent) => {
              ambientPolicyState.newBotName = (e.currentTarget as HTMLInputElement).value;
              redraw();
            }}
          />
          <button class="btn" type="submit" ?disabled=${ambientPolicyState.saving}>${t("ambient.addBot")}</button>
        </form>
      </div>
      <div class="ambient-policy-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${!ambientPolicyState.dirty || ambientPolicyState.saving}
          @click=${() => void save()}
        >
          ${ambientPolicyState.saving ? t("ambient.saving") : t("common.save")}
        </button>
        ${
          ambientPolicyState.notice
            ? html`<span
                class=${`ambient-policy-status ${ambientPolicyState.noticeKind === "error" ? "error" : ""}`}
                aria-live="polite"
                >${ambientPolicyState.notice}</span
              >`
            : nothing
        }
      </div>
    </section>
  `;
}
