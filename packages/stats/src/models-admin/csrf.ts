const LOOPBACK_HOSTS: Record<string, true> = {
	"127.0.0.1": true,
	localhost: true,
	"::1": true,
	"[::1]": true,
};

/** Same-origin dashboard fetch, or no Origin (curl / unit tests). Reject CSRF POSTs. */
export function allowDashboardMutation(req: Request): boolean {
	const site = req.headers.get("sec-fetch-site");
	if (site === "cross-site" || site === "same-site") return false;
	const origin = req.headers.get("origin");
	if (!origin) return true;
	try {
		return Boolean(LOOPBACK_HOSTS[new URL(origin).hostname]);
	} catch {
		return false;
	}
}
