/**
 * 群组机器人管理（右侧设置面板内嵌 section）
 * - 主 agent 显示名（primaryName）可改
 * - 附加机器人：从 BOT_PROFILES 添加 / 移除 / 启停
 * - 权限：owner 可编辑，成员只读（PATCH 由 core 校验 owner）
 */
import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../core/chassis/src/errors";
import { t } from "./i18n";
import { icon } from "./ui";
import { Bot, Check, Plus, X } from "lucide";

export interface BotProfileView {
  botId: string;
  name: string;
  avatar: string;
  personality: string;
  capabilities: string;
}

interface BotsWire {
  config: { primaryName: string; attached: Array<{ botId: string; enabled: boolean }> };
  profiles: BotProfileView[];
}

export const botSettingsState = {
  projectId: null as string | null,
  loading: false,
  primaryName: "",
  attached: [] as Array<{ botId: string; enabled: boolean }>,
  profiles: [] as BotProfileView[],
  dirty: false,
  saving: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function resetBotSettings(): void {
  loadSeq += 1;
  botSettingsState.projectId = null;
  botSettingsState.loading = false;
  botSettingsState.primaryName = "";
  botSettingsState.attached = [];
  botSettingsState.profiles = [];
  botSettingsState.dirty = false;
  botSettingsState.saving = false;
  botSettingsState.notice = "";
  botSettingsState.noticeKind = "";
}

export async function loadBotSettings(projectId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (botSettingsState.projectId === projectId) return;
  resetBotSettings();
  const seq = ++loadSeq;
  botSettingsState.projectId = projectId;
  botSettingsState.loading = true;
  try {
    const r = await api<BotsWire>(`/api/projects/${encodeURIComponent(projectId)}/bots`);
    if (seq !== loadSeq) return;
    botSettingsState.primaryName = r.config.primaryName ?? "";
    botSettingsState.attached = r.config.attached ?? [];
    botSettingsState.profiles = r.profiles ?? [];
  } catch (e) {
    if (seq !== loadSeq) return;
    botSettingsState.notice = errMessage(e, "Couldn't load this group's bots.");
    botSettingsState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      botSettingsState.loading = false;
      redraw();
    }
  }
}

function markDirty(): void {
  botSettingsState.dirty = true;
  botSettingsState.notice = "";
  botSettingsState.noticeKind = "";
  redraw();
}

async function save(): Promise<void> {
  const projectId = botSettingsState.projectId;
  if (!projectId || botSettingsState.saving) return;
  botSettingsState.saving = true;
  redraw();
  try {
    const r = await api<BotsWire>(`/api/projects/${encodeURIComponent(projectId)}/bots`, {
      method: "PATCH",
      body: JSON.stringify({
        primaryName: botSettingsState.primaryName,
        attached: botSettingsState.attached,
      }),
    });
    botSettingsState.primaryName = r.config.primaryName ?? "";
    botSettingsState.attached = r.config.attached ?? [];
    botSettingsState.dirty = false;
    botSettingsState.notice = t("ambient.saved");
    botSettingsState.noticeKind = "saved";
  } catch (e) {
    botSettingsState.notice = errMessage(e, t("ambient.saveFailed"));
    botSettingsState.noticeKind = "error";
  } finally {
    botSettingsState.saving = false;
    redraw();
  }
}

function setPrimaryName(value: string): void {
  botSettingsState.primaryName = value.slice(0, 30);
  markDirty();
}

function toggleBot(botId: string, enabled: boolean): void {
  const idx = botSettingsState.attached.findIndex((a) => a.botId === botId);
  if (idx >= 0) {
    botSettingsState.attached = botSettingsState.attached.map((a, i) => (i === idx ? { ...a, enabled } : a));
  } else {
    botSettingsState.attached = [...botSettingsState.attached, { botId, enabled }];
  }
  markDirty();
}

function removeBot(botId: string): void {
  botSettingsState.attached = botSettingsState.attached.filter((a) => a.botId !== botId);
  markDirty();
}

