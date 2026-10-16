"use strict";
/**
 * The React bridge.
 *
 * DSH's slot API hands a component to React; this panel is plain DOM. Rather
 * than reimplement 700 lines of panel in JSX — which would immediately become
 * two implementations to keep in sync, and would need a build step — the bridge
 * wraps the DOM panel in a fifteen-line component and lets React own nothing
 * but the container element.
 *
 * This is a legitimate pattern, not a workaround: React is being used to place
 * a node, not to own a subtree. The panel has no state React needs to know
 * about, and every value it displays already flows from the store's own
 * subscription.
 *
 * `createElement` rather than JSX so the package ships with no bundler
 * requirement for the plugin's own source — the only tooling is the module
 * concatenation in `scripts/build.cjs`.
 */

/**
 * Wrap a panel factory into a React component.
 *
 * @param {object} React the host's React (18.x)
 * @param {() => ({el: Node, destroy: () => void})} createPanelInstance
 * @returns {(props: object) => object} a function component
 */
function createReactPanel(React, createPanelInstance) {
	return function LumenPanelHost() {
		const ref = React.useRef(null);
		React.useEffect(() => {
			const panel = createPanelInstance();
			const node = ref.current;
			if (node === null || node === undefined) {
				panel.destroy();
				return undefined;
			}
			node.appendChild(panel.el);
			return () => {
				panel.destroy();
				// React owns `node` only until the effect cleanup runs; removing the
				// panel's child explicitly means a re-mount cannot leave two panels
				// stacked in the same slot.
				if (panel.el.parentNode === node) node.removeChild(panel.el);
			};
		}, []);
		return React.createElement("div", { ref, className: "lumen-root" });
	};
}

/**
 * The settings *section* wrapper. The host renders a section as a container
 * whose body is whatever its declared child slots produce, so this simply
 * delegates. The host renders a declared section by handing it a `renderSlot`
 * function; a section that rendered its own markup instead would fight the
 * shell's own layout.
 */
function createReactSection(React, slotName) {
	return function LumenSection(props) {
		const renderSlot = props && typeof props.renderSlot === "function" ? props.renderSlot : null;
		if (renderSlot === null) return React.createElement("div", { className: "lumen-root" });
		return React.createElement("div", { className: "lumen-root" }, renderSlot(slotName, {}));
	};
}

module.exports = { createReactPanel, createReactSection };
