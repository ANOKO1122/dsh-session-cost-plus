window.__ModuleLoader__.load({
	id: "dsh-session-cost-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ------------------------------------------------------------------
		// DeepSeek API pricing, CNY per 1M tokens
		// Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
		// Current official v4 pricing is peak/off-peak (Beijing time).
		// ------------------------------------------------------------------

		/** 当前官方峰谷价（deepseek-v4-flash / deepseek-v4-pro）。 */
		const TIERED_PRICES = {
			"deepseek-v4-flash": {
				peak: { hit: 0.1, miss: 3, out: 9 },
				off: { hit: 0.05, miss: 1.5, out: 4.5 }
			},
			"deepseek-v4-pro": {
				peak: { hit: 0.3, miss: 9, out: 27 },
				off: { hit: 0.15, miss: 4.5, out: 13.5 }
			}
		};

		/** 旧版平峰价，用于 deepseek-chat / deepseek-reasoner（如仍在使用）。 */
		const FLAT_PRICES = {
			"deepseek-chat": { hit: 0.5, miss: 2, out: 8 },
			"deepseek-reasoner": { hit: 1, miss: 4, out: 16 }
		};

		/** 模型未识别时的兜底模型（DSH 默认模型）。 */
		const DEFAULT_MODEL = "deepseek-v4-flash";

		/** 高峰时段：北京时间 9:00-12:00、14:00-18:00。 */
		function isPeakBeijing(now) {
			const bj = new Date(now.getTime() + 8 * 3600e3);
			const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
			return (t >= 9 && t < 12) || (t >= 14 && t < 18);
		}

		/** 规整模型 id 以便查价格表。 */
		function normalizeModel(model) {
			if (typeof model !== "string") return "";
			return model.trim().toLowerCase();
		}

		/** 按模型 id 取价格；未识别时使用 flash 当前官方价。 */
		function lookupPrice(model) {
			const key = normalizeModel(model);
			if (key.includes("v4-pro") || key.includes("pro")) return { model: "deepseek-v4-pro", kind: "tiered" };
			if (key.includes("v4-flash") || key.includes("flash")) return { model: "deepseek-v4-flash", kind: "tiered" };
			if (key === "deepseek-chat" || key.includes("deepseek-chat")) return { model: "deepseek-chat", kind: "flat" };
			if (key === "deepseek-reasoner" || key.includes("deepseek-reasoner")) return { model: "deepseek-reasoner", kind: "flat" };
			return { model: DEFAULT_MODEL, kind: "tiered" };
		}

		/**
		 * 计算一次估算费用（元）。
		 * 计费口径：缓存写入按「未命中」单价计；结果 = (未命中 + 写入) × miss + 命中 × hit + 输出 × out。
		 * @param usage - tokenUsage 投影（uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）。
		 * @param model - 模型 id；缺省用 flash。
		 * @param now - 可注入时间（测试用）。
		 * @returns {total, hit, miss, out} 各部分费用（元）。
		 */
		function computeCost(usage, model, now) {
			const resolved = lookupPrice(model || DEFAULT_MODEL);
			let price;
			if (resolved.kind === "flat") {
				price = FLAT_PRICES[resolved.model];
			} else {
				const current = now || new Date();
				price = TIERED_PRICES[resolved.model][isPeakBeijing(current) ? "peak" : "off"];
			}
			const hit = (usage.cacheReadTokens || 0) * price.hit;
			const miss = ((usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0)) * price.miss;
			const out = (usage.outputTokens || 0) * price.out;
			return {
				total: (hit + miss + out) / 1e6,
				hit: hit / 1e6,
				miss: miss / 1e6,
				out: out / 1e6
			};
		}

		/** 会话还没有任何计费 token 时返回 null（投影缺失或全零）。 */
		function billedTotal(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const sum = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
			return sum > 0 ? sum : null;
		}

		/** 缓存命中率文本：两位小数，如 "87.35%"。无计费输入时返回 null。 */
		function computeCacheHitText(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const denom = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
			if (denom <= 0) return null;
			const rate = (usage.cacheReadTokens || 0) / denom * 100;
			return `${rate.toFixed(2)}%`;
		}

		/** 从会话快照里取最近一次 assistant 节点的模型 id。 */
		function latestModel(snapshot) {
			if (!snapshot) return null;
			const nodes = snapshot.nodes
				|| (snapshot.chat && snapshot.chat.legacy && snapshot.chat.legacy.nodes)
				|| [];
			for (let i = nodes.length - 1; i >= 0; i--) {
				const node = nodes[i];
				if (node && node.kind === "assistant") {
					const model = (node.requestConfig && node.requestConfig.model)
						|| (node.provenance && node.provenance.model);
					if (model) return model;
				}
			}
			return null;
		}

		// ------------------------------------------------------------------
		// 官方统计条 DOM 修补：缓存命中两位小数 + 不截断
		// ------------------------------------------------------------------

		/** 最近一次由组件算出的缓存命中文本。 */
		let lastCacheHitText = "";

		/** 找到包含官方统计条的 composer 根区域（从输入框向上找，避免误伤聊天消息）。 */
		function getComposerRoot() {
			const textarea = document.querySelector("textarea");
			if (!textarea) return null;
			let el = textarea.parentElement;
			while (el && el !== document.body) {
				const text = el.textContent || "";
				if ((text.includes("缓存命中") || text.includes("Cache hit"))
					&& (text.includes("tok/s") || text.includes("输入") || text.includes("输出"))) {
					return el;
				}
				el = el.parentElement;
			}
			return null;
		}

		/** 在 composer 根区域内找到带省略号/nowrap 的官方统计条容器。 */
		function findStatsLine(root) {
			if (!root) return null;
			const candidates = [root];
			for (let i = 0; i < root.children.length; i++) {
				const child = root.children[i];
				if (child.querySelectorAll) {
					candidates.push(...Array.from(child.querySelectorAll("*")));
				}
			}
			for (const el of candidates) {
				const text = el.textContent || "";
				if (!(text.includes("缓存命中") || text.includes("Cache hit"))) continue;
				if (text.length >= 500) continue;
				let style = null;
				try {
					style = window.getComputedStyle(el);
				} catch {
					style = null;
				}
				if (style !== null && (style.textOverflow === "ellipsis" || style.whiteSpace === "nowrap")) {
					return el;
				}
			}
			return null;
		}

		/** 让官方统计条单行完整显示：nowrap、不截断、不省略。 */
		function patchStatsLine() {
			const root = getComposerRoot();
			const line = findStatsLine(root);
			if (!line) return;
			line.style.whiteSpace = "nowrap";
			line.style.overflow = "visible";
			line.style.textOverflow = "clip";
		}

		/** 把官方缓存命中百分比替换成两位小数（如 87% → 87.35%），只改 composer 区域内。 */
		function patchCacheHit() {
			const text = lastCacheHitText;
			if (!text || typeof NodeFilter === "undefined") return;
			const root = getComposerRoot();
			if (!root) return;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node) {
				const original = node.textContent || "";
				const match = original.match(/^(缓存命中|Cache hit)\s+(\d+(?:\.\d+)?%)$/);
				if (match) {
					const desired = `${match[1]} ${text}`;
					if (original !== desired) node.textContent = desired;
					return;
				}
				node = walker.nextNode();
			}
		}

		/** 触发一次统计条修补（组件更新后调用）。 */
		function scheduleStatsPatch() {
			startStatsPatcher();
			if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
				window.requestAnimationFrame(() => {
					patchStatsLine();
					patchCacheHit();
				});
			}
		}

		/** 在 apply/组件中启动 MutationObserver，React 重渲染后自动重新修补。 */
		let patcherStarted = false;
		function startStatsPatcher() {
			if (patcherStarted || typeof MutationObserver === "undefined") return;
			if (!document.body) {
				if (document.readyState === "loading" && document.addEventListener) {
					document.addEventListener("DOMContentLoaded", startStatsPatcher, { once: true });
				} else {
					setTimeout(startStatsPatcher, 100);
				}
				return;
			}
			patcherStarted = true;
			const apply = () => {
				patchStatsLine();
				patchCacheHit();
			};
			const observer = new MutationObserver(() => {
				window.requestAnimationFrame(apply);
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			window.requestAnimationFrame(apply);
		}

		// ------------------------------------------------------------------
		// Host API：按会话日志逐条计价（能正确拆分峰谷前后）
		// ------------------------------------------------------------------

		/** 拉取当前会话的精确费用汇总；失败或尚未就绪时返回 null。 */
		async function fetchSessionCost(sessionId) {
			if (!sessionId) return null;
			try {
				const response = await fetch(`/api/dsh-session-cost-plus/session/${encodeURIComponent(sessionId)}`, {
					headers: { accept: "application/json" }
				});
				if (!response.ok) return null;
				const data = await response.json();
				return data && data.ok ? data : null;
			} catch {
				return null;
			}
		}

		// ------------------------------------------------------------------
		// 组件 + 注册
		// ------------------------------------------------------------------

		/** 中文文案。 */
		const zh = {
			"label": "费用 ≈¥{amount}",
			"hit": "命中 ¥{amount}",
			"miss": "未命中 ¥{amount}",
			"out": "输出 ¥{amount}",
			"loading": "费用计算中…"
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"label": "Cost ≈¥{amount}",
			"hit": "hit ¥{amount}",
			"miss": "miss ¥{amount}",
			"out": "output ¥{amount}",
			"loading": "Calculating cost…"
		};

		/**
		 * 统计条（conversation.composer.dock）里的费用行。
		 * 显示总额 + 命中 / 未命中 / 输出三项明细，样式对齐官方统计条。
		 * 与官方行不同：white-space 允许换行、overflow 可见，不截断。
		 * 费用来自 host API（逐条按记录时间计价），而不是用当前时刻估算整段会话。
		 */
		function CostLine(props) {
			const useProjection = props.useProjection;
			const t = props.t;
			const usage = useProjection("tokenUsage");
			const cacheText = computeCacheHitText(usage);
			const [serverCost, setServerCost] = react.useState(null);

			lastCacheHitText = cacheText || "";
			react.useEffect(() => {
				scheduleStatsPatch();
			}, [cacheText]);

			react.useEffect(() => {
				let alive = true;
				let timer = null;
				const load = async () => {
					const data = await fetchSessionCost(props.sessionId);
					if (alive && data) setServerCost(data);
				};
				load();
				timer = setInterval(load, 5000);
				return () => {
					alive = false;
					if (timer !== null) clearInterval(timer);
				};
			}, [props.sessionId]);

			const billed = billedTotal(usage);
			if (billed === null) return null;

			const parts = serverCost && serverCost.total > 0 ? serverCost : null;
			const fmt = n => n.toFixed(2);
			const groups = parts
				? [
					t("label", { amount: fmt(parts.total) }),
					t("hit", { amount: fmt(parts.hit) }),
					t("miss", { amount: fmt(parts.miss) }),
					t("out", { amount: fmt(parts.out) })
				]
				: [t("loading")];
			const sep = react_jsx_runtime.jsx("span", {
				style: { color: "var(--dsw-alias-separator-primary)", margin: "0 10px" },
				"aria-hidden": true,
				children: "|"
			});
			return react_jsx_runtime.jsx("div", {
				style: {
					textAlign: "center",
					boxSizing: "border-box",
					color: "var(--dsw-alias-label-tertiary)",
					whiteSpace: "nowrap",
					overflow: "visible",
					textOverflow: "clip",
					wordBreak: "break-word",
					fontSize: 12,
					lineHeight: "20px",
					padding: "2px calc(var(--dsh-composer-side-clearance) + 16px) 0"
				},
				children: groups.map((group, i) => react_jsx_runtime.jsxs(react.Fragment, {
					children: [
						i > 0 && react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
							children: [sep, " "]
						}),
						react_jsx_runtime.jsx("span", { children: group })
					]
				}, group))
			});
		}

		/** Required services: the slot registry and the locale seat. */
		const inject = ["slots", "locale"];

		/** Client plugin body: register dictionaries and the dock entry. */
		function apply(ctx) {
			startStatsPatcher();
			ctx.effect(() => ctx.locale.register("session-cost-plus", { zh, en }), "session-cost-plus: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost-plus",
				order: 100,
				locale: "session-cost-plus"
			}, CostLine));
		}

		/** 测试钩子。 */
		const internals = {
			TIERED_PRICES,
			FLAT_PRICES,
			DEFAULT_MODEL,
			computeCost,
			isPeakBeijing,
			billedTotal,
			computeCacheHitText,
			latestModel,
			normalizeModel,
			lookupPrice
		};

		exports.apply = apply;
		exports.inject = inject;
		exports.internals = internals;
		return module.exports;
	}
});
