/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */

export type NavigationType = 'spa' | 'mpa' | 'new-window' | 'close-window'

export interface NavigationEvent {
	type: NavigationType
	from: string
	to: string
	method?: string
	timestamp: number
}

export type NavigationCallback = (event: NavigationEvent) => void

interface WrappedFunction {
	target: any
	prop: string
	original: any
	wrapped: any
}

/**
 * **EXPERIMENTAL** Navigation detector that monitors browser navigation triggered by PageAgent actions.
 *
 * ⚠️ **Warning**: This feature uses runtime patching of browser APIs which may:
 * - Conflict with other libraries that patch the same APIs
 * - Have compatibility issues in certain browser environments
 * - Not detect all navigation patterns (e.g., delayed navigation via setTimeout)
 *
 * **Design principles:**
 * - Only detects navigations during PageAgent execution (when enabled)
 * - Safely wraps browser APIs without breaking existing user patches
 * - Emits type-safe events through EventBus for external handling
 *
 * **Detection coverage:**
 * - SPA navigation: `history.pushState`, `history.replaceState`, `popstate`
 * - MPA navigation: `location.assign/replace` (detected before navigation)
 * - New window: `window.open`
 * - Close/Unload: `beforeunload` (cannot distinguish between close tab vs navigation)
 *
 * **Safety guarantees:**
 * - Chain-wraps APIs to preserve existing user patches
 * - Cleanly restores original implementations on disable
 * - No memory leaks or orphaned listeners
 *
 * @experimental
 *
 * @example Basic Usage (Standalone)
 * ```typescript
 * import { NavigationDetector } from 'page-agent'
 *
 * const detector = new NavigationDetector((event) => {
 *   console.log(`Navigation detected: ${event.type}`)
 *   console.log(`From: ${event.from}`)
 *   console.log(`To: ${event.to}`)
 *   console.log(`Method: ${event.method}`)
 *
 *   if (event.type === 'mpa') {
 *     console.warn('Page will reload! Agent will be unloaded.')
 *   }
 * })
 *
 * // Enable detection only during agent execution
 * detector.enable()
 * // ... user actions that might trigger navigation ...
 * detector.disable()
 * ```
 *
 * @example Browser Extension Integration
 * ```typescript
 * import { PageAgent, NavigationDetector } from 'page-agent'
 *
 * const detector = new NavigationDetector((event) => {
 *   // Forward to extension background script
 *   chrome.runtime.sendMessage({
 *     type: `NAVIGATION_${event.type.toUpperCase()}`,
 *     data: event
 *   })
 * })
 *
 * const agent = new PageAgent()
 *
 * // Wrap agent execution with detection
 * async function executeWithDetection(task: string) {
 *   detector.enable()
 *   try {
 *     return await agent.execute(task)
 *   } finally {
 *     detector.disable()
 *   }
 * }
 * ```
 *
 * **Navigation Types**:
 * - `spa`: Single Page Application navigation (history API, popstate)
 *   - Page does NOT reload, agent continues running
 *   - Example: React Router, Vue Router navigation
 * - `mpa`: Multi Page Application navigation (location.assign/replace)
 *   - Page WILL reload, agent will be unloaded
 *   - Can detect target URL before navigation happens
 * - `new-window`: New window/tab opened (window.open)
 *   - Agent remains in current page
 * - `close-window`: Page unload detected (beforeunload)
 *   - Cannot distinguish: close tab, refresh, or navigation
 *   - Target URL is unknown (`to` field will be 'unknown')
 */
export class NavigationDetector {
	private enabled = false
	private callback?: NavigationCallback
	private currentUrl = location.href
	private lastClickPrediction: NavigationEvent | null = null

	// Stores wrapped functions for safe cleanup
	private wrappedFunctions = new Map<string, WrappedFunction>()

	// Event listeners for cleanup
	private boundHandlers = new Map<string, EventListener>()

	constructor(callback?: NavigationCallback) {
		this.callback = callback
	}

	/**
	 * Enable navigation detection.
	 * Wraps browser APIs and starts monitoring.
	 *
	 * @experimental
	 */
	enable() {
		if (this.enabled) return
		this.enabled = true
		this.currentUrl = location.href

		this.registerInstance()
		this.wrapHistoryAPIs()
		this.wrapLocationAPIs()
		this.wrapWindowOpen()
		this.setupEventListeners()
	}

	/**
	 * Disable navigation detection.
	 * Safely restores all wrapped APIs and removes listeners.
	 *
	 * @experimental
	 */
	disable() {
		if (!this.enabled) return
		this.enabled = false

		this.unwrapAll()
		this.removeEventListeners()
		this.unregisterInstance()
	}