function profileView(botId: string): BotProfileView | undefined {
  return botSettingsState.profiles.find((p) => p.botId === botId);
}

export function botSettingsSection(owner: boolean): TemplateResult | typeof nothing {
  if (!botSettingsState.projectId) return nothing;
  if (botSettingsState.loading)
    return html`<section class="context-panel context-bots" aria-labelledby="context-bots-title">
      <h2 class="context-panel-title" id="context-bots-title">${t("bots.title")}</h2>
      <div class="context-panel-loading">${t("common.loading")}</div>
    </section>`;
  return html`
    <section class="context-panel context-bots" aria-labelledby="context-bots-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="context-bots-title">${t("bots.title")}</h2>
          <p class="context-panel-copy">${t("bots.titleCopy")}</p>
        </div>
      </div>
      <div class="ambient-group">
        <label class="ambient-field-label" for="bots-primary-name">${t("bots.primaryName")}</label>
        <input
          id="bots-primary-name"
          data-focus-key="bots-primary-name"
          class="bots-primary-name"
          type="text"
          maxlength="30"
          placeholder="群助手"
          .value=${botSettingsState.primaryName}
          ?disabled=${!owner || botSettingsState.saving}
          @input=${(e: InputEvent) => setPrimaryName((e.currentTarget as HTMLInputElement).value)}
        />
        <p class="ambient-policy-hint">${t("bots.primaryNameHint")}</p>
      </div>
      <div class="ambient-group">
        <h3 class="ambient-field-label">${t("bots.attached")}</h3>
        <p class="ambient-policy-hint">${t("bots.attachedHint")}</p>
        <div class="bots-list">
          ${
            botSettingsState.profiles.length === 0
              ? html`<div class="empty compact">${t("bots.noProfiles")}</div>`
              : botSettingsState.profiles.map(
                  (p) => html`${botRow(p, owner)}`,
                )
          }
        </div>
      </div>
      <div class="ambient-policy-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${!owner || !botSettingsState.dirty || botSettingsState.saving}
          @click=${() => void save()}
        >
          ${botSettingsState.saving ? t("ambient.saving") : t("common.save")}
        </button>
        ${
          botSettingsState.notice
            ? html`<span
                class=${`ambient-policy-status ${botSettingsState.noticeKind === "error" ? "error" : ""}`}
                aria-live="polite"
                >${botSettingsState.notice}</span
              >`
            : nothing
        }
      </div>
    </section>
  `;
}

function botRow(p: BotProfileView, owner: boolean): TemplateResult {
  const attached = botSettingsState.attached.find((a) => a.botId === p.botId);
  const enabled = attached?.enabled ?? false;
  return html`
    <div class="bots-row">
      <span class="bots-row-avatar" aria-hidden="true">${p.avatar}</span>
      <span class="bots-row-main">
        <span class="bots-row-name">${p.name}</span>
        <span class="bots-row-caps">${p.capabilities}</span>
      </span>
      ${
        owner
          ? html`
              <button
                class="project-icon-button"
                type="button"
                aria-label=${enabled ? t("bots.disable", { name: p.name }) : t("bots.enable", { name: p.name })}
                title=${enabled ? t("bots.disable", { name: p.name }) : t("bots.enable", { name: p.name })}
                ?disabled=${botSettingsState.saving}
                @click=${() => toggleBot(p.botId, !enabled)}
              >
                ${enabled ? icon(Check, 15) : icon(Plus, 15)}
              </button>
              ${
                attached
                  ? html`<button
                      class="project-icon-button danger"
                      type="button"
                      aria-label=${t("bots.remove", { name: p.name })}
                      title=${t("bots.remove", { name: p.name })}
                      ?disabled=${botSettingsState.saving}
                      @click=${() => removeBot(p.botId)}
                    >
                      ${icon(X, 15)}
                    </button>`
                  : nothing
              }
            `
          : enabled
            ? html`<span class="badge">${t("bots.on")}</span>`
            : nothing
      }
    </div>
  `;
}
