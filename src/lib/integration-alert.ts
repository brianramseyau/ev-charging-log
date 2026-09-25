// What an integration needs to surface outside its own settings card when it
// stops working (BYD-INTEGRATION-PLAN.md §7.3). Generic — a kind, a message and a
// link — so the banner, nav dot and error-state buttons can serve any integration.
// Kept outside $lib/server so components can import it.

export interface IntegrationAlert {
	/** `broken`: calls are paused until fixed. `unreachable`: an escalated transient failure. */
	kind: 'broken' | 'unreachable';
	status: string;
	/** The banner's text. For `unreachable`, the page appends the `since` date. */
	message: string;
	/** For `unreachable`: the last successful read, formatted by the browser. */
	since: string | null;
	href: '/settings';
}