	/**
	 * Predict navigation behavior by analyzing DOM element.
	 * Returns null if navigation cannot be predicted.
	 *
	 * ⚠️ **Limitations**:
	 * - Cannot detect if JavaScript will preventDefault()
	 * - Cannot distinguish SPA vs MPA for framework router links
	 * - Only analyzes static attributes (href, action, target, etc.)
	 *
	 * @experimental
	 */
	predictNavigation(element: Element | null): NavigationEvent | null {
		if (!element) return null

		const now = Date.now()
		const from = location.href

		// <a href="...">
		if (element.tagName === 'A') {
			const href = element.getAttribute('href')
			if (!href || href === '#' || href === '') return null

			// Filter out javascript: protocol and other non-navigation links
			if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
				return null
			}

			const target = element.getAttribute('target')
			if (target === '_blank') {
				return {
					type: 'new-window',
					from,
					to: this.resolveURL(href),
					method: 'click <a target="_blank">',
					timestamp: now,
				}
			}

			// Cannot reliably distinguish SPA vs MPA
			// Framework routers intercept <a> clicks via preventDefault()
			return {
				type: 'mpa', // Assume MPA unless intercepted
				from,
				to: this.resolveURL(href),
				method: 'click <a>',
				timestamp: now,
			}
		}

		// <form action="...">
		if (element.tagName === 'FORM') {
			const action = (element as HTMLFormElement).action
			const target = element.getAttribute('target')

			if (target === '_blank') {
				return {
					type: 'new-window',
					from,
					to: action || from,
					method: 'submit <form target="_blank">',
					timestamp: now,
				}
			}

			return {
				type: 'mpa',
				from,
				to: action || from,
				method: 'submit <form>',
				timestamp: now,
			}
		}

		// Check if inside a form
		const form = element.closest('form')
		if (form) {
			return this.predictNavigation(form)
		}

