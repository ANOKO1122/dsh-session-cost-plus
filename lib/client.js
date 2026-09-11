window.__ModuleLoader__.load({
	id: "dsh-session-cost-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

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

		/** Coalesce repeated observer notifications into one animation-frame patch. */
		function createFrameScheduler(requestFrame, cancelFrame, applyPatch) {
			let frameId = null;
			return {
				schedule() {
					if (frameId !== null) return;
					frameId = requestFrame(() => {
						frameId = null;
						applyPatch();
					});
				},
				dispose() {
					if (frameId === null) return;
					cancelFrame(frameId);
					frameId = null;
				}
			};
		}

		const statsFrameScheduler = typeof window !== "undefined"
			&& typeof window.requestAnimationFrame === "function"
			? createFrameScheduler(
				callback => window.requestAnimationFrame(callback),
				id => window.cancelAnimationFrame(id),
				() => {
					patchStatsLine();
					patchCacheHit();
				}
			)
			: null;

		/** Trigger one deduplicated stats-line patch. */
		function scheduleStatsPatch() {
			statsFrameScheduler?.schedule();
		}

		/**
		 * Keep a light discovery observer for composer replacement, while detailed
		 * text observation stays scoped to the much smaller composer tree.
		 */
		function startStatsPatcher() {
			if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
			let discoveryObserver = null;
			let composerObserver = null;
			let observedRoot = null;
			let disposed = false;

			const bindComposer = () => {
				if (disposed) return;
				const nextRoot = getComposerRoot();
				if (nextRoot === observedRoot) return;
				composerObserver?.disconnect();
				composerObserver = null;
				observedRoot = nextRoot;
				if (nextRoot !== null) {
					composerObserver = new MutationObserver(scheduleStatsPatch);
					composerObserver.observe(nextRoot, {
						childList: true,
						subtree: true,
						characterData: true
					});
				}
				scheduleStatsPatch();
			};

			const start = () => {
				if (disposed || !document.body) return;
				discoveryObserver = new MutationObserver(bindComposer);
				discoveryObserver.observe(document.body, { childList: true, subtree: true });
				bindComposer();
			};

			if (document.body) {
				start();
			} else {
				document.addEventListener("DOMContentLoaded", start, { once: true });
			}

			return () => {
				disposed = true;
				document.removeEventListener("DOMContentLoaded", start);
				discoveryObserver?.disconnect();
				composerObserver?.disconnect();
				statsFrameScheduler?.dispose();
			};
		}

		// ------------------------------------------------------------------
		// Host API：按会话日志逐条计价（能正确拆分峰谷前后）
		// ------------------------------------------------------------------

		/** 拉取当前会话的精确费用汇总；失败或尚未就绪时返回 null。 */
		async function fetchSessionCost(sessionId, signal) {
			if (!sessionId) return null;
			try {
				const response = await fetch(`/api/dsh-session-cost-plus/session/${encodeURIComponent(sessionId)}`, {
					headers: { accept: "application/json" },
					signal
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

			const billed = billedTotal(usage);
			const usageRevision = usage === null || usage === undefined
				? ""
				: [
					usage.uncachedInputTokens || 0,
					usage.cacheReadTokens || 0,
					usage.cacheWriteTokens || 0,
					usage.outputTokens || 0
				].join(":");

			react.useEffect(() => {
				setServerCost(null);
				if (billed === null) return undefined;

				let alive = true;
				let retryTimer = null;
				let retryIndex = 0;
				const retryDelays = [500, 1000, 2000];
				const controller = new AbortController();
				const load = async () => {
					const data = await fetchSessionCost(props.sessionId, controller.signal);
					if (!alive) return;
					if (data) {
						setServerCost(data);
					}
					const delay = retryDelays[retryIndex++];
					if (delay !== undefined) retryTimer = setTimeout(load, delay);
				};
				void load();
				const interval = setInterval(load, 30000);
				return () => {
					clearInterval(interval);
					alive = false;
					controller.abort();
					if (retryTimer !== null) clearTimeout(retryTimer);
				};
			}, [props.sessionId, usageRevision]);


			const parts = serverCost;
			const fmt = n => n.toFixed(6);
			const groups = parts
				? [
					t("label", { amount: fmt(parts.total) }),
					t("hit", { amount: fmt(parts.hit) }),
					t("miss", { amount: fmt(parts.miss) }),
					t("out", { amount: fmt(parts.out) })
				]
				: [billed === null ? "会话费用 ¥0.000000" : "费用暂不可用，等待日志刷新"];
			if (parts?.unpricedRecords > 0) groups.push(`另有 ${parts.unpricedRecords} 条未计价（模型或历史价格未确认）`);
			if (parts?.uncertainRecords > 0) groups.push(`${parts.uncertainRecords} 条历史记录沿用旧价估算，切换时间未确认`);
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
					whiteSpace: "normal",
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


		/** Account-wide balance for the configured official DeepSeek credential. */
		function BalanceLine() {
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [revision, refresh] = react.useState(0);
			react.useEffect(() => {
				let alive = true, loading = false;
				const controller = new AbortController();
				const load = async () => {
					if (loading || document.visibilityState === "hidden") return;
					loading = true; setBusy(true);
					try {
						const res = await fetch("/api/dsh-session-cost-plus/balance", { signal: controller.signal, cache: "no-store" });
						const data = await res.json();
						if (!res.ok || !data.ok) throw new Error(data.error || "余额查询失败");
						if (alive) { setState(data); setError(""); }
					} catch (cause) {
						if (alive) setError(cause instanceof Error ? cause.message : "余额查询失败");
					} finally { loading = false; if (alive) setBusy(false); }
				};
				void load();
				const timer = setInterval(load, 30000);
				document.addEventListener("visibilitychange", load);
				return () => { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
			}, [revision]);
			const text = state
				? state.balances.map(b => `官方账户余额 ${b.currency} ${b.total_balance}（充值 ${b.topped_up_balance} / 赠送 ${b.granted_balance}）`).join(" · ")
				: "官方账户余额：查询中…";
			return react_jsx_runtime.jsxs("div", {
				style: { textAlign: "center", fontSize: 12, lineHeight: "22px", padding: "2px 16px", whiteSpace: "normal" },
				title: "当前官方 DeepSeek API Key 所属账户余额，不是本会话余额或剩余 token 数；每30秒刷新，服务端最多缓存15秒",
				children: [
					react_jsx_runtime.jsx("span", { children: state || !error ? text : "官方账户余额：不可用" }),
					state && react_jsx_runtime.jsx("span", { children: ` · ${new Date(state.updatedAt).toLocaleTimeString()} 更新${!state.isAvailable ? " · 账户不可用" : ""}` }),
					error && react_jsx_runtime.jsx("span", { role: "status", children: ` · ${state ? "旧数据，刷新失败：" : ""}${error}` }),
					react_jsx_runtime.jsx("button", { type: "button", disabled: busy, onClick: () => refresh(n => n + 1), style: { marginLeft: 8 }, children: busy ? "刷新中…" : "刷新余额" }),
				],
			});
		}
		function CostDock(props) {
			return react_jsx_runtime.jsxs(react.Fragment, { children: [
				react_jsx_runtime.jsx(CostLine, props),
				react_jsx_runtime.jsx(BalanceLine, {}),
			] });
		}

		/** Required services: the slot registry and the locale seat. */
		const inject = ["slots", "locale"];

		/** Client plugin body: register dictionaries and the dock entry. */
		function apply(ctx) {
			ctx.effect(() => startStatsPatcher(), "session-cost-plus: stats patcher");
			ctx.effect(() => ctx.locale.register("session-cost-plus", { zh, en }), "session-cost-plus: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost-plus",
				order: 100,
				locale: "session-cost-plus"
			}, CostDock));
		}

		/** 测试钩子。 */
		const internals = {
			billedTotal,
			computeCacheHitText,
			createFrameScheduler
		};

		exports.apply = apply;
		exports.inject = inject;
		exports.internals = internals;
		return module.exports;
	}
});
