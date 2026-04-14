/**
 * Subagent Setup Wizard
 *
 * Interactive first-run setup that configures:
 *   1. Pack count (how many Synthetic packs)
 *   2. Model selection (accept defaults or customize)
 *   3. Weekly budget
 *   4. Confirm & save
 *
 * Uses ctx.ui.custom() for a tab-based multi-step flow.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import {
	type SubagentConfig,
	type ModelConfig,
	type ModelTier,
	DEFAULT_CONFIG,
	DEFAULT_MODELS,
	displayModel,
	computeSlots,
	computeTotalSlots,
	formatSlotSummary,
	saveConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Wizard State
// ---------------------------------------------------------------------------

interface WizardState {
	currentTab: number;
	packs: number;
	models: Record<string, ModelConfig>;
	weeklyBudget: number;
	defaultModel: string;
	// Model editing
	editingModel: string | null; // model ID being edited, or null
	editField: "slots" | "cost" | "tier" | "isSmall" | null;
	// Add model
	addingModel: boolean;
	newModelId: string;
	newModelSlots: number;
	newModelCost: number;
	newModelTier: ModelTier;
	newModelIsSmall: boolean;
	// Budget input
	editingBudget: boolean;
	budgetInput: string;
	// Pack editing
	editingPacks: boolean;
	packsInput: string;
}

const TABS = ["Packs", "Models", "Budget", "Confirm"] as const;
type TabName = (typeof TABS)[number];
const TAB_COUNT = TABS.length;

// ---------------------------------------------------------------------------
// Pack Options
// ---------------------------------------------------------------------------

const PACK_OPTIONS = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runSetupWizard(pi: ExtensionAPI, ctx: any): Promise<SubagentConfig | null> {
	const existingConfig = ctx._subagentConfig as SubagentConfig | undefined;

	const initialState: WizardState = {
		currentTab: 0,
		packs: existingConfig?.packs ?? DEFAULT_CONFIG.packs,
		models: existingConfig ? { ...existingConfig.models } : { ...DEFAULT_MODELS },
		weeklyBudget: existingConfig?.weeklyBudget ?? DEFAULT_CONFIG.weeklyBudget,
		defaultModel: existingConfig?.defaultModel ?? DEFAULT_CONFIG.defaultModel,
		editingModel: null,
		editField: null,
		addingModel: false,
		newModelId: "",
		newModelSlots: 1,
		newModelCost: 1.0,
		newModelTier: "fast",
		newModelIsSmall: false,
		editingBudget: false,
		budgetInput: "",
		editingPacks: false,
		packsInput: "",
	};

	const result = await ctx.ui.custom<SubagentConfig | null>((tui, theme, _kb, done) => {
		const state = { ...initialState };
		// Deep copy models
		state.models = { ...initialState.models };
		state.newModelId = "";
		state.budgetInput = String(state.weeklyBudget);
		state.packsInput = String(state.packs);

		let cachedLines: string[] | undefined;
		let packIndex = PACK_OPTIONS.indexOf(state.packs);
		if (packIndex === -1) packIndex = 0;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function currentTabName(): TabName {
			return TABS[state.currentTab];
		}

		function buildConfig(): SubagentConfig {
			return {
				packs: state.packs,
				models: { ...state.models },
				weeklyBudget: state.weeklyBudget,
				defaultModel: state.defaultModel,
				provider: "synthetic",
			};
		}

		function submit(save: boolean) {
			if (save) {
				const config = buildConfig();
				saveConfig(config);
				done(config);
			} else {
				done(null);
			}
		}

		function handleInput(data: string) {
			// ── Budget input mode ──
			if (state.editingBudget) {
				if (matchesKey(data, Key.enter)) {
					const parsed = parseFloat(state.budgetInput);
					if (!isNaN(parsed) && parsed > 0) {
						state.weeklyBudget = parsed;
					}
					state.editingBudget = false;
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					state.editingBudget = false;
					state.budgetInput = String(state.weeklyBudget);
					refresh();
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					state.budgetInput = state.budgetInput.slice(0, -1);
					refresh();
					return;
				}
				// Only allow digits and dot
				const ch = data;
				if (/^[0-9.]$/.test(ch)) {
					state.budgetInput += ch;
					refresh();
				}
				return;
			}

			// ── Pack input mode ──
			if (state.editingPacks) {
				if (matchesKey(data, Key.enter)) {
					const parsed = parseInt(state.packsInput, 10);
					if (!isNaN(parsed) && parsed >= 1 && parsed <= 20) {
						state.packs = parsed;
					}
					state.editingPacks = false;
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					state.editingPacks = false;
					state.packsInput = String(state.packs);
					refresh();
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					state.packsInput = state.packsInput.slice(0, -1);
					refresh();
					return;
				}
				if (/^[0-9]$/.test(data)) {
					state.packsInput += data;
					refresh();
				}
				return;
			}

			// ── Add model mode ──
			if (state.addingModel) {
				if (matchesKey(data, Key.enter)) {
					const id = state.newModelId.trim();
					if (id && !state.models[id]) {
						state.models[id] = {
							slots: state.newModelSlots,
							cost: state.newModelCost,
							tier: state.newModelTier,
							isSmall: state.newModelIsSmall,
						};
					}
					state.addingModel = false;
					state.newModelId = "";
					state.newModelSlots = 1;
					state.newModelCost = 1.0;
					state.newModelTier = "fast";
					state.newModelIsSmall = false;
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					state.addingModel = false;
					state.newModelId = "";
					refresh();
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					state.newModelId = state.newModelId.slice(0, -1);
					refresh();
					return;
				}
				// Cycle tier with Tab
				if (matchesKey(data, Key.tab)) {
					state.newModelTier = state.newModelTier === "fast" ? "power" : "fast";
					refresh();
					return;
				}
				// Toggle small with 's'
				if (data === "s" || data === "S") {
					state.newModelIsSmall = !state.newModelIsSmall;
					state.newModelSlots = state.newModelIsSmall ? 2 : 1;
					refresh();
					return;
				}
				state.newModelId += data;
				refresh();
				return;
			}

			// ── Normal navigation ──

			// Tab navigation
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				state.currentTab = (state.currentTab + 1) % TAB_COUNT;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				state.currentTab = (state.currentTab - 1 + TAB_COUNT) % TAB_COUNT;
				refresh();
				return;
			}

			// Cancel
			if (matchesKey(data, Key.escape)) {
				submit(false);
				return;
			}

			// Tab-specific input
			const tab = currentTabName();

			if (tab === "Packs") {
				if (matchesKey(data, Key.up)) {
					packIndex = Math.max(0, packIndex - 1);
					state.packs = PACK_OPTIONS[packIndex];
					state.packsInput = String(state.packs);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					packIndex = Math.min(PACK_OPTIONS.length - 1, packIndex + 1);
					state.packs = PACK_OPTIONS[packIndex];
					state.packsInput = String(state.packs);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					// Move to next tab
					state.currentTab = 1;
					refresh();
					return;
				}
				// Type a custom number
				if (/^[0-9]$/.test(data)) {
					state.editingPacks = true;
					state.packsInput = data;
					refresh();
					return;
				}
			}

			if (tab === "Models") {
				const modelIds = Object.keys(state.models);
				if (matchesKey(data, Key.enter)) {
					// Move to next tab
					state.currentTab = 2;
					refresh();
					return;
				}
				// 'a' to add a model
				if (data === "a" || data === "A") {
					state.addingModel = true;
					state.newModelId = "";
					refresh();
					return;
				}
				// 'd' to delete last selected model (if more than 1)
				if ((data === "d" || data === "D") && modelIds.length > 1) {
					// Delete the last model in the list
					delete state.models[modelIds[modelIds.length - 1]];
					refresh();
					return;
				}
			}

			if (tab === "Budget") {
				if (matchesKey(data, Key.enter)) {
					state.currentTab = 3;
					refresh();
					return;
				}
				// Start editing
				state.editingBudget = true;
				state.budgetInput = String(state.weeklyBudget);
				refresh();
				return;
			}

			if (tab === "Confirm") {
				if (matchesKey(data, Key.enter)) {
					submit(true);
					return;
				}
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("toolTitle", theme.bold("  🤖 Synthetic Subagent Setup")));
			add("");

			// Tab bar
			const tabParts: string[] = ["  "];
			for (let i = 0; i < TAB_COUNT; i++) {
				const isActive = i === state.currentTab;
				const tabLabel = TABS[i];
				const styled = isActive
					? theme.bg("selectedBg", theme.fg("text", ` ${tabLabel} `))
					: theme.fg("muted", ` ${tabLabel} `);
				tabParts.push(styled);
				tabParts.push(" ");
			}
			add(tabParts.join(""));
			add(theme.fg("accent", "─".repeat(width)));

			const tab = currentTabName();

			// ── Packs Tab ──
			if (tab === "Packs") {
				add("");
				add(theme.fg("text", "  How many Synthetic packs do you have?"));
				add(theme.fg("muted", "  Each pack gives you 1 concurrency per standard model,"));
				add(theme.fg("muted", "  and 2 concurrency per small model (only GLM-4.7-Flash and Nemotron-3-Super)."));
				add("");

				for (let i = 0; i < PACK_OPTIONS.length; i++) {
					const p = PACK_OPTIONS[i];
					const selected = state.packs === p && !state.editingPacks;
					const prefix = selected ? theme.fg("accent", "  > ") : "    ";
					const color = selected ? "accent" : "text";
					const smallSlots = p * 2;
					const stdSlots = p;
					add(
						prefix +
							theme.fg(color, `${p} pack${p !== 1 ? "s" : ""}`) +
							theme.fg("dim", ` — ${smallSlots} small-model slots, ${stdSlots} standard slots`),
					);
				}

				if (state.editingPacks) {
					add("");
					add(theme.fg("accent", `  Custom: ${state.packsInput}▌`));
					add(theme.fg("dim", "  Enter to confirm • Esc to cancel"));
				} else {
					add("");
					add(theme.fg("dim", "  ↑↓ select • Enter next • Type number for custom • Esc cancel"));
				}
			}

			// ── Models Tab ──
			if (tab === "Models") {
				add("");
				add(theme.fg("text", "  Configure models for sub-agents:"));
				add(theme.fg("muted", "  These are the models available for scheduling."));
				add("");

				const modelIds = Object.keys(state.models);
				for (const modelId of modelIds) {
					const mc = state.models[modelId];
					const slots = computeSlots(state.packs, mc);
					add(
						theme.fg("accent", `  ● ${displayModel(modelId)}`) +
							theme.fg("dim", ` — ${slots} slot${slots !== 1 ? "s" : ""} • cost ${mc.cost} • ${mc.tier}${mc.isSmall ? " • small" : ""}`),
					);
				}

				if (state.addingModel) {
					add("");
					add(theme.fg("accent", "  Adding new model:"));
					add(theme.fg("text", `  ID: ${state.newModelId || "type model ID..."}▌`));
					add(
						theme.fg("muted", `  Slots: ${state.newModelSlots} • Cost: ${state.newModelCost} • Tier: ${state.newModelTier} • Small: ${state.newModelIsSmall}`),
					);
					add(theme.fg("dim", "  Tab=toggle tier • S=toggle small • Enter=add • Esc=cancel"));
				} else {
					add("");
					add(theme.fg("dim", "  A=add model • D=remove last • Enter=next • Esc=cancel"));
				}
			}

			// ── Budget Tab ──
			if (tab === "Budget") {
				add("");
				add(theme.fg("text", "  Set your weekly Synthetic budget (USD):"));
				add(theme.fg("muted", "  The extension will warn when sub-agent tasks approach this limit."));
				add("");

				if (state.editingBudget) {
					add(theme.fg("accent", `  $${state.budgetInput}▌`));
					add(theme.fg("dim", "  Enter to confirm • Esc to cancel"));
				} else {
					add(theme.fg("accent", `  $${state.weeklyBudget}`));
					add(theme.fg("dim", "  Type to edit • Enter=next • Esc=cancel"));
				}
			}

			// ── Confirm Tab ──
			if (tab === "Confirm") {
				add("");
				add(theme.fg("text", "  Review your configuration:"));
				add("");

				add(theme.fg("muted", `  Packs: ${state.packs}`));
				add(theme.fg("muted", `  Budget: $${state.weeklyBudget}/week`));
				add(theme.fg("muted", `  Default model: ${displayModel(state.defaultModel)}`));
				add("");

				add(theme.fg("muted", "  Model slots:"));
				const summary = formatSlotSummary(buildConfig());
				for (const line of summary.split("\n")) {
					add(theme.fg("dim", line));
				}

				add("");
				add(theme.fg("success", "  Press Enter to save configuration"));
				add(theme.fg("dim", "  ←→ navigate back • Esc=cancel"));
			}

			add("");
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result;
}