		// Cannot predict for buttons, divs, etc.
		return null
	}

	/**
	 * Safely wrap a function while preserving existing user patches.
	 * Uses chain-wrapping pattern to ensure compatibility.
	 */
	private wrapFunction(target: any, prop: string, wrapper: (original: any) => any) {
		const key = `${target.constructor?.name || 'Object'}.${prop}`

		// Skip if already wrapped
		if (this.wrappedFunctions.has(key)) return

		const original = target[prop]
		const bound = typeof original === 'function' ? original.bind(target) : original
		const wrapped = wrapper(bound)

		target[prop] = wrapped

		this.wrappedFunctions.set(key, {
			target,
			prop,
			original: bound,
			wrapped,
		})
	}

	/**
	 * Wrap history APIs to detect SPA navigation
	 */
	private wrapHistoryAPIs() {
		// Wrap pushState
		this.wrapFunction(
			history,
			'pushState',
			(original: (data: any, unused: string, url?: string | URL | null) => void) => {
				return (data: any, unused: string, url?: string | URL | null) => {
					if (this.enabled) {
						const urlStr = url?.toString() || ''
						this.emitNavigation('spa', { method: 'pushState', to: this.resolveURL(urlStr) })
					}
					return original(data, unused, url)
				}
			}
		)

		// Wrap replaceState
		this.wrapFunction(
			history,
			'replaceState',
			(original: (data: any, unused: string, url?: string | URL | null) => void) => {
				return (data: any, unused: string, url?: string | URL | null) => {
					if (this.enabled) {
						const urlStr = url?.toString() || ''
						this.emitNavigation('spa', { method: 'replaceState', to: this.resolveURL(urlStr) })
					}
					return original(data, unused, url)
				}
			}
		)
	}

	/**
	 * Wrap location APIs to detect MPA navigation
	 */
	private wrapLocationAPIs() {
		// Wrap location.href setter
		const hrefDescriptor = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href')
		if (hrefDescriptor?.set) {
			const originalSetter = hrefDescriptor.set.bind(window.Location.prototype)

			const wrappedSetter = function (this: Location, value: string) {
				const detector = NavigationDetector.getCurrentInstance()
				if (detector?.enabled && value !== detector.currentUrl) {
					detector.emitNavigation('mpa', {
						method: 'location.href',
						to: detector.resolveURL(value),
					})
				}
				return originalSetter.call(this, value)
			}

			Object.defineProperty(window.Location.prototype, 'href', {
				...hrefDescriptor,
				set: wrappedSetter,
			})

			this.wrappedFunctions.set('Location.href', {
				target: window.Location.prototype,
				prop: 'href',
				original: originalSetter,
				wrapped: wrappedSetter,
			})
		}

		// Wrap location.assign
		this.wrapFunction(
			window.Location.prototype,
			'assign',
			(original: (url: string | URL) => void) => {
				return function (this: Location, url: string | URL) {
					const detector = NavigationDetector.getCurrentInstance()
					if (detector?.enabled) {
						const urlStr = url.toString()
						detector.emitNavigation('mpa', {
							method: 'location.assign',
							to: detector.resolveURL(urlStr),
						})
					}
					return original.call(this, url)
				}
			}
		)

		// Wrap location.replace
		this.wrapFunction(
			window.Location.prototype,
			'replace',
			(original: (url: string | URL) => void) => {
				return function (this: Location, url: string | URL) {
					const detector = NavigationDetector.getCurrentInstance()
					if (detector?.enabled) {
						const urlStr = url.toString()
						detector.emitNavigation('mpa', {
							method: 'location.replace',
							to: detector.resolveURL(urlStr),
						})
					}
					return original.call(this, url)
				}
			}
		)
	}

	/**
	 * Wrap window.open to detect new window/tab
	 */
	private wrapWindowOpen() {
		this.wrapFunction(
			window,
			'open',
			(original: (url?: string | URL, target?: string, features?: string) => Window | null) => {
				return (url?: string | URL, target?: string, features?: string) => {
					if (this.enabled) {
						const urlStr = url?.toString() || ''
						this.emitNavigation('new-window', {
							method: 'window.open',
							to: this.resolveURL(urlStr),
						})
					}
					return original(url, target, features)
				}
			}
		)
	}

	/**
	 * Setup event listeners for popstate (browser back/forward) and click prediction
	 */
	private setupEventListeners() {
		const popstateHandler = () => {
			if (this.enabled) {
				const newUrl = location.href
				if (newUrl !== this.currentUrl) {
					this.emitNavigation('spa', {
						method: 'popstate',
						to: newUrl,
					})
				}
			}
		}

		const beforeUnloadHandler = () => {
			if (!this.enabled) return

			// If we have a prediction from recent click, use it
			if (this.lastClickPrediction) {
				this.callback?.(this.lastClickPrediction)
				this.lastClickPrediction = null
			} else {
				// Otherwise, we don't know where user is going
				this.emitNavigation('close-window', {
					method: 'beforeunload',
					to: 'unknown',
				})
			}
		}

		const clickHandler = (e: Event) => {
			if (!this.enabled) return

			const target = e.target as Element
			if (!target) return

			// Find closest link, button, or form
			const clickable = target.closest('a, button, form')
			if (!clickable) return

			const prediction = this.predictNavigation(clickable)
			if (prediction) {
				this.lastClickPrediction = prediction

				// Clear prediction after 100ms (enough time for beforeunload to fire)
				setTimeout(() => {
					this.lastClickPrediction = null
				}, 100)
			}
		}

		window.addEventListener('popstate', popstateHandler)
		window.addEventListener('beforeunload', beforeUnloadHandler)
		// Use capture phase to run before other handlers
		document.addEventListener('click', clickHandler, true)

		this.boundHandlers.set('popstate', popstateHandler)
		this.boundHandlers.set('beforeunload', beforeUnloadHandler)
		this.boundHandlers.set('click', clickHandler)
	}

	/**
	 * Remove all event listeners
	 */
	private removeEventListeners() {
		for (const [event, handler] of this.boundHandlers) {
			if (event === 'click') {
				document.removeEventListener(event, handler, true)
			} else {
				window.removeEventListener(event, handler)
			}
		}
		this.boundHandlers.clear()
		this.lastClickPrediction = null
	}

	/**
	 * Safely unwrap all patched APIs
	 */
	private unwrapAll() {
		for (const { target, prop, wrapped, original } of this.wrappedFunctions.values()) {
			// Only restore if our wrapper is still active
			if (target[prop] === wrapped) {
				if (prop === 'href' && target === window.Location.prototype) {
					// Restore property descriptor
					const descriptor = Object.getOwnPropertyDescriptor(target, prop)
					if (descriptor) {
						Object.defineProperty(target, prop, {
							...descriptor,
							set: original,
						})
					}
				} else {
					target[prop] = original
				}
			}
		}
		this.wrappedFunctions.clear()
	}

	/**
	 * Emit navigation event through callback
	 */
	private emitNavigation(type: NavigationType, details: { method: string; to: string }) {
		if (!this.callback) return

		const event: NavigationEvent = {
			type,
			from: this.currentUrl,
			to: details.to,
			method: details.method,
			timestamp: Date.now(),
		}

		this.callback(event)

		// Update current URL for SPA navigation
		if (type === 'spa') {
			this.currentUrl = details.to
		}
	}

	/**
	 * Resolve relative URLs to absolute URLs
	 */
	private resolveURL(url: string): string {
		if (!url) return location.href

		try {
			return new URL(url, location.href).href
		} catch {
			return url
		}
	}

	// ===== Static instance management =====
	// Used for location.href setter which doesn't have access to instance context

	private static currentInstance: NavigationDetector | null = null

	private static getCurrentInstance(): NavigationDetector | null {
		return NavigationDetector.currentInstance
	}

	/**
	 * Register this instance as the current active detector
	 */
	private registerInstance() {
		NavigationDetector.currentInstance = this
	}

	/**
	 * Unregister this instance
	 */
	private unregisterInstance() {
		if (NavigationDetector.currentInstance === this) {
			NavigationDetector.currentInstance = null
		}
	}
}
